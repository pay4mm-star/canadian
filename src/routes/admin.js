const db = require('../db');
const config = require('../config');
const market = require('../lib/market');
const payments = require('../lib/payments');
const { requireAdmin, token } = require('../lib/auth');
const { clean } = require('../lib/view');

const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = app => {
  app.use('/admin', requireAdmin);

  app.get('/admin', (req, res) => {
    const tab = ['overview', 'sellers', 'listings', 'orders', 'cases', 'payouts', 'users'].includes(req.query.tab) ? req.query.tab : 'overview';
    const d = {};
    if (tab === 'overview') d.stats = db.get(`SELECT
      (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM users WHERE seller_status='approved') sellers, (SELECT COUNT(*) FROM users WHERE seller_status='pending') pending,
      (SELECT COUNT(*) FROM listings WHERE status='active') listings, (SELECT COUNT(*) FROM orders WHERE status IN ('paid','shipped','delivered')) orders,
      (SELECT COALESCE(SUM(item_cents+ship_cents),0) FROM orders WHERE status IN ('paid','shipped','delivered')) gmv,
      (SELECT COALESCE(SUM(fee_cents),0) FROM orders WHERE status IN ('paid','shipped','delivered')) fees,
      (SELECT COALESCE(SUM(tax_cents),0) FROM orders WHERE status IN ('paid','shipped','delivered') AND tax_remitter='platform') tax_owed,
      (SELECT COALESCE(SUM(net_cents),0) FROM orders WHERE funds_status IN ('held','available','frozen')) owed_sellers,
      (SELECT COUNT(*) FROM cases WHERE status='open') cases, (SELECT COUNT(*) FROM payouts WHERE status='scheduled') payouts_due`);
    if (tab === 'sellers') d.sellers = db.all("SELECT * FROM users WHERE seller_status<>'none' ORDER BY seller_status='pending' DESC, id DESC LIMIT 300");
    if (tab === 'listings') d.listings = db.all('SELECT l.*, u.shop_name FROM listings l JOIN users u ON u.id=l.seller_id ORDER BY l.id DESC LIMIT 300');
    if (tab === 'orders') d.orders = db.all('SELECT o.*, b.name buyer_name, s.shop_name FROM orders o JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id ORDER BY o.id DESC LIMIT 300');
    if (tab === 'cases') d.cases = db.all("SELECT c.*, o.title, o.total_cents, o.status order_status, u.name opener FROM cases c JOIN orders o ON o.id=c.order_id JOIN users u ON u.id=c.opener_id ORDER BY c.status='open' DESC, c.id DESC LIMIT 200");
    if (tab === 'payouts') d.payouts = db.all("SELECT p.*, u.shop_name, u.payout_details, u.legal_name FROM payouts p JOIN users u ON u.id=p.seller_id ORDER BY p.status='scheduled' DESC, p.id DESC LIMIT 300");
    if (tab === 'users') d.users = db.all('SELECT id, name, email, role, seller_status, created_at FROM users ORDER BY id DESC LIMIT 300');
    res.render('admin', { title: 'Admin', tab, d, stripeOn: payments.enabled, resetLink: req.session.resetLink || null });
    delete req.session.resetLink;
  });

  app.post('/admin/sellers/:id/:action', (req, res) => {
    const u = db.get('SELECT * FROM users WHERE id=?', +req.params.id || 0), act = req.params.action;
    if (u && u.seller_status !== 'none' && ['approve', 'suspend'].includes(act)) {
      db.run('UPDATE users SET seller_status=? WHERE id=?', act === 'approve' ? 'approved' : 'suspended', u.id);
      db.notify(u.id, act === 'approve' ? 'You are approved to sell on Canado. Create your first listing.' : 'Your selling account has been suspended. Contact support.', act === 'approve' ? '/sell/hub' : '/');
      req.flash(`${u.shop_name} ${act === 'approve' ? 'approved' : 'suspended'}.`, 'good');
    }
    res.redirect('/admin?tab=sellers');
  });

  app.post('/admin/listings/:id/remove', (req, res) => {
    const l = db.get('SELECT * FROM listings WHERE id=?', +req.params.id || 0);
    if (l && l.status === 'active') {
      db.run("UPDATE listings SET status='removed' WHERE id=?", l.id);
      db.notify(l.seller_id, `Your listing "${l.title}" was removed for breaking the listing rules.`, '/terms');
      req.flash('Listing removed.', 'good');
    }
    res.redirect('/admin?tab=listings');
  });

  // Cases: refund the buyer, or close in the seller's favour and release the frozen funds.
  app.post('/admin/cases/:id/:action', a(async (req, res) => {
    const c = db.get("SELECT * FROM cases WHERE id=? AND status='open'", +req.params.id || 0);
    const o = c && db.get('SELECT * FROM orders WHERE id=?', c.order_id);
    if (c && o && req.params.action === 'refund') {
      await market.refundOrder(o, 'Canado decided this case for the buyer.');
      db.run("UPDATE cases SET status='refunded', resolution=?, resolved_at=? WHERE id=?", clean(req.body.note, 300) || 'Refunded to buyer', Date.now(), c.id);
      req.flash('Buyer refunded and case closed.', 'good');
    } else if (c && o && req.params.action === 'release') {
      db.run("UPDATE orders SET funds_status='held', available_at=? WHERE id=? AND funds_status='frozen'", Date.now(), o.id);
      db.run("UPDATE cases SET status='closed', resolution=?, resolved_at=? WHERE id=?", clean(req.body.note, 300) || 'Closed for the seller', Date.now(), c.id);
      db.notify(o.buyer_id, `Your case on order #${o.id} was closed without a refund.`, '/orders/' + o.id);
      db.notify(o.seller_id, `The case on order #${o.id} was closed in your favour. The funds are released.`, '/orders/' + o.id);
      req.flash('Case closed and funds released to the seller.', 'good');
    }
    res.redirect('/admin?tab=cases');
  }));

  app.post('/admin/payouts/run', a(async (req, res) => {
    const made = await market.runPayouts({ force: !!req.body.force });
    req.flash(made.length ? `${made.length} payout${made.length === 1 ? '' : 's'} created.` : 'No payouts are due right now.', 'good');
    res.redirect('/admin?tab=payouts');
  }));
  app.post('/admin/payouts/:id/sent', (req, res) => {
    const ok = market.markPayoutSent(+req.params.id || 0, clean(req.body.reference, 80));
    req.flash(ok ? 'Payout marked as sent.' : 'That payout was already sent.', ok ? 'good' : 'bad');
    res.redirect('/admin?tab=payouts');
  });

  app.post('/admin/users/:id/reset', (req, res) => {
    const u = db.get('SELECT * FROM users WHERE id=?', +req.params.id || 0);
    if (u) {
      const t = token();
      db.run('UPDATE users SET reset_token=?, reset_expires=? WHERE id=?', t, Date.now() + 24 * 3600e3, u.id);
      req.session.resetLink = { email: u.email, url: `${config.baseUrl}/reset/${t}` };
    }
    res.redirect('/admin?tab=users');
  });
};
