'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const port = Number(process.env.PORT || 3000);
const root = __dirname;
const storage = path.resolve(process.env.DATA_DIR || path.join(root, 'storage'));
const uploadsDir = path.join(storage, 'uploads');
const privateDownloadsDir = path.join(storage, 'private-downloads');
const sessionSecret = process.env.SESSION_SECRET || '';

if (
  sessionSecret.length < 32 ||
  sessionSecret === 'replace-with-a-long-random-secret'
) {
  console.error('Set SESSION_SECRET to a unique random value of at least 32 characters.');
  process.exit(1);
}

if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.ADMIN_USERNAME ||
    !process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_USERNAME.trim() === 'replace-with-admin-username' ||
    process.env.ADMIN_PASSWORD === 'replace-this-before-first-run' ||
    process.env.ADMIN_PASSWORD.length < 12)
) {
  console.error('Set a unique ADMIN_USERNAME and an ADMIN_PASSWORD of at least 12 characters before production startup.');
  process.exit(1);
}

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(privateDownloadsDir, { recursive: true });

const db = new Database(path.join(storage, 'checcospio.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        session TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    this.getStatement = this.db.prepare(
      'SELECT session, expires_at FROM sessions WHERE sid = ?'
    );
    this.setStatement = this.db.prepare(`
      INSERT INTO sessions (sid, session, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET
        session = excluded.session,
        expires_at = excluded.expires_at
    `);
    this.deleteStatement = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        this.deleteStatement.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.session));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const cookieExpiry = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : NaN;
      const fallbackExpiry =
        Date.now() + Number(sessionData.cookie?.maxAge || 8 * 60 * 60 * 1000);
      const expiresAt = Number.isFinite(cookieExpiry) ? cookieExpiry : fallbackExpiry;
      this.setStatement.run(sid, JSON.stringify(sessionData), expiresAt);
      callback?.(null);
    } catch (error) {
      callback?.(error);
    }
  }

  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback);
  }

  destroy(sid, callback) {
    try {
      this.deleteStatement.run(sid);
      callback?.(null);
    } catch (error) {
      callback?.(error);
    }
  }
}

const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
if (
  userCount === 0 &&
  process.env.ADMIN_USERNAME &&
  process.env.ADMIN_USERNAME.trim() !== 'replace-with-admin-username' &&
  process.env.ADMIN_PASSWORD &&
  process.env.ADMIN_PASSWORD !== 'replace-this-before-first-run'
) {
  db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(
    process.env.ADMIN_USERNAME.trim(),
    bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12),
    'admin'
  );
}

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'self'"],
        frameSrc: ['https://open.spotify.com'],
        formAction: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  })
);
app.use(express.json({ limit: '1mb' }));

