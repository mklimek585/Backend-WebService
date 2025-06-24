const express = require('express');
const cors = require('cors');
const aedes = require('aedes')();
const { createServer } = require('http');
const WebSocket = require('ws');
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();

// Logowanie wartości API_KEY (tylko pierwsze 4 znaki dla bezpieczeństwa)
console.log('API_KEY value:', process.env.API_KEY ? process.env.API_KEY.substring(0, 4) + '...' : 'not set');

// Konfiguracja CORS
const corsOptions = {
    origin: '*',  // Akceptuj requesty z dowolnego źródła
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    credentials: true,
    maxAge: 86400
};

// Middleware do sprawdzania API key
const apiKeyAuth = (req, res, next) => {
    // Pomiń sprawdzanie API key dla zapytań OPTIONS
    if (req.method === 'OPTIONS') {
        return next();
    }

    const apiKey = req.headers['x-api-key'];
    console.log('Received API key:', apiKey ? apiKey.substring(0, 4) + '...' : 'not provided');
    console.log('Expected API key:', process.env.API_KEY ? process.env.API_KEY.substring(0, 4) + '...' : 'not set');
    
    if (!apiKey || apiKey !== process.env.API_KEY) {
        console.log('Unauthorized access attempt - API key mismatch or missing');
        return res.status(401).json({ 
            error: 'Unauthorized',
            message: 'Invalid or missing API key'
        });
    }
    console.log('API key validation successful');
    next();
};

console.log('Starting server initialization...');

// Kolejność middleware jest ważna!
app.use(cors(corsOptions));
app.use(express.json());

console.log('Middleware configured');

// Inicjalizacja bazy SQLite w katalogu projektu
const db = new Database(path.join(__dirname, '../local_measurements.db'));

// --- Ulepszona Migracja Bazy Danych z opcją czyszczenia danych ---
const dbMigration = () => {
    console.log('[DB] Rozpoczynam weryfikację i migrację schematu bazy danych...');
    try {
        const tableInfo = db.pragma('table_info(measurement_batches)');
        const tableExists = tableInfo.length > 0;
        let needsRecreation = false;

        if (tableExists) {
            const columnNames = tableInfo.map(col => col.name);
            // Kluczowy warunek: jeśli brakuje packet_uuid, schemat jest niekompatybilny.
            if (!columnNames.includes('packet_uuid')) {
                needsRecreation = true;
                console.warn('[DB] Wykryto stary, niekompatybilny schemat (brak kolumny "packet_uuid").');
                console.warn('[DB] Zgodnie z decyzją, stara tabela i jej dane zostaną usunięte.');
            }
        }

        // Jeśli tabela jest niekompatybilna, usuwamy ją.
        if (needsRecreation) {
            db.exec('DROP TABLE measurement_batches');
            console.log('[DB] ✔ Stara tabela "measurement_batches" została usunięta.');
        }

        // Tworzymy tabelę, jeśli nie istniała lub została właśnie usunięta.
        if (needsRecreation || !tableExists) {
            console.log('[DB] Tworzenie tabeli "measurement_batches" z nowym, poprawnym schematem...');
            db.exec(`CREATE TABLE measurement_batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                island_id TEXT NOT NULL,
                packet_timestamp INTEGER NOT NULL,
                measurements_json TEXT NOT NULL,
                protocol TEXT,
                received_at INTEGER,
                packet_uuid TEXT UNIQUE,
                created_at TEXT,
                is_synced INTEGER DEFAULT 0,
                sync_timestamp TEXT
            )`);
            console.log('[DB] ✔ Tabela "measurement_batches" została utworzona pomyślnie.');
        } else {
            // Jeśli tabela już istnieje i jest kompatybilna, możemy w przyszłości dodawać tu kolejne kolumny.
            console.log('[DB] Tabela "measurement_batches" jest już w aktualnym schemacie.');
             const finalColumns = db.pragma('table_info(measurement_batches)').map(c => c.name);
                if (!finalColumns.includes('created_at')) {
                    db.exec('ALTER TABLE measurement_batches ADD COLUMN created_at TEXT');
                    console.log('[DB] ✔ Dodano brakującą kolumnę "created_at".');
                }
                if (!finalColumns.includes('is_synced')) {
                    db.exec('ALTER TABLE measurement_batches ADD COLUMN is_synced INTEGER DEFAULT 0');
                    console.log('[DB] ✔ Dodano brakującą kolumnę "is_synced".');
                }
                if (!finalColumns.includes('sync_timestamp')) {
                    db.exec('ALTER TABLE measurement_batches ADD COLUMN sync_timestamp TEXT');
                    console.log('[DB] ✔ Dodano brakującą kolumnę "sync_timestamp".');
                }
        }
        
        console.log('[DB] Weryfikacja schematu zakończona pomyślnie.');
        console.log('[DB] Finalny schemat tabeli:', db.pragma('table_info(measurement_batches)'));

    } catch (error) {
        console.error('[DB] [BŁĄD KRYTYCZNY] Migracja bazy danych nie powiodła się:', error);
        process.exit(1);
    }
};

