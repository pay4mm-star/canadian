const crypto = require('crypto');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}
const token = (n = 24) => crypto.randomBytes(n).toString('hex');

function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.next = req.method === 'GET' ? req.originalUrl : '/';
  req.flash('Sign in to continue.');
  res.redirect('/login');
}
function requireSeller(req, res, next) {
  if (!req.user) return requireLogin(req, res, next);
  if (req.user.seller_status === 'approved') return next();
  res.redirect('/sell/apply');
}
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
}

module.exports = { hashPassword, verifyPassword, token, requireLogin, requireSeller, requireAdmin };
