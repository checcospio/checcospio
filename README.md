# CheccosPio — piattaforma starter (v0.1)

Questo pacchetto mantiene la demo grafica esistente e aggiunge una prima base server-side per passare a una piattaforma pubblicabile. **Non è ancora un negozio pronto a incassare né un'integrazione social completa.** Pagamenti, account social, email, privacy e deployment devono essere configurati e testati prima del lancio.

## Stack
- Node.js 20+
- Express + Helmet
- SQLite (`better-sqlite3`) per dati e sessioni
- bcrypt per password amministratore
- Cookie di sessione HttpOnly/SameSite, rate limit login, token CSRF
- Stripe webhook verificato (endpoint base)
- Storage separato per file caricati e download privati

## Avvio locale
1. Installa Node.js 20 o superiore.
2. Copia `.env.example` in `.env`.
3. Genera un segreto casuale lungo almeno 32 caratteri per `SESSION_SECRET` e imposta una password amministratore robusta in `ADMIN_PASSWORD`.
4. Esegui `npm install` e poi `npm start`.
5. Apri `http://localhost:3000`.

Il primo utente admin viene creato solo se `ADMIN_USERNAME` e `ADMIN_PASSWORD` sono impostati e la tabella utenti è vuota. Non usare password demo o credenziali condivise in produzione.

## API già predisposte
- `GET /api/health`
- `GET /api/csrf`
- `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me`
- `GET/PUT /api/admin/settings`
- `GET/POST/PUT/DELETE /api/admin/products` e `GET /api/products`
- `GET/POST /api/admin/posts`
- `POST /api/admin/upload`
- `POST /api/newsletter`
- `GET /api/analytics/summary`
- `GET /api/payments/status`
- `POST /api/payments/stripe-webhook`

Le rotte di modifica richiedono sessione admin e token CSRF. Per le richieste POST/PUT/DELETE: prima `GET /api/csrf`, poi invia `x-csrf-token` col token ricevuto. Dopo login il server rigenera la sessione e restituisce un token nuovo.

## Prima della pubblicazione online
1. Usare HTTPS, segreti robusti, backup e monitoraggio.
2. Completare checkout Stripe e PayPal, idempotenza degli ordini, rimborsi, webhook e test sandbox; non fidarsi del redirect del browser per confermare un pagamento.
3. Implementare la consegna protetta dei file digitali con token monouso/scadenza e limiti di download. La cartella `storage/private-downloads` non è esposta pubblicamente.
4. Integrare OAuth/API ufficiali delle piattaforme social e rispettare limiti e permessi per ogni formato (storie e video non sono supportati allo stesso modo ovunque).
5. Completare conferma newsletter, disiscrizione, privacy/cookie policy, GDPR, IVA/fatture e termini di vendita.
6. Collegare il frontend alle API: il file `public/index.html` è ancora la demo esistente e usa `localStorage` per alcune azioni; non considerare tali azioni protette o condivise tra visitatori.
7. Aggiungere controlli di autorizzazione e test automatici, validazione schema, audit log, protezione upload e scansione file.

## Modello dati
`schema.sql` definisce utenti, impostazioni, prodotti, post programmati, ordini, righe ordine, token download, iscritti newsletter ed eventi analytics.