// Uruchom migrację przy starcie aplikacji
dbMigration();

// === GŁÓWNA LOGIKA ZAPISU ===

function insertSinglePacket(packet, protocol) {
    console.log(`[DB] Próba zapisu pakietu ${packet.packet_uuid} przez ${protocol}`);
    
    // Walidacja podstawowych pól pakietu
    if (!packet.packet_uuid || !packet.island_id || !packet.timestamp || !packet.measurements) {
        console.error(`[DB] Błąd walidacji: Pakiet z ${protocol} nie ma wszystkich wymaganych pól.`, packet);
        throw new Error('Invalid packet structure');
    }

    const insertStmt = db.prepare(
        `INSERT INTO measurement_batches (
            packet_uuid, island_id, packet_timestamp, measurements_json, 
            created_at, is_synced, protocol, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    try {
        const result = insertStmt.run(
            packet.packet_uuid,
            packet.island_id,
            packet.timestamp, // Pole 'timestamp' z pakietu
            JSON.stringify(packet.measurements), // Pole 'measurements' jest parsowane na JSON
            new Date().toISOString(), // Używamy aktualnej daty jako 'created_at'
            0,
            protocol,
            Date.now()
        );
        if (result.changes > 0) {
            console.log(`[DB] ✔ Pakiet ${packet.packet_uuid} pomyślnie zapisany.`);
            return { inserted: true, ignored: false };
        }
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            console.log(`[DB] Duplikat pakietu ${packet.packet_uuid} zignorowany.`);
            return { inserted: false, ignored: true };
        }
        // Dla innych błędów, rzucamy dalej, aby można je było obsłużyć na poziomie endpointu
        console.error(`[DB] Krytyczny błąd zapisu dla pakietu ${packet.packet_uuid}:`, err);
        throw err;
    }
}

const LOCAL_DB_LIMIT = 1000;

function getBatchCount() {
    return db.prepare('SELECT COUNT(*) as count FROM measurement_batches').get().count;
}

function clearBatches() {
    db.prepare('DELETE FROM measurement_batches').run();
}

function getAllBatches() {
    return db.prepare('SELECT * FROM measurement_batches').all();
}

function getLatestMeasurements() {
    // Pobierz najnowsze paczki dla każdej wyspy, ignorując te z nieprawidłowym timestampem
    const latestBatches = db.prepare(`
        SELECT mb.* FROM measurement_batches mb
        INNER JOIN (
            SELECT 
                island_id, 
                MAX(packet_timestamp) as max_timestamp
            FROM measurement_batches
            WHERE packet_timestamp > 0  -- KLUCZOWA POPRAWKA: Ignoruj błędne wpisy
            GROUP BY island_id
        ) latest ON mb.island_id = latest.island_id AND mb.packet_timestamp = latest.max_timestamp
        ORDER BY mb.packet_timestamp DESC
    `).all();
    
    // Jeśli nie ma najnowszych paczek, weź po prostu ostatnie dostępne
    if (latestBatches.length === 0) {
        const fallbackBatches = db.prepare(`
            SELECT * FROM measurement_batches 
            ORDER BY packet_timestamp DESC 
            LIMIT 10
        `).all();
        
        if (fallbackBatches.length === 0) {
            console.log('[API] Brak danych w bazie - zwracam pustą tablicę');
            return [];
        }
        
        console.log(`[API] Używam fallback - ostatnie ${fallbackBatches.length} paczek`);
        latestBatches.push(...fallbackBatches);
    }
    
    // Rozpakuj measurements z paczek
    const latestMeasurements = [];
    for (const batch of latestBatches) {
        const measurements = JSON.parse(batch.measurements_json);
        for (const m of measurements) {
            latestMeasurements.push({
                island_id: batch.island_id,
                sensor_id: m.sensor_id,
                value: m.value,
                timestamp: batch.packet_timestamp,
                protocol: batch.protocol,
            });
        }
    }
    
    console.log(`[API] Zwracam ${latestMeasurements.length} pomiarów z ${latestBatches.length} paczek`);
    return latestMeasurements;
}

function autoClearIfLimit() {
    if (getBatchCount() >= LOCAL_DB_LIMIT) {
        console.log(`[SQLite] Limit ${LOCAL_DB_LIMIT} paczek osiągnięty, czyszczę bazę...`);
        clearBatches();
    }
}

// Przechowywanie danych w pamięci
const measurements = [
    {id: 1, island_id: 'island1', sensor_id: 'spare1', value: 25.5, timestamp: Date.now() - 1000, protocol: 'HTTP', is_synced: 0, sync_timestamp: null},
    {id: 2, island_id: 'island1', sensor_id: 'spare2', value: 30.2, timestamp: Date.now() - 2000, protocol: 'HTTP', is_synced: 0, sync_timestamp: null},
    {id: 3, island_id: 'island2', sensor_id: 'spare1', value: 28.7, timestamp: Date.now() - 3000, protocol: 'MQTT', is_synced: 0, sync_timestamp: null},
    {id: 4, island_id: 'island2', sensor_id: 'spare2', value: 26.8, timestamp: Date.now() - 4000, protocol: 'MQTT', is_synced: 0, sync_timestamp: null},
    {id: 5, island_id: 'island1', sensor_id: 'spare1', value: 24.9, timestamp: Date.now() - 5000, protocol: 'MQTT', is_synced: 0, sync_timestamp: null},
    {id: 6, island_id: 'island2', sensor_id: 'spare1', value: 27.6, timestamp: Date.now() - 6000, protocol: 'MQTT', is_synced: 0, sync_timestamp: null},
    {id: 7, island_id: 'island1', sensor_id: 'spare2', value: 31.0, timestamp: Date.now() - 7000, protocol: 'HTTP', is_synced: 0, sync_timestamp: null},
    {id: 8, island_id: 'island2', sensor_id: 'spare2', value: 29.3, timestamp: Date.now() - 8000, protocol: 'HTTP', is_synced: 0, sync_timestamp: null},
    {id: 9, island_id: 'island1', sensor_id: 'spare1', value: 26.7, timestamp: Date.now() - 9000, protocol: 'MQTT', is_synced: 0, sync_timestamp: null},
    {id: 10, island_id: 'island2', sensor_id: 'spare1', value: 28.4, timestamp: Date.now() - 10000, protocol: 'HTTP', is_synced: 0, sync_timestamp: null}
];

// Obsługa preflight request dla /api/measurements
app.options('/api/measurements', cors(corsOptions));

// Endpoint do pobierania wszystkich pomiarów - chroniony API key
app.get('/api/measurements', apiKeyAuth, (req, res) => {
    // Zwróć tylko najnowsze pomiary dla każdej wyspy
    const latestMeasurements = getLatestMeasurements();
    console.log(`[API] Zwracam ${latestMeasurements.length} najnowszych pomiarów`);
    res.json(latestMeasurements);
});

// Endpoint do pobierania wszystkich paczek z lokalnej bazy (dla debugowania)
app.get('/api/localdb', apiKeyAuth, (req, res) => {
    res.json(getAllBatches());
});

// Endpoint do pobierania wszystkich pomiarów (dla debugowania) 
app.get('/api/measurements/all', apiKeyAuth, (req, res) => {
    const batches = getAllBatches();
    const allMeasurements = [];
    for (const batch of batches) {
        const measurements = JSON.parse(batch.measurements_json);
        for (const m of measurements) {
            allMeasurements.push({
                island_id: batch.island_id,
                sensor_id: m.sensor_id,
                value: m.value,
                timestamp: batch.packet_timestamp,
                protocol: batch.protocol,
            });
        }
    }
    console.log(`[API] Zwracam ${allMeasurements.length} wszystkich pomiarów (historia)`);
    res.json(allMeasurements);
});

// Endpoint do czyszczenia lokalnej bazy
app.delete('/api/localdb', apiKeyAuth, (req, res) => {
    clearBatches();
    res.json({ status: 'cleared' });
});

// Nowy endpoint do masowego zapisu pomiarów (ścieżka niezawodna)
app.post('/api/measurements/bulk', apiKeyAuth, (req, res) => {
    console.log("--- OTRZYMANO ŻĄDANIE /api/measurements/bulk ---");
    console.log("CIAŁO ŻĄDANIA (pierwsze 2 pakiety):", JSON.stringify(req.body.slice(0, 2), null, 2));

    const packets = req.body;

    if (!Array.isArray(packets) || packets.length === 0) {
        return res.status(400).json({ message: 'Request body must be a non-empty array of measurement packets.' });
    }

    const insertStmt = db.prepare(
        `INSERT INTO measurement_batches (
            packet_uuid, 
            island_id, 
            packet_timestamp, 
            measurements_json, 
            created_at,
            is_synced,
            protocol, 
            received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertTransaction = db.transaction((packetsToInsert) => {
        let insertedCount = 0;
        let ignoredCount = 0;

        for (const packet of packetsToInsert) {
             // Walidacja podstawowych pól
            if (!packet.packet_uuid || !packet.island_id || !packet.packet_timestamp || !packet.measurements_json || !packet.created_at) {
                console.warn('[DB] Pominięto pakiet z powodu brakujących pól:', packet.packet_uuid);
                continue; // Pomiń ten pakiet i przejdź do następnego
            }

            try {
                const result = insertStmt.run(
                    packet.packet_uuid,
                    packet.island_id,
                    packet.packet_timestamp, // Zgodnie ze specyfikacją z RPi
                    packet.measurements_json,
                    packet.created_at, // Nowe pole
                    packet.is_synced !== undefined ? packet.is_synced : 0, // Nowe pole
                    'HTTP_BULK',
                    Date.now()
                );
                if (result.changes > 0) {
                    insertedCount++;
                }
            } catch (err) {
                if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    ignoredCount++;
                    console.log(`[DB] Zignorowano zduplikowany pakiet: ${packet.packet_uuid}`);
                } else {
                    console.error("--- KRYTYCZNY BŁĄD TRANSAKCJI ---");
                    console.error("PAKIET POWODUJĄCY BŁĄD:", JSON.stringify(packet, null, 2));
                    console.error("OBIEKT BŁĘDU:", err);
                    throw err; // Przerwij transakcję
                }
            }
        }
        return { inserted: insertedCount, ignored: ignoredCount };
    });

    try {
        const { inserted, ignored } = insertTransaction(packets);
        const received = packets.length;
        
        console.log(`[HTTP_BULK] Przetworzono ${received} pakietów. Zapisano: ${inserted}, Zignorowano (duplikaty): ${ignored}.`);
        
        if (inserted > 0) {
            broadcastMeasurements();
            autoClearIfLimit();
        }

        res.status(201).json({ 
            message: 'Bulk data processed successfully.',
            received: received,
            inserted: inserted,
            duplicates_ignored: ignored
        });

    } catch (error) {
        res.status(500).json({ message: 'Failed to process bulk data due to a server error.', error: error.message });
    }
});

