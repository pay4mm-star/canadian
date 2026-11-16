const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const geo = require('./lib/geo');
const view = require('./lib/view');
const market = require('./lib/market');
const payments = require('./lib/payments');
const { hashPassword, token } = require('./lib/auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      formAction: ["'self'", 'https://checkout.stripe.com', 'https://connect.stripe.com'], upgradeInsecureRequests: config.prod ? [] : null
    }
  }
}));

// Stripe webhook: needs the raw body, so it is registered before the form parser.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!payments.enabled || !config.stripeWebhookSecret) return res.sendStatus(404);
  let event;
  try { event = payments.parseWebhook(req.body, req.headers['stripe-signature']); } catch (e) { return res.status(400).send('Bad signature'); }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object;
    const order = db.get('SELECT * FROM orders WHERE id=?', +s.client_reference_id || 0);
    if (order && s.payment_status === 'paid' && s.amount_total === order.total_cents) market.markPaid(order.id, s.payment_intent);
  }
  res.json({ received: true });
});

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.prod ? '1d' : 0 }));
app.use('/uploads', express.static(path.join(config.dataDir, 'uploads'), { maxAge: '7d' }));
app.use(express.urlencoded({ extended: false, limit: '300kb' }));
app.use(cookieSession({ name: 'canado', keys: [config.sessionSecret], maxAge: 30 * 86400e3, sameSite: 'lax', httpOnly: true, secure: config.prod }));

app.use((req, res, next) => {
  req.flash = (msg, kind = 'info') => { req.session.flash = { msg, kind }; };
  req.user = req.session.uid ? db.get('SELECT * FROM users WHERE id=?', req.session.uid) : null;
  if (!req.session.csrf) req.session.csrf = token(16);
  Object.assign(res.locals, view, {
    user: req.user, csrf: req.session.csrf, flash: req.session.flash || null, path: req.path, query: req.query, title: null,
    CATEGORIES: geo.CATEGORIES, COUNTRIES: geo.COUNTRIES, PROVINCES: geo.PROVINCES, CONDITIONS: geo.CONDITIONS,
    feePct: config.feeBps / 100, cfg: config, testMode: !payments.enabled, minNextBid: market.minNextBid, isLive: market.isLive,
    unread: req.user ? db.get('SELECT (SELECT COUNT(*) FROM messages WHERE to_id=? AND read_at IS NULL) m, (SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL) n', req.user.id, req.user.id) : { m: 0, n: 0 }
  });
  delete req.session.flash;
  if (req.method === 'POST') {
    const multipart = (req.headers['content-type'] || '').startsWith('multipart/');
    const sent = multipart ? req.query._csrf : req.body && req.body._csrf;
    if (!sent || sent !== req.session.csrf) return res.status(403).render('error', { title: 'Session expired', message: 'Your session expired. Go back, reload the page and try again.' });
  }
  next();
});

const limiter = rateLimit({ windowMs: 15 * 60e3, limit: config.prod ? 30 : 1000, standardHeaders: true, legacyHeaders: false });
app.use(['/login', '/register', '/forgot', '/reset'], (req, res, next) => req.method === 'POST' ? limiter(req, res, next) : next());

require('./routes/auth')(app);
require('./routes/public')(app);
require('./routes/account')(app);
require('./routes/sell')(app);
require('./routes/admin')(app);

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const tooBig = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT';
  res.status(tooBig ? 400 : 500).render('error', { title: 'Something went wrong', message: tooBig ? 'Photos must be 5 MB or smaller, up to 8 per listing.' : err.expose ? err.message : 'We could not complete that. Try again in a moment.' });
});

// First run: create the admin account.
if (!db.get("SELECT id FROM users WHERE role='admin'")) {
  const pw = config.adminPassword || token(6);
  db.run("INSERT INTO users (email, pass_hash, name, role, created_at) VALUES (?,?,?,'admin',?)", config.adminEmail.toLowerCase(), hashPassword(pw), 'Canado Admin', Date.now());
  console.log(`\nAdmin account created: ${config.adminEmail}${config.adminPassword ? '' : '  password: ' + pw}  (change it after signing in)\n`);
}

if (require.main === module) {
  setInterval(market.tick, 30e3);
  market.tick();
  app.listen(config.port, () => console.log(`Canado running at ${config.baseUrl} (${payments.enabled ? 'Stripe payments' : 'TEST MODE: simulated payments'})`));
}
module.exports = app;
