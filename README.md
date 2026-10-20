# CheccosPio — sito ufficiale

Sito ufficiale dell’artista CheccosPio con catalogo musicale, player Spotify e aggiornamenti. Il negozio è mostrato come **IN ARRIVO!**: carrello, checkout e pagamenti sono disattivati.

## Stack

- Node.js 20+
- Express
- SQLite (`better-sqlite3`) per dati e sessioni
- Sessioni HttpOnly, protezione CSRF e rate limit per login/iscrizioni
- Helmet con Content Security Policy per il player Spotify

## Avvio locale

1. Installa Node.js 20 o superiore.
2. Copia `.env.example` in `.env`.
3. Imposta un `SESSION_SECRET` casuale di almeno 32 caratteri e credenziali amministratore uniche. Non riutilizzare i valori di esempio.
4. Esegui `npm ci`.
5. Avvia i test con `npm test`.
6. Avvia il sito con `npm start` e apri `http://localhost:3000`.

I dati SQLite, le sessioni e i caricamenti vengono salvati in `DATA_DIR` (per impostazione locale `./storage`). In produzione deve puntare a un filesystem persistente.

## API

- `GET /api/health`
- `GET /api/csrf`
- `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me`
- `GET/PUT /api/admin/settings`
- `GET/POST/PUT/DELETE /api/admin/products`, `GET /api/products`
- `GET/POST /api/admin/posts`
- `POST /api/admin/upload`
- `POST /api/newsletter`
- `GET /api/analytics/summary`
- `GET /api/payments/status`
- `POST /api/payments/stripe-webhook` — risponde `503` finché i pagamenti restano disattivati.

Le rotte di modifica richiedono una sessione amministratore e il token CSRF restituito da `GET /api/csrf`. Il sito pubblico non espone un pannello amministratore o un flusso di acquisto.

## Distribuzione

Il progetto include un Dockerfile e Docker Compose. Per le istruzioni su SQLite persistente, HTTPS, backup e opzioni di hosting consulta [`DEPLOYMENT.md`](DEPLOYMENT.md).

Prima di attivare in futuro newsletter o pagamenti serviranno, tra le altre cose, informativa privacy, consenso, conferma e disiscrizione email, checkout completo e verifiche fiscali. Queste funzioni non sono attive in questa versione.