app.use(
  session({
    store: new SQLiteSessionStore(db),
    name: 'cp.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
});
const newsletterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const allowedUploadTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['application/pdf', '.pdf'],
  ['application/zip', '.zip'],
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadsDir),
    filename: (_req, file, callback) =>
      callback(null, `${crypto.randomUUID()}${allowedUploadTypes.get(file.mimetype)}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) =>
    callback(null, allowedUploadTypes.has(file.mimetype)),
});

function admin(req, res, next) {
  if (req.session.user?.role !== 'admin') {
    return res.status(401).json({ error: 'Autenticazione amministratore richiesta' });
  }
  next();
}

function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') || '';
  const expected = req.session.csrf || '';
  const sentBuffer = Buffer.from(sent);
  const expectedBuffer = Buffer.from(expected);
  if (
    !expected ||
    sentBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sentBuffer, expectedBuffer)
  ) {
    return res.status(403).json({ error: 'Token CSRF non valido' });
  }
  next();
}

function productValues(input) {
  const product = input && typeof input === 'object' ? input : {};
  const name = String(product.name || '').trim();
  const category = product.category;
  const priceCents = Number(product.price_cents);
  const stock =
    product.stock === undefined || product.stock === null || product.stock === ''
      ? null
      : Number(product.stock);

  if (
    !name ||
    name.length > 200 ||
    !['digital', 'physical'].includes(category) ||
    !Number.isSafeInteger(priceCents) ||
    priceCents < 0 ||
    (stock !== null && (!Number.isSafeInteger(stock) || stock < 0))
  ) {
    return null;
  }

  const description = String(product.description || '');
  if (description.length > 20000) return null;
  const translations =
    product.translations &&
    typeof product.translations === 'object' &&
    !Array.isArray(product.translations)
      ? product.translations
      : {};

  return [
    name,
    description,
    category,
    priceCents,
    product.image_path ? String(product.image_path) : null,
    product.digital_file_path ? String(product.digital_file_path) : null,
    stock,
    product.published === true || product.published === 1 ? 1 : 0,
    product.release_date ? String(product.release_date) : null,
    JSON.stringify(translations),
  ];
}

app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, service: 'CheccosPio', version: '0.2.0' });
  } catch {
    res.status(503).json({ ok: false, service: 'CheccosPio' });
  }
});

app.get('/api/csrf', (req, res) => {
  req.session.csrf ||= crypto.randomBytes(32).toString('hex');
  res.json({ csrfToken: req.session.csrf });
});

app.post('/api/admin/login', loginLimiter, csrf, (req, res) => {
  const { username, password } = req.body || {};
  const user = db
    .prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
    .get(String(username || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Credenziali non valide' });
  }

  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: 'Errore di sessione' });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    req.session.csrf = crypto.randomBytes(32).toString('hex');
    res.json({
      user: { username: user.username, role: user.role },
      csrfToken: req.session.csrf,
    });
  });
});

app.post('/api/admin/logout', csrf, (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: 'Errore di sessione' });
    res.clearCookie('cp.sid', { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  });
});

app.get('/api/admin/me', (req, res) =>
  res.json({ user: req.session.user || null })
);

app.use('/api/admin', csrf);

app.get('/api/admin/settings', admin, (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    res.json(Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)])));
  } catch {
    res.status(500).json({ error: 'Impostazioni non leggibili' });
  }
});

app.put('/api/admin/settings', admin, (req, res) => {
  const values = req.body;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return res.status(400).json({ error: 'Formato impostazioni non valido' });
  }
  const put = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);
  try {
    const transaction = db.transaction((settings) => {
      for (const [key, value] of Object.entries(settings)) {
        if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) {
          throw new Error('Chiave impostazione non valida');
        }
        put.run(key, JSON.stringify(value));
      }
    });
    transaction(values);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/products', admin, (_req, res) =>
  res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all())
);

app.post('/api/admin/products', admin, (req, res) => {
  const values = productValues(req.body);
  if (!values) {
    return res.status(400).json({ error: 'Dati prodotto non validi' });
  }
  const result = db
    .prepare(`
      INSERT INTO products (
        name, description, category, price_cents, image_path,
        digital_file_path, stock, published, release_date, translations_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(...values);
  res.status(201).json({ id: result.lastInsertRowid });
});

app.put('/api/admin/products/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  const values = productValues(req.body);
  if (!Number.isSafeInteger(id) || id < 1 || !values) {
    return res.status(400).json({ error: 'Dati prodotto non validi' });
  }
  const result = db
    .prepare(`
      UPDATE products SET
        name = ?, description = ?, category = ?, price_cents = ?, image_path = ?,
        digital_file_path = ?, stock = ?, published = ?, release_date = ?,
        translations_json = ?
      WHERE id = ?
    `)
    .run(...values, id);
  if (result.changes !== 1) return res.status(404).json({ error: 'Prodotto non trovato' });
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: 'ID prodotto non valido' });
  }
  const result = db.prepare('DELETE FROM products WHERE id = ?').run(id);
  if (result.changes !== 1) return res.status(404).json({ error: 'Prodotto non trovato' });
  res.json({ ok: true });
});

