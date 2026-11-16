const db = require('../db');
const config = require('../config');
const { hashPassword, verifyPassword, token } = require('../lib/auth');
const { clean } = require('../lib/view');

module.exports = app => {
  app.get('/register', (req, res) => res.render('auth', { title: 'Create an account', mode: 'register', form: {} }));
  app.post('/register', (req, res) => {
    const name = clean(req.body.name, 60), email = clean(req.body.email, 120).toLowerCase(), pw = String(req.body.password || '');
    let error = null;
    if (name.length < 2) error = 'Enter your name.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = 'Enter a valid email address.';
    else if (pw.length < 8) error = 'Use a password of at least 8 characters.';
    else if (db.get('SELECT id FROM users WHERE email=?', email)) error = 'An account with that email already exists. Sign in instead.';
    if (error) return res.status(400).render('auth', { title: 'Create an account', mode: 'register', form: { name, email }, error });
    const r = db.run('INSERT INTO users (email, pass_hash, name, created_at) VALUES (?,?,?,?)', email, hashPassword(pw), name, Date.now());
    req.session.uid = r.lastInsertRowid;
    const next = req.session.next || '/';
    delete req.session.next;
    req.flash(`Welcome to Canado, ${name}.`, 'good');
    res.redirect(next);
  });

  app.get('/login', (req, res) => res.render('auth', { title: 'Sign in', mode: 'login', form: {} }));
  app.post('/login', (req, res) => {
    const email = clean(req.body.email, 120).toLowerCase();
    const u = db.get('SELECT * FROM users WHERE email=?', email);
    if (!u || !verifyPassword(String(req.body.password || ''), u.pass_hash)) return res.status(400).render('auth', { title: 'Sign in', mode: 'login', form: { email }, error: 'That email and password do not match. Try again or reset your password.' });
    req.session.uid = u.id;
    const next = req.session.next || '/';
    delete req.session.next;
    res.redirect(next);
  });
  app.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });

  // Password reset. Email delivery is not wired up yet: the link is written to the server log,
  // and an admin can also create a reset link from the admin panel.
  app.get('/forgot', (req, res) => res.render('auth', { title: 'Reset your password', mode: 'forgot', form: {} }));
  app.post('/forgot', (req, res) => {
    const u = db.get('SELECT * FROM users WHERE email=?', clean(req.body.email, 120).toLowerCase());
    if (u) {
      const t = token();
      db.run('UPDATE users SET reset_token=?, reset_expires=? WHERE id=?', t, Date.now() + 3600e3, u.id);
      console.log(`[password reset] ${u.email}: ${config.baseUrl}/reset/${t}`);
    }
    req.flash('If that email has an account, a reset link is on its way. It expires in one hour.');
    res.redirect('/login');
  });
  const byToken = t => db.get('SELECT * FROM users WHERE reset_token=? AND reset_expires>?', String(t), Date.now());
  app.get('/reset/:token', (req, res) => {
    if (!byToken(req.params.token)) { req.flash('That reset link has expired. Request a new one.', 'bad'); return res.redirect('/forgot'); }
    res.render('auth', { title: 'Choose a new password', mode: 'reset', form: {}, token: req.params.token });
  });
  app.post('/reset/:token', (req, res) => {
    const u = byToken(req.params.token), pw = String(req.body.password || '');
    if (!u) { req.flash('That reset link has expired. Request a new one.', 'bad'); return res.redirect('/forgot'); }
    if (pw.length < 8) return res.status(400).render('auth', { title: 'Choose a new password', mode: 'reset', form: {}, token: req.params.token, error: 'Use a password of at least 8 characters.' });
    db.run('UPDATE users SET pass_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?', hashPassword(pw), u.id);
    req.flash('Password changed. Sign in with your new password.', 'good');
    res.redirect('/login');
  });
};
