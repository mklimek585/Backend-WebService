# Backend WebService

Serwer obsługujący protokoły HTTP i MQTT dla systemu pomiarowego.

## Funkcjonalności

- Obsługa protokołu HTTP poprzez REST API
- Obsługa protokołu MQTT przez WebSocket
- Zbieranie metryk wydajnościowych dla obu protokołów
- Wspólna logika przetwarzania danych

## Endpointy

- `POST /api/measurements` - przyjmowanie pomiarów przez HTTP
- `GET /api/metrics` - statystyki wydajności
- `ws://[host]:[port]` - broker MQTT przez WebSocket

## Uruchomienie lokalne

```bash
# Instalacja zależności
npm install

# Uruchomienie w trybie developerskim
npm run dev

# Uruchomienie w trybie produkcyjnym
npm start
```

## Deployment na Render

1. Utwórz nowy Web Service na [Render](https://dashboard.render.com)
2. Połącz z repozytorium GitHub
3. Użyj następujących ustawień:
   - Environment: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Port: 10000 # Backend-WebService