// Endpoint do dodawania nowych pomiarów (szybka ścieżka HTTP)
app.post('/api/measurements', apiKeyAuth, (req, res) => {
    const packet = req.body;
    console.log(`--- OTRZYMANO ŻĄDANIE /api/measurements (szybka ścieżka) dla pakietu ${packet.packet_uuid} ---`);

    // Walidacja podstawowych pól pakietu
    if (!packet || !packet.packet_uuid || !packet.island_id || !packet.timestamp || !packet.measurements) {
        return res.status(400).json({ message: 'Invalid or incomplete packet structure.' });
    }

    try {
        const result = insertSinglePacket(packet, 'HTTP_FAST');
        
        if (result.inserted) {
            broadcastMeasurements();
            autoClearIfLimit();
            return res.status(201).json({ message: 'Packet created successfully.' });
        } else if (result.ignored) {
            return res.status(200).json({ message: 'Packet already exists, ignored.' });
        }
    } catch (error) {
        // Obsługa błędów z insertSinglePacket (np. krytycznych błędów bazy)
        return res.status(500).json({ message: 'Failed to process packet due to a server error.', error: error.message });
    }
});

// Endpoint do debugowania - ładny widok całej bazy
app.get('/api/debug', apiKeyAuth, (req, res) => {
    const batches = getAllBatches();
    const stats = {
        total_batches: batches.length,
        database_size_kb: Math.round(batches.length * 0.5), // szacunkowy rozmiar
        oldest_timestamp: batches.length > 0 ? Math.min(...batches.map(b => b.packet_timestamp)) : null,
        newest_timestamp: batches.length > 0 ? Math.max(...batches.map(b => b.packet_timestamp)) : null,
        protocols: {}
    };
    
    // Statystyki protokołów
    batches.forEach(batch => {
        stats.protocols[batch.protocol] = (stats.protocols[batch.protocol] || 0) + 1;
    });
    
    // Konwersja timestampów na czytelne daty
    const formatTimestamp = (ts) => {
        if (!ts) return null;
        if (ts > 1000000000000) { // milliseconds
            return new Date(ts).toISOString();
        } else { // seconds
            return new Date(ts * 1000).toISOString();
        }
    };
    
    stats.oldest_date = formatTimestamp(stats.oldest_timestamp);
    stats.newest_date = formatTimestamp(stats.newest_timestamp);
    
    // Ostatnie 5 paczek z formatowaniem
    const recentBatches = batches.slice(-5).map(batch => ({
        id: batch.id,
        island_id: batch.island_id,
        timestamp: batch.packet_timestamp,
        date: formatTimestamp(batch.packet_timestamp),
        protocol: batch.protocol,
        measurements_count: JSON.parse(batch.measurements_json).length,
        measurements: JSON.parse(batch.measurements_json)
    }));
    
    // Najnowsze pomiary (dla sprawdzenia logiki)
    const latestMeasurements = getLatestMeasurements();
    
    res.json({
        status: 'ok',
        server_time: new Date().toISOString(),
        database_stats: stats,
        recent_batches: recentBatches,
        latest_measurements_count: latestMeasurements.length,
        latest_measurements: latestMeasurements,
        note: "Ten endpoint pokazuje kompletny stan bazy danych SQLite"
    });
});

