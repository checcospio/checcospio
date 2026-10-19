require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Stripe = require('stripe');

const app = express();
const port = Number(process.env.PORT || 3000);
const root = __dirname;
const storage = path.join(root, 'storage');
fs.mkdirSync(path.join(storage, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(storage, 'private-downloads'), { recursive: true });
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('Set SESSION_SECRET to a random value of at least 32 characters in .env');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'replace-this-before-first-run')) {
  console.error('Set a unique ADMIN_PASSWORD before production startup.'); process.exit(1);
}
const db = new Database(path.join(storage, 'checcospio.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
if (!count && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== 'replace-this-before-first-run') {
  db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(process.env.ADMIN_USERNAME, bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12), 'admin');
}
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use((req,res,next)=>{ if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1); next(); });
// Stripe webhook must receive the raw body before express.json.
app.post('/api/payments/stripe-webhook', express.raw({type:'application/json'}), (req,res)=>{
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Payments are not configured');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).send(`Webhook signature invalid: ${e.message}`); }
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    db.prepare("UPDATE orders SET status='paid' WHERE provider_session_id=?").run(event.data.object.id);
    // Fulfilment/download tokens should be generated idempotently by a production job.
  }
  res.json({received:true});
});
app.use(express.json({limit:'1mb'}));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: storage }),
  name: 'cp.sid', secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', maxAge: 8*60*60*1000 }
}));
const loginLimiter = rateLimit({windowMs:15*60*1000, limit:8, standardHeaders:true, legacyHeaders:false});
const upload = multer({
  storage: multer.diskStorage({destination:(req,file,cb)=>cb(null,path.join(storage,'uploads')),filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase())}),
  limits:{fileSize:100*1024*1024,files:1},
  fileFilter:(req,file,cb)=>cb(null,/^(image\/(jpeg|png|webp|gif)|video\/mp4|audio\/(mpeg|mp4|wav|x-wav)|application\/pdf|application\/zip)$/.test(file.mimetype))
});
function admin(req,res,next){ if(req.session.user?.role!=='admin') return res.status(401).json({error:'Autenticazione amministratore richiesta'}); next(); }
function csrf(req,res,next){ if(['GET','HEAD','OPTIONS'].includes(req.method)) return next(); const sent=req.get('x-csrf-token'); if(!req.session.csrf || sent!==req.session.csrf) return res.status(403).json({error:'Token CSRF non valido'}); next(); }
app.get('/api/health',(req,res)=>res.json({ok:true,service:'CheccosPio',version:'0.1.0'}));
app.get('/api/csrf',(req,res)=>{req.session.csrf ||= crypto.randomBytes(32).toString('hex'); res.json({csrfToken:req.session.csrf});});
app.post('/api/admin/login',loginLimiter,csrf,(req,res)=>{
  const {username,password}=req.body||{};
  const user=db.prepare('SELECT id,username,password_hash,role FROM users WHERE username=?').get(String(username||''));
  if(!user || !bcrypt.compareSync(String(password||''),user.password_hash)) return res.status(401).json({error:'Credenziali non valide'});
  req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Errore di sessione'});req.session.user={id:user.id,username:user.username,role:user.role};req.session.csrf=crypto.randomBytes(32).toString('hex');res.json({user:{username:user.username,role:user.role},csrfToken:req.session.csrf});});
});
app.post('/api/admin/logout',csrf,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/me',(req,res)=>res.json({user:req.session.user||null}));
app.use('/api/admin',csrf);
app.get('/api/admin/settings',admin,(req,res)=>{const rows=db.prepare('SELECT key,value FROM settings').all();res.json(Object.fromEntries(rows.map(x=>[x.key,JSON.parse(x.value)])));});
app.put('/api/admin/settings',admin,(req,res)=>{const put=db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP');const tx=db.transaction(obj=>{for(const [k,v] of Object.entries(obj||{})){if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(k))throw Error('Chiave impostazione non valida');put.run(k,JSON.stringify(v));}});try{tx(req.body);res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/admin/products',admin,(req,res)=>res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all()));
app.post('/api/admin/products',admin,(req,res)=>{const p=req.body||{};if(!p.name||!['digital','physical'].includes(p.category)||!Number.isInteger(p.price_cents)||p.price_cents<0)return res.status(400).json({error:'Nome, categoria e prezzo in centesimi sono obbligatori'});const r=db.prepare('INSERT INTO products(name,description,category,price_cents,image_path,digital_file_path,stock,published,release_date,translations_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(p.name,p.description||'',p.category,p.price_cents,p.image_path||null,p.digital_file_path||null,p.stock??null,p.published?1:0,p.release_date||null,JSON.stringify(p.translations||{}));res.status(201).json({id:r.lastInsertRowid});});
app.put('/api/admin/products/:id',admin,(req,res)=>{const p=req.body||{};const r=db.prepare('UPDATE products SET name=?,description=?,category=?,price_cents=?,image_path=?,digital_file_path=?,stock=?,published=?,release_date=?,translations_json=? WHERE id=?').run(p.name,p.description||'',p.category,p.price_cents,p.image_path||null,p.digital_file_path||null,p.stock??null,p.published?1:0,p.release_date||null,JSON.stringify(p.translations||{}),Number(req.params.id));res.json({ok:r.changes===1});});
app.delete('/api/admin/products/:id',admin,(req,res)=>res.json({ok:db.prepare('DELETE FROM products WHERE id=?').run(Number(req.params.id)).changes===1}));
app.get('/api/products',(req,res)=>res.json(db.prepare('SELECT id,name,description,category,price_cents,currency,image_path,stock,release_date,translations_json FROM products WHERE published=1 ORDER BY id DESC').all()));
app.get('/api/admin/posts',admin,(req,res)=>res.json(db.prepare('SELECT * FROM posts ORDER BY id DESC').all()));
app.post('/api/admin/posts',admin,(req,res)=>{const p=req.body||{};const r=db.prepare('INSERT INTO posts(caption,media_path,media_type,status,scheduled_at,platforms_json) VALUES(?,?,?,?,?,?)').run(p.caption||'',p.media_path||null,p.media_type||null,p.scheduled_at?'scheduled':'draft',p.scheduled_at||null,JSON.stringify(p.platforms||[]));res.status(201).json({id:r.lastInsertRowid,status:p.scheduled_at?'scheduled':'draft'});});
app.post('/api/admin/upload',admin,upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'Formato non supportato'});res.status(201).json({path:'/uploads/'+req.file.filename,originalName:req.file.originalname,mimeType:req.file.mimetype,size:req.file.size});});
app.post('/api/newsletter',(req,res)=>{const email=String(req.body?.email||'').trim().toLowerCase();const locale=['it','en','es','fr'].includes(req.body?.locale)?req.body.locale:'it';if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'Email non valida'});try{db.prepare('INSERT INTO newsletter_subscribers(email,locale) VALUES(?,?)').run(email,locale);}catch(e){if(!String(e.message).includes('UNIQUE'))return res.status(500).json({error:'Errore iscrizione'});}res.status(202).json({ok:true,message:'Richiesta ricevuta. Configurare conferma email e informativa privacy prima del lancio.'});});
app.get('/api/analytics/summary',admin,(req,res)=>{res.json({products:db.prepare('SELECT COUNT(*) n FROM products').get().n,orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n,paidRevenueCents:db.prepare("SELECT COALESCE(SUM(total_cents),0) n FROM orders WHERE status='paid'").get().n,subscribers:db.prepare('SELECT COUNT(*) n FROM newsletter_subscribers WHERE confirmed_at IS NOT NULL').get().n});});
app.get('/api/payments/status',(req,res)=>res.json({stripeConfigured:Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET),paypalConfigured:Boolean(process.env.PAYPAL_CLIENT_ID&&process.env.PAYPAL_CLIENT_SECRET)}));
// Never serve private downloads or the SQLite database as static files.
app.use('/uploads',express.static(path.join(storage,'uploads'),{dotfiles:'deny',index:false}));
app.use(express.static(path.join(root,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(root,'public','index.html')));
app.listen(port,()=>console.log(`CheccosPio starter running on http://localhost:${port}`));
