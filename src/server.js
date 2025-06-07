const express = require('express');
const cors = require('cors');
const aedes = require('aedes')();
const { createServer } = require('ws');
const { createServer: createHttpServer } = require('http');
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

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

db.exec(`CREATE TABLE IF NOT EXISTS measurement_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    island_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    measurements_json TEXT NOT NULL,
    protocol TEXT NOT NULL,
    latency INTEGER,
    received_at INTEGER NOT NULL
)`);

const LOCAL_DB_LIMIT = 1000;

function insertBatch({island_id, timestamp, measurements, protocol, latency}) {
    const stmt = db.prepare(`INSERT INTO measurement_batches (island_id, timestamp, measurements_json, protocol, latency, received_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
    stmt.run(
        island_id,
        timestamp,
        JSON.stringify(measurements),
        protocol,
        latency || null,
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

function autoClearIfLimit() {
    if (getBatchCount() >= LOCAL_DB_LIMIT) {
        console.log(`[SQLite] Limit ${LOCAL_DB_LIMIT} paczek osiągnięty, czyszczę bazę...`);
        clearBatches();
    }
}

// Przechowywanie danych w pamięci
const measurements = [
    {id: 1, island_id: 'island1', sensor_id: 'spare1', value: 25.5, timestamp: Date.now() - 1000, protocol: 'HTTP', latency: 150, is_synced: 0, sync_timestamp: null},
    {id: 2, island_id: 'island1', sensor_id: 'spare2', value: 30.2, timestamp: Date.now() - 2000, protocol: 'HTTP', latency: 180, is_synced: 0, sync_timestamp: null},
    {id: 3, island_id: 'island2', sensor_id: 'spare1', value: 28.7, timestamp: Date.now() - 3000, protocol: 'MQTT', latency: 120, is_synced: 0, sync_timestamp: null},
    {id: 4, island_id: 'island2', sensor_id: 'spare2', value: 26.8, timestamp: Date.now() - 4000, protocol: 'MQTT', latency: 130, is_synced: 0, sync_timestamp: null},
    {id: 5, island_id: 'island1', sensor_id: 'spare1', value: 24.9, timestamp: Date.now() - 5000, protocol: 'MQTT', latency: 140, is_synced: 0, sync_timestamp: null},
    {id: 6, island_id: 'island2', sensor_id: 'spare1', value: 27.6, timestamp: Date.now() - 6000, protocol: 'MQTT', latency: 125, is_synced: 0, sync_timestamp: null},
    {id: 7, island_id: 'island1', sensor_id: 'spare2', value: 31.0, timestamp: Date.now() - 7000, protocol: 'HTTP', latency: 165, is_synced: 0, sync_timestamp: null},
    {id: 8, island_id: 'island2', sensor_id: 'spare2', value: 29.3, timestamp: Date.now() - 8000, protocol: 'HTTP', latency: 155, is_synced: 0, sync_timestamp: null},
    {id: 9, island_id: 'island1', sensor_id: 'spare1', value: 26.7, timestamp: Date.now() - 9000, protocol: 'MQTT', latency: 135, is_synced: 0, sync_timestamp: null},
    {id: 10, island_id: 'island2', sensor_id: 'spare1', value: 28.4, timestamp: Date.now() - 10000, protocol: 'HTTP', latency: 145, is_synced: 0, sync_timestamp: null}
];

// Obsługa preflight request dla /api/measurements
app.options('/api/measurements', cors(corsOptions));

// Endpoint do pobierania wszystkich pomiarów - chroniony API key
app.get('/api/measurements', apiKeyAuth, (req, res) => {
    console.log('Received request for measurements');
    console.log(`Sending ${measurements.length} measurements`);
    res.json(measurements);
});

// Endpoint do pobierania wszystkich paczek z lokalnej bazy
app.get('/api/localdb', apiKeyAuth, (req, res) => {
    res.json(getAllBatches());
});

// Endpoint do czyszczenia lokalnej bazy
app.delete('/api/localdb', apiKeyAuth, (req, res) => {
    clearBatches();
    res.json({ status: 'cleared' });
});

// Endpoint do dodawania nowych pomiarów - chroniony API key
app.post('/api/measurements', apiKeyAuth, (req, res) => {
    const data = Array.isArray(req.body) ? req.body : [req.body];
    let allNewMeasurements = [];
    for (const entry of data) {
        const { island_id, measurements, latency } = entry;
        const timestamp = entry.timestamp || Date.now();
        if (!island_id || !measurements || !Array.isArray(measurements)) {
            console.log(`[HTTP] Odrzucono paczkę: brak wymaganych pól (island_id, measurements)`);
            return res.status(400).json({
                error: 'Invalid data format',
                message: 'Each entry must contain island_id and measurements array'
            });
        }
        console.log(`[HTTP] Otrzymano paczkę: {island_id: ${island_id}, timestamp: ${timestamp}, measurements: ${measurements.length}}`);
        insertBatch({island_id, timestamp, measurements, protocol: 'HTTP', latency});
        allNewMeasurements.push({island_id, timestamp, measurements, protocol: 'HTTP', latency});
    }
    autoClearIfLimit();
    res.status(201).json(allNewMeasurements);
});

// Endpoint do sprawdzenia statusu serwera - bez API key
app.get('/health', (req, res) => {
    console.log('Health check requested');
    res.json({ status: 'ok' });
});

// Konfiguracja MQTT
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const WS_PORT = process.env.WS_PORT || 8888;

// Obsługa wiadomości MQTT
aedes.on('publish', (packet, client) => {
    if (client) {
        try {
            const payload = JSON.parse(packet.payload.toString());
            const data = Array.isArray(payload) ? payload : [payload];
            for (const entry of data) {
                const { island_id, measurements, latency } = entry;
                const timestamp = entry.timestamp || Date.now();
                if (!island_id || !measurements || !Array.isArray(measurements)) {
                    console.log(`[MQTT] Odrzucono paczkę: brak wymaganych pól (island_id, measurements)`);
                    continue;
                }
                console.log(`[MQTT] Otrzymano paczkę: {island_id: ${island_id}, timestamp: ${timestamp}, measurements: ${measurements.length}}`);
                insertBatch({island_id, timestamp, measurements, protocol: 'MQTT', latency});
            }
            autoClearIfLimit();
        } catch (error) {
            console.error('Error processing MQTT message:', error);
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

// Utworzenie serwerów MQTT
const httpServer = createHttpServer(app);
const wsServer = createServer({ server: httpServer }, aedes.handle);

// Start serwerów
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
    console.log(`MQTT WebSocket server running on port ${WS_PORT}`);
    console.log('Server initialization complete');
}); 