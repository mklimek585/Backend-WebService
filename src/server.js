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

// 3. Zweryfikuj Schemat Bazy Danych na Serwerze
console.log('Aktualny schemat tabeli measurement_batches:', db.pragma('table_info(measurement_batches)'));

db.exec(`CREATE TABLE IF NOT EXISTS measurement_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    island_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    measurements_json TEXT NOT NULL,
    protocol TEXT NOT NULL,
    received_at INTEGER NOT NULL
)`);

// Prosta migracja: dodaj kolumnę packet_uuid, jeśli nie istnieje
try {
    const columns = db.pragma('table_info(measurement_batches)');
    const hasUuidColumn = columns.some(col => col.name === 'packet_uuid');
    if (!hasUuidColumn) {
        db.exec('ALTER TABLE measurement_batches ADD COLUMN packet_uuid TEXT UNIQUE');
        console.log('[DB] Kolumna packet_uuid została dodana do tabeli.');
    }
} catch (error) {
    console.error('[DB] Błąd podczas migracji schematu:', error);
}

const LOCAL_DB_LIMIT = 1000;

function insertBatch({island_id, timestamp, measurements, protocol}) {
    const stmt = db.prepare(`INSERT INTO measurement_batches (packet_uuid, island_id, timestamp, measurements_json, protocol, received_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
    stmt.run(
        randomUUID(),
        island_id,
        timestamp,
        JSON.stringify(measurements),
        protocol,
        Date.now()
    );
    // Logujemy po każdym zapisie
    console.log(`[DB] Zapisano paczkę: {island_id: ${island_id}, timestamp: ${timestamp}, protocol: ${protocol}, measurements: ${measurements.length}}`);
    const count = getBatchCount();
    console.log(`[DB] Liczba paczek w bazie po zapisie: ${count}`);
}

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
    // Pobierz najnowsze paczki dla każdej wyspy (bez ograniczeń czasowych)
    const latestBatches = db.prepare(`
        SELECT mb.* FROM measurement_batches mb
        INNER JOIN (
            SELECT island_id, MAX(timestamp) as max_timestamp
            FROM measurement_batches
            GROUP BY island_id
        ) latest ON mb.island_id = latest.island_id AND mb.timestamp = latest.max_timestamp
        ORDER BY mb.timestamp DESC
    `).all();
    
    // Jeśli nie ma najnowszych paczek, weź po prostu ostatnie dostępne
    if (latestBatches.length === 0) {
        const fallbackBatches = db.prepare(`
            SELECT * FROM measurement_batches 
            ORDER BY timestamp DESC 
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
                timestamp: batch.timestamp,
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
                timestamp: batch.timestamp,
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

// Nowy endpoint do masowego zapisu pomiarów
app.post('/api/measurements/bulk', apiKeyAuth, (req, res) => {
    // 1. Wyświetl Dokładną Treść Otrzymywanych Danych
    console.log("Otrzymano żądanie /bulk:", JSON.stringify(req.body, null, 2));

    const packets = req.body;

    if (!Array.isArray(packets)) {
        return res.status(400).json({ error: 'Body should be an array of packets' });
    }

    const insertStmt = db.prepare(
        'INSERT INTO measurement_batches (packet_uuid, island_id, timestamp, measurements_json, protocol, received_at) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const insertTransaction = db.transaction((packetsToInsert) => {
        let insertedCount = 0;
        for (const packet of packetsToInsert) {
            try {
                // Pola z RPi: packet_uuid, island_id, packet_timestamp, measurements_json
                insertStmt.run(
                    packet.packet_uuid,
                    packet.island_id,
                    packet.packet_timestamp,
                    packet.measurements_json,
                    'HTTP_BULK', // Nowy, dedykowany protokół dla tego endpointu
                    Date.now()
                );
                insertedCount++;
            } catch (err) {
                if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    // Ignorujemy błąd duplikatu - to oczekiwane zachowanie
                    console.log(`[DB] Zignorowano zduplikowany pakiet: ${packet.packet_uuid}`);
                } else {
                    // 2. Wyświetl Dokładny Błąd z Bazy Danych
                    console.error('[DB] KRYTYCZNY BŁĄD TRANSAKCJI, wykonuję rollback:', err);
                    throw err; 
                }
            }
        }
        return insertedCount;
    });

    try {
        const insertedCount = insertTransaction(packets);
        console.log(`[HTTP_BULK] Przetworzono ${packets.length} pakietów, zapisano ${insertedCount} nowych.`);
        
        if (insertedCount > 0) {
            broadcastMeasurements();
            autoClearIfLimit();
        }

        res.status(201).json({ 
            message: 'Bulk data processed.',
            received: packets.length,
            inserted: insertedCount 
        });

    } catch (error) {
        res.status(500).json({ error: 'Failed to process bulk data due to a server error.' });
    }
});