// Konfiguracja MQTT
const MQTT_PORT = process.env.MQTT_PORT || 1883;

// Obsługa wiadomości MQTT (szybka ścieżka MQTT)
aedes.on('publish', async (packet, client) => {
    if (client) {
        try {
            const payload = JSON.parse(packet.payload.toString());
            // Walidacja pakietu z MQTT
             if (!payload || !payload.packet_uuid || !payload.island_id || !payload.timestamp || !payload.measurements) {
                console.error('[MQTT] Odrzucono niekompletny pakiet:', payload);
                return;
            }

            console.log(`--- OTRZYMANO WIADOMOŚĆ MQTT (szybka ścieżka) dla pakietu ${payload.packet_uuid} ---`);
            
            const result = insertSinglePacket(payload, 'MQTT');

            if (result.inserted) {
                broadcastMeasurements();
                autoClearIfLimit();
            }
        } catch (e) {
            console.error('[MQTT] Błąd podczas przetwarzania wiadomości MQTT:', e.message);
        }
    }
});

// Obsługa połączeń MQTT
aedes.on('client', (client) => {
    console.log('MQTT client connected:', client.id);
});

aedes.on('clientDisconnect', (client) => {
    console.log('MQTT client disconnected:', client.id);
});

// === OSTATECZNA, POPRAWNA KONFIGURACJA SERWERÓW ===