app.get('/api/products', (_req, res) => {
  const products = db
    .prepare(`
      SELECT id, name, description, category, price_cents, currency,
        image_path, stock, release_date, translations_json
      FROM products
      WHERE published = 1
      ORDER BY id DESC
    `)
    .all();
  res.json(products);
});

app.get('/api/admin/posts', admin, (_req, res) =>
  res.json(db.prepare('SELECT * FROM posts ORDER BY id DESC').all())
);

app.post('/api/admin/posts', admin, (req, res) => {
  const post = req.body || {};
  const scheduledAt = post.scheduled_at ? String(post.scheduled_at) : null;
  if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) {
    return res.status(400).json({ error: 'Data di programmazione non valida' });
  }
  const result = db
    .prepare(`
      INSERT INTO posts (caption, media_path, media_type, status, scheduled_at, platforms_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      String(post.caption || '').slice(0, 20000),
      post.media_path ? String(post.media_path) : null,
      post.media_type ? String(post.media_type) : null,
      scheduledAt ? 'scheduled' : 'draft',
      scheduledAt,
      JSON.stringify(Array.isArray(post.platforms) ? post.platforms : [])
    );
  res.status(201).json({
    id: result.lastInsertRowid,
    status: scheduledAt ? 'scheduled' : 'draft',
  });
});

app.post('/api/admin/upload', admin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Formato non supportato' });
  res.status(201).json({
    path: `/uploads/${req.file.filename}`,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });
});

app.post('/api/newsletter', newsletterLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const locale = ['it', 'en', 'es', 'fr'].includes(req.body?.locale)
    ? req.body.locale
    : 'it';
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({ error: 'Email non valida' });
  }
  try {
    db.prepare('INSERT INTO newsletter_subscribers (email, locale) VALUES (?, ?)').run(
      email,
      locale
    );
  } catch (error) {
    if (!String(error.message).includes('UNIQUE')) {
      return res.status(500).json({ error: 'Errore iscrizione' });
    }
  }
  res.status(202).json({
    ok: true,
    message: 'Richiesta ricevuta. Configurare conferma email e informativa privacy prima del lancio.',
  });
});

app.get('/api/analytics/summary', admin, (_req, res) => {
  res.json({
    products: db.prepare('SELECT COUNT(*) AS count FROM products').get().count,
    orders: db.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
    paidRevenueCents: db
      .prepare("SELECT COALESCE(SUM(total_cents), 0) AS total FROM orders WHERE status = 'paid'")
      .get().total,
    subscribers: db
      .prepare('SELECT COUNT(*) AS count FROM newsletter_subscribers WHERE confirmed_at IS NOT NULL')
      .get().count,
  });
});

app.get('/api/payments/status', (_req, res) =>
  res.json({ checkoutEnabled: false, status: 'coming_soon' })
);

app.post('/api/payments/stripe-webhook', (_req, res) =>
  res.status(503).json({
    checkoutEnabled: false,
    error: 'Lo store è in arrivo. I pagamenti non sono attivi.',
  })
);

app.use(
  '/uploads',
  express.static(uploadsDir, {
    dotfiles: 'deny',
    index: false,
    fallthrough: false,
  })
);

app.get(['/', '/index.html'], (_req, res) =>
  res.sendFile(path.join(root, 'index.html'))
);

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Caricamento non valido o file troppo grande' });
  }
  if (error) {
    const status =
      Number.isInteger(error.status) && error.status >= 400 && error.status < 500
        ? error.status
        : 500;
    if (status >= 500) console.error('Request failed:', error.message);
    return res.status(status).json({
      error: status === 404 ? 'Risorsa non trovata' : status === 400 ? 'Richiesta non valida' : 'Errore interno',
    });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Risorsa non trovata' }));

function start() {
  return app.listen(port, () => {
    console.log(`CheccosPio server listening on port ${port}`);
  });
}

if (require.main === module) start();

module.exports = { app, db, start, storage };
