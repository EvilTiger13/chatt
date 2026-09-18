# Chatt

En egen meddelandeapp byggd som DevOps-övning: Node.js, WebSocket, SQLite, WebRTC, Docker och CI/CD med GitHub Actions.

## Funktioner

- Konto med e-post, namn, användarnamn och lösenord
- E-postverifiering med 6-siffrig kod (gäller 15 min, max 5 försök)
- Inloggning med användarnamn eller e-post
- Profil: profilbild, namn och "om mig"
- Integritet: synas i sökningen, läskvitton, vem som får ringa
- Sök andra användare på användarnamn
- Privata chattar i realtid med läskvitton (✓ / ✓✓) och "skriver…"
- Svara på, redigera och radera meddelanden
- Skicka bilder och filer (max 25 MB), klistra in bilder
- Röstmeddelanden
- Röst- och videosamtal (WebRTC)
- Fungerar i mobilens webbläsare

## Köra lokalt (Node.js 22.13 eller senare)

    npm install
    npm test
    npm start

Öppna http://localhost:3000. Utan SMTP-inställningar skrivs verifieringskoden ut i terminalen.

## Köra med Docker

    docker build -t chatt .
    docker run -p 3000:3000 -v chatt-data:/app/data --env-file .env chatt

`-v chatt-data:/app/data` sparar databasen och uppladdade filer i en volym.

## Konfiguration

Se `.env.example`.

| Variabel | Beskrivning |
|---|---|
| `PORT` | Port (standard 3000) |
| `DATA_DIR` | Mapp för databas och filer (standard `./data`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Utgående e-post |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | TURN-server för samtal |

## Om samtal

Samtal kräver HTTPS (eller localhost) för att webbläsaren ska ge åtkomst till mikrofon och kamera.
Ljud och bild går direkt mellan användarna. Servern förmedlar bara signalerna för att koppla upp.
Utan TURN-server kan samtal misslyckas mellan vissa nätverk, till exempel mobilnät. Lösningen är
att köra en egen TURN-server (coturn) och sätta `TURN_*`-variablerna.

## API i korthet

| Metod | Sökväg | Beskrivning |
|---|---|---|
| GET | `/health` | Hälsokontroll |
| POST | `/api/register`, `/api/verify`, `/api/resend`, `/api/login`, `/api/logout` | Konto |
| GET/POST | `/api/me` | Min profil och inställningar |
| POST/DELETE | `/api/me/avatar` | Profilbild |
| POST | `/api/me/password` | Byt lösenord |
| GET | `/api/search?q=` | Sök användare |
| GET | `/api/conversations` | Mina chattar |
| GET | `/api/messages/:username` | Meddelanden |
| POST | `/api/upload` | Ladda upp fil |
| WS | `/` | Realtid: meddelanden, läskvitton, "skriver", samtalssignalering |
