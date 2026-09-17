# Chatt

En enkel meddelandeapp byggd för att öva DevOps.

- Konto med namn, användarnamn och lösenord
- Sök andra användare på användarnamn
- Privata chattar i realtid (WebSocket)
- Lista över tidigare chattar
- Allt sparas i en SQLite-databas (`data/chatt.db`)

## Köra lokalt (kräver Node.js 22 eller senare)

    npm install
    npm start

Öppna http://localhost:3000

## Köra med Docker

    docker build -t chatt .
    docker run -p 3000:3000 -v chatt-data:/app/data chatt

`-v chatt-data:/app/data` gör att databasen sparas i en volym och överlever omstarter.

## API

| Metod | Sökväg                    | Beskrivning                 |
|-------|---------------------------|-----------------------------|
| GET   | /health                   | Hälsokontroll               |
| POST  | /api/register             | Skapa konto                 |
| POST  | /api/login                | Logga in                    |
| GET   | /api/search?q=            | Sök användare               |
| GET   | /api/conversations        | Mina chattar                |
| GET   | /api/messages/:username   | Meddelanden med en användare|
