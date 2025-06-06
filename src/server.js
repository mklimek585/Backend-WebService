const express = require('express');
const cors = require('cors');
require('dotenv').config();

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

// Endpoint do dodawania nowych pomiarów - chroniony API key
app.post('/api/measurements', apiKeyAuth, (req, res) => {
    console.log('Received new measurement:', req.body);
    
    const newMeasurement = {
        id: measurements.length + 1,
        ...req.body,
        timestamp: req.body.timestamp || Date.now(),
        is_synced: 0,
        sync_timestamp: null
    };
    
    measurements.push(newMeasurement);
    console.log(`Added new measurement. Total measurements: ${measurements.length}`);
    
    res.status(201).json(newMeasurement);
});

// Endpoint do sprawdzenia statusu serwera - bez API key
app.get('/health', (req, res) => {
    console.log('Health check requested');
    res.json({ status: 'ok' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Server initialization complete');
}); 