const httpServer = createServer(app);

// --- Serwer WebSocket dla powiadomień do frontendu ---
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', ws => {
    console.log('[WSS] Klient frontendu połączony.');
    
    // Po podłączeniu, wyślij natychmiast aktualny stan danych
    try {
        const initialData = getLatestMeasurements();
        ws.send(JSON.stringify({ type: 'initial_state', payload: initialData }));
    } catch (error) {
        console.error('[WSS] Nie udało się wysłać stanu początkowego:', error);
    }

    ws.on('close', () => {
        console.log('[WSS] Klient frontendu rozłączony.');
    });
});

// Globalna funkcja do rozgłaszania aktualizacji do frontendu
function broadcastMeasurements() {
    console.log('[WSS] Rozpoczynam transmisję aktualizacji do klientów frontendu...');
    try {
        const latestMeasurements = getLatestMeasurements();
        const dataToBroadcast = JSON.stringify({
            type: 'measurements_update',
            payload: latestMeasurements
        });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(dataToBroadcast);
            }
        });
        console.log(`[WSS] Transmisja zakończona pomyślnie do ${wss.clients.size} klientów.`);
    } catch (error) {
        console.error('[WSS] Błąd podczas transmisji WebSocket:', error);
    }
}

// --- Serwer WebSocket dla MQTT ---
const mqttWss = new WebSocket.Server({ noServer: true });

mqttWss.on('connection', (ws, req) => {
    console.log('[MQTT-WS] Klient MQTT połączony przez WebSocket.');
    const stream = WebSocket.createWebSocketStream(ws, { decodeStrings: false });
    aedes.handle(stream);
});

// --- Główny router połączeń WebSocket ---
httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url;

    if (pathname === '/mqtt') {
        // Jeśli ścieżka to /mqtt, przekaż do serwera MQTT
        mqttWss.handleUpgrade(request, socket, head, (ws) => {
            mqttWss.emit('connection', ws, request);
        });
    } else {
        // W przeciwnym razie, przekaż do serwera dla frontendu
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
});

// --- Start serwera ---
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Serwer HTTP i WebSocket działa na porcie ${PORT}`);
    console.log('Gotowy na połączenia z frontendu (/) i urządzeń MQTT (/mqtt).');
    console.log('Inicjalizacja serwera zakończona.');
}); 