// Endpoint do debugowania - ładny widok całej bazy
app.get('/api/debug', apiKeyAuth, (req, res) => {
    const batches = getAllBatches();
    const stats = {
        total_batches: batches.length,
        database_size_kb: Math.round(batches.length * 0.5), // szacunkowy rozmiar
        oldest_timestamp: batches.length > 0 ? Math.min(...batches.map(b => b.timestamp)) : null,
        newest_timestamp: batches.length > 0 ? Math.max(...batches.map(b => b.timestamp)) : null,
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
        timestamp: batch.timestamp,
        date: formatTimestamp(batch.timestamp),
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

// Endpoint do dodawania nowych pomiarów - chroniony API key
app.post('/api/measurements', apiKeyAuth, (req, res) => {
    const data = Array.isArray(req.body) ? req.body : [req.body];
    let allNewMeasurements = [];
    for (const entry of data) {
        const { island_id, measurements } = entry;
        
        let timestamp = entry.timestamp;
        if (timestamp) {
            // Jeśli timestamp jest w sekundach (liczba mniejsza niż 10^12), konwertuj na milisekundy
            if (timestamp < 1000000000000) {
                timestamp *= 1000;
            }
        } else {
            timestamp = Date.now();
        }

        if (!island_id || !timestamp || !measurements) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        insertBatch({ island_id, timestamp, measurements, protocol: 'HTTP' });

        console.log(`[HTTP] Odebrano paczkę z ${island_id}`);
        broadcastMeasurements();
        autoClearIfLimit();
    }
    res.status(201).json(allNewMeasurements);
});

// Endpoint do sprawdzenia statusu serwera - bez API key
app.get('/health', (req, res) => {
    console.log('Health check requested');
    res.json({ status: 'ok' });
});

// Konfiguracja MQTT
const MQTT_PORT = process.env.MQTT_PORT || 1883;

// Obsługa wiadomości MQTT
aedes.on('publish', (packet, client) => {
    if (client) {
        try {
            const payload = JSON.parse(packet.payload.toString());
            const data = Array.isArray(payload) ? payload : [payload];
            for (const entry of data) {
                const { island_id, measurements } = entry;

                let timestamp = entry.timestamp;
                if (timestamp) {
                    // Jeśli timestamp jest w sekundach (liczba mniejsza niż 10^12), konwertuj na milisekundy
                    if (timestamp < 1000000000000) {
                        timestamp *= 1000;
                    }
                } else {
                    timestamp = Date.now();
                }
                
                if (!island_id || !timestamp || !measurements) {
                    return res.status(400).json({ error: 'Missing required fields' });
                }

                insertBatch({ island_id, timestamp, measurements, protocol: 'MQTT' });

                console.log(`[MQTT] Odebrano paczkę z ${client.id} (${island_id})`);
                broadcastMeasurements();
                autoClearIfLimit();
            }
        } catch (e) {
            console.error('Error processing MQTT message:', e);
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

// Utworzenie serwerów HTTP i MQTT WebSocket
const httpServer = createServer(app);

// Konfiguracja WebSocket dla MQTT na ścieżce /mqtt
const wsServer = new WebSocket.Server({ 
    server: httpServer,
    path: '/mqtt'
});

wsServer.on('connection', (ws, req) => {
    console.log('MQTT WebSocket connection established from:', req.connection.remoteAddress);
    const stream = WebSocket.createWebSocketStream(ws);
    aedes.handle(stream);
});

wsServer.on('error', (error) => {
    console.error('WebSocket server error:', error);
});

// Start serwera
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
    console.log(`MQTT WebSocket server running on port ${PORT} at path /mqtt`);
    console.log('Server initialization complete');
}); 