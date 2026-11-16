const db = require('../db');
const config = require('../config');
const market = require('../lib/market');
const shipping = require('../lib/shipping');
const payments = require('../lib/payments');
const geo = require('../lib/geo');
const { requireLogin, hashPassword, verifyPassword, token } = require('../lib/auth');
const { clean } = require('../lib/view');

const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const admins = () => db.all("SELECT id FROM users WHERE role='admin'");

// Validates a shipping address from a form. Returns { addr } or { error }.
function readAddress(b) {
  const addr = { name: clean(b.ship_name, 80), addr1: clean(b.ship_addr1, 120), addr2: clean(b.ship_addr2, 120), city: clean(b.ship_city, 80), region: clean(b.ship_region, 60), postal: clean(b.ship_postal, 12).toUpperCase(), country: clean(b.ship_country, 2).toUpperCase() };
  if (!addr.name || !addr.addr1 || !addr.city) return { error: 'Enter the recipient name, street address and city.' };
  if (!geo.COUNTRIES[addr.country]) return { error: 'Choose a country.' };
  if (addr.country === 'CA') {
    const byName = Object.keys(geo.PROVINCES).find(k => geo.PROVINCES[k].toLowerCase() === addr.region.toLowerCase());
    addr.region = byName || addr.region.toUpperCase();
    const postal = geo.normalizePostal(addr.postal);
    if (!geo.PROVINCES[addr.region]) return { error: 'Choose a province or territory.' };
    if (!postal || !geo.postalMatchesProvince(postal, addr.region)) return { error: 'Enter a valid postal code for that province, like K1A 0B1.' };
    addr.postal = postal;
  } else if (addr.country === 'US' && !/^\d{5}(-?\d{4})?$/.test(addr.postal)) return { error: 'Enter a valid ZIP code.' };
  else if (!addr.region && addr.country === 'US') return { error: 'Enter the state.' };
  return { addr };
}

module.exports = app => {
  app.get('/account', requireLogin, (req, res) => {
    const id = req.user.id, tab = ['orders', 'bids', 'watch', 'offers', 'settings'].includes(req.query.tab) ? req.query.tab : 'orders';
    const data = {};
    if (tab === 'orders') data.orders = db.all('SELECT o.*, u.shop_name FROM orders o JOIN users u ON u.id=o.seller_id WHERE o.buyer_id=? ORDER BY o.id DESC LIMIT 100', id);
    if (tab === 'bids') data.bids = db.all("SELECT l.*, MAX(b.max_cents) my_max FROM bids b JOIN listings l ON l.id=b.listing_id WHERE b.bidder_id=? GROUP BY l.id ORDER BY l.ends_at DESC LIMIT 100", id);
    if (tab === 'watch') data.watch = db.all("SELECT l.*, (SELECT file FROM photos WHERE listing_id=l.id ORDER BY pos LIMIT 1) photo, u.shop_name, u.city seller_city, u.province seller_prov FROM watch w JOIN listings l ON l.id=w.listing_id JOIN users u ON u.id=l.seller_id WHERE w.user_id=? ORDER BY l.ends_at", id);
    if (tab === 'offers') data.offers = db.all('SELECT o.*, l.title FROM offers o JOIN listings l ON l.id=o.listing_id WHERE o.buyer_id=? ORDER BY o.id DESC LIMIT 100', id);
    res.render('account', { title: 'My Canado', tab, ...data });
  });

  app.post('/account/settings', requireLogin, (req, res) => {
    const name = clean(req.body.name, 60);
    if (name.length < 2) { req.flash('Enter your name.', 'bad'); return res.redirect('/account?tab=settings'); }
    db.run('UPDATE users SET name=? WHERE id=?', name, req.user.id);
    if (req.body.ship_addr1) {
      const r = readAddress(req.body);
      if (r.error) { req.flash(r.error, 'bad'); return res.redirect('/account?tab=settings'); }
      const s = r.addr;
      db.run('UPDATE users SET ship_name=?, ship_addr1=?, ship_addr2=?, ship_city=?, ship_region=?, ship_postal=?, ship_country=? WHERE id=?', s.name, s.addr1, s.addr2, s.city, s.region, s.postal, s.country, req.user.id);
    }
    if (req.body.new_password) {
      if (!verifyPassword(String(req.body.current_password || ''), req.user.pass_hash)) { req.flash('Your current password is not correct.', 'bad'); return res.redirect('/account?tab=settings'); }
      if (String(req.body.new_password).length < 8) { req.flash('Use a new password of at least 8 characters.', 'bad'); return res.redirect('/account?tab=settings'); }
      db.run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(String(req.body.new_password)), req.user.id);
    }
    req.flash('Settings saved.', 'good');
    res.redirect('/account?tab=settings');
  });

  app.get('/notifications', requireLogin, (req, res) => {
    const rows = db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', req.user.id);
    db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', Date.now(), req.user.id);
    res.render('notifications', { title: 'Notifications', rows });
  });

  /* ---------- Checkout ---------- */
  const loadForCheckout = (req, res) => {
    const o = db.get('SELECT * FROM orders WHERE id=? AND buyer_id=?', +req.params.id || 0, req.user.id);
    if (!o) { res.status(404).render('error', { title: 'Not found', message: 'That order does not exist.' }); return null; }
    if (o.status !== 'awaiting_payment') { res.redirect('/orders/' + o.id); return null; }
    return o;
  };
  const destOf = o => ({ country: o.ship_country, postal: o.ship_postal, region: o.ship_region });

  app.get('/checkout/:id', requireLogin, a(async (req, res) => {
    const o = loadForCheckout(req, res); if (!o) return;
    const l = db.get('SELECT * FROM listings WHERE id=?', o.listing_id), seller = db.get('SELECT * FROM users WHERE id=?', o.seller_id);
    const u = req.user;
    const addr = o.ship_country ? o : { ship_name: u.ship_name || u.name, ship_addr1: u.ship_addr1, ship_addr2: u.ship_addr2, ship_city: u.ship_city, ship_region: u.ship_region, ship_postal: u.ship_postal, ship_country: u.ship_country || 'CA' };
    let ship = null, quotes = [];
    if (o.ship_country && !req.query.edit) {
      ship = await shipping.quote(l, seller, destOf(o), o.qty);
      quotes = ship.options.map(opt => ({ ...opt, ...market.priceOrder(o, seller, destOf(o), opt) }));
    }
    res.render('checkout', { title: 'Checkout', o, l, seller, addr, ship, quotes, editing: !o.ship_country || !!req.query.edit });
  }));

  app.post('/checkout/:id/address', requireLogin, (req, res) => {
    const o = loadForCheckout(req, res); if (!o) return;
    const r = readAddress(req.body);
    if (r.error) { req.flash(r.error, 'bad'); return res.redirect(`/checkout/${o.id}?edit=1`); }
    const s = r.addr;
    db.run('UPDATE orders SET ship_name=?, ship_addr1=?, ship_addr2=?, ship_city=?, ship_region=?, ship_postal=?, ship_country=? WHERE id=?', s.name, s.addr1, s.addr2, s.city, s.region, s.postal, s.country, o.id);
    db.run('UPDATE users SET ship_name=?, ship_addr1=?, ship_addr2=?, ship_city=?, ship_region=?, ship_postal=?, ship_country=? WHERE id=?', s.name, s.addr1, s.addr2, s.city, s.region, s.postal, s.country, req.user.id);
    res.redirect('/checkout/' + o.id);
  });

  app.post('/checkout/:id/pay', requireLogin, a(async (req, res) => {
    const o = loadForCheckout(req, res); if (!o) return;
    if (!o.ship_country) return res.redirect('/checkout/' + o.id);
    const l = db.get('SELECT * FROM listings WHERE id=?', o.listing_id), seller = db.get('SELECT * FROM users WHERE id=?', o.seller_id);
    const ship = await shipping.quote(l, seller, destOf(o), o.qty);
    const opt = ship.options.find(x => x.code === req.body.service);
    if (!opt) { req.flash(ship.error || 'Choose a Canada Post service.', 'bad'); return res.redirect('/checkout/' + o.id); }
    const t = market.priceOrder(o, seller, destOf(o), opt);
    db.run('UPDATE orders SET ship_cents=?, ship_service=?, tax_cents=?, tax_label=?, tax_remitter=?, total_cents=?, fee_cents=?, net_cents=? WHERE id=?', t.ship_cents, t.ship_service, t.tax_cents, t.tax_label, t.tax_remitter, t.total_cents, t.fee_cents, t.net_cents, o.id);
    if (!payments.enabled) return res.redirect(`/checkout/${o.id}/test`);
    res.redirect(303, await payments.createCheckout({ ...o, ...t }));
  }));

  // Test mode only: stands in for the card payment page when Stripe is not configured.
  app.get('/checkout/:id/test', requireLogin, (req, res) => {
    const o = loadForCheckout(req, res); if (!o) return;
    if (payments.enabled || !o.ship_service) return res.redirect('/checkout/' + o.id);
    res.render('paytest', { title: 'Test payment', o });
  });
  app.post('/checkout/:id/test', requireLogin, (req, res) => {
    const o = loadForCheckout(req, res); if (!o) return;
    if (payments.enabled || !o.ship_service) return res.redirect('/checkout/' + o.id);
    market.markPaid(o.id, 'test_' + token(8));
    req.flash('Payment received (test mode). The seller has been told to ship.', 'good');
    res.redirect('/orders/' + o.id);
  });
  app.get('/checkout/:id/success', requireLogin, a(async (req, res) => {
    const o = db.get('SELECT * FROM orders WHERE id=? AND buyer_id=?', +req.params.id || 0, req.user.id);
    if (o && o.status === 'awaiting_payment' && payments.enabled && req.query.session_id) {
      const ref = await payments.verifySession(String(req.query.session_id), o);
      if (ref) market.markPaid(o.id, ref);
    }
    req.flash('Thanks. Your payment is being confirmed.', 'good');
    res.redirect('/orders/' + (o ? o.id : ''));
  }));

  /* ---------- Orders ---------- */
  const loadOrder = (req, res) => {
    const o = db.get('SELECT * FROM orders WHERE id=?', +req.params.id || 0), u = req.user;
    if (!o || !(u.role === 'admin' || o.buyer_id === u.id || o.seller_id === u.id)) { res.status(404).render('error', { title: 'Not found', message: 'That order does not exist.' }); return null; }
    o.isBuyer = o.buyer_id === u.id; o.isSeller = o.seller_id === u.id;
    return o;
  };

  app.get('/orders/:id', requireLogin, (req, res) => {
    const o = loadOrder(req, res); if (!o) return;
    res.render('order', {
      title: 'Order #' + o.id, o,
      buyer: db.get('SELECT id, name, email FROM users WHERE id=?', o.buyer_id), seller: db.get('SELECT id, name, shop_name, email FROM users WHERE id=?', o.seller_id),
      kase: db.get('SELECT * FROM cases WHERE order_id=? ORDER BY id DESC LIMIT 1', o.id),
      feedback: db.all('SELECT * FROM feedback WHERE order_id=?', o.id),
      trackingUrl: o.tracking ? shipping.trackingUrl(o.tracking) : null
    });
  });

  app.post('/orders/:id/cancel', requireLogin, (req, res) => {
    const o = loadOrder(req, res); if (!o) return;
    if (o.status !== 'awaiting_payment') req.flash('Only unpaid orders can be cancelled here. For a paid order, ask for a refund.', 'bad');
    else { market.cancelUnpaid(o, o.isSeller ? 'cancelled by the seller' : 'cancelled by the buyer'); req.flash('Order cancelled.', 'good'); }
    res.redirect('/orders/' + o.id);
  });

  app.post('/orders/:id/ship', requireLogin, (req, res) => {
    const o = loadOrder(req, res); if (!o) return;
    const tracking = clean(req.body.tracking, 40).replace(/\s/g, '');
    if (!o.isSeller || o.status !== 'paid') req.flash('This order cannot be marked as shipped.', 'bad');
    else if (!/^[A-Za-z0-9]{11,16}$/.test(tracking)) req.flash('Enter the Canada Post tracking number from your label or receipt (11 to 16 letters and digits).', 'bad');
    else { market.markShipped(o, tracking.toUpperCase()); req.flash('Marked as shipped. The buyer has the tracking number.', 'good'); }
    res.redirect('/orders/' + o.id);
  });

  app.post('/orders/:id/received', requireLogin, (req, res) => {
    const o = loadOrder(req, res); if (!o) return;
    if (o.isBuyer && o.status === 'shipped') { market.markDelivered(o); db.notify(o.seller_id, `The buyer confirmed delivery of "${o.title}".`, '/orders/' + o.id); req.flash('Thanks for confirming. Leave feedback for the seller below.', 'good'); }
    res.redirect('/orders/' + o.id);
  });

  app.post('/orders/:id/feedback', requireLogin, (req, res) => {
    const o = loadOrder(req, res); if (!o) return;
    const rating = parseInt(req.body.rating);
    if (!(o.isBuyer || o.isSeller) || !['paid', 'shipped', 'delivered', 'refunded'].includes(o.status) || ![1, 0, -1].includes(rating)) req.flash('Feedback cannot be left on this order yet.', 'bad');
    else if (db.get('SELECT 1 FROM feedback WHERE order_id=? AND from_id=?', o.id, req.user.id)) req.flash('You already left feedback for this order.', 'bad');
    else {
      const to = o.isBuyer ? o.seller_id : o.buyer_id;
      db.run('INSERT INTO feedback (order_id, from_id, to_id, rating, comment, created_at) VALUES (?,?,?,?,?,?)', o.id, req.user.id, to, rating, clean(req.body.comment, 300), Date.now());
      db.notify(to, `You received feedback on order #${o.id}.`, '/orders/' + o.id);
      req.flash('Feedback saved.', 'good');
    }
    res.redirect('/orders/' + o.id);
  });

  // Buyer reports a problem. The seller's funds for this order are frozen until Canado resolves it.
  app.post('/orders/:id/case', requireLogin, (req, res) => {
    const o = loadOrder(req, res); if (!o) return;
    const reason = clean(req.body.reason, 60), detail = clean(req.body.detail, 1000);
    const windowOpen = ['paid', 'shipped'].includes(o.status) || (o.status === 'delivered' && Date.now() - o.delivered_at < 30 * market.DAY);
    if (!o.isBuyer || !windowOpen) req.flash('A case cannot be opened on this order.', 'bad');
    else if (db.get("SELECT 1 FROM cases WHERE order_id=? AND status='open'", o.id)) req.flash('A case is already open for this order.', 'bad');
    else if (!reason || detail.length < 10) req.flash('Choose a reason and describe the problem.', 'bad');
    else {
      db.run('INSERT INTO cases (order_id, opener_id, reason, detail, created_at) VALUES (?,?,?,?,?)', o.id, req.user.id, reason, detail, Date.now());
      db.run("UPDATE orders SET funds_status='frozen' WHERE id=? AND funds_status IN ('held','available')", o.id);
      db.notify(o.seller_id, `The buyer opened a case on order #${o.id}: ${reason}. Reply to the buyer or refund the order.`, '/orders/' + o.id);
      for (const ad of admins()) db.notify(ad.id, `Case opened on order #${o.id}: ${reason}.`, '/admin?tab=cases');
      req.flash('Case opened. The seller has been notified and Canado will step in if you cannot resolve it together.', 'good');
    }
    res.redirect('/orders/' + o.id);
  });

  // Seller refunds the buyer in full.
  app.post('/orders/:id/refund', requireLogin, a(async (req, res) => {
    const o = loadOrder(req, res); if (!o) return;
    if (!(o.isSeller || req.user.role === 'admin') || !['paid', 'shipped', 'delivered'].includes(o.status)) req.flash('This order cannot be refunded.', 'bad');
    else {
      await market.refundOrder(o, o.isSeller ? 'Refunded by the seller.' : 'Refunded by Canado.');
      db.run("UPDATE cases SET status='refunded', resolution='Refunded', resolved_at=? WHERE order_id=? AND status='open'", Date.now(), o.id);
      req.flash('The buyer was refunded in full.', 'good');
    }
    res.redirect('/orders/' + o.id);
  }));

  /* ---------- Messages ---------- */
  app.get('/messages', requireLogin, (req, res) => {
    const id = req.user.id;
    const threads = db.all(`SELECT m.*, u.name, u.shop_name, (SELECT COUNT(*) FROM messages WHERE from_id=u.id AND to_id=? AND read_at IS NULL) unread
      FROM messages m JOIN users u ON u.id = CASE WHEN m.from_id=? THEN m.to_id ELSE m.from_id END
      WHERE m.id IN (SELECT MAX(id) FROM messages WHERE from_id=? OR to_id=? GROUP BY CASE WHEN from_id=? THEN to_id ELSE from_id END) ORDER BY m.id DESC`, id, id, id, id, id);
    res.render('messages', { title: 'Messages', threads, other: null, thread: [], item: null });
  });
  app.get('/messages/:uid', requireLogin, (req, res, next) => {
    const other = db.get('SELECT id, name, shop_name FROM users WHERE id=?', +req.params.uid || 0), id = req.user.id;
    if (!other || other.id === id) return next();
    db.run('UPDATE messages SET read_at=? WHERE from_id=? AND to_id=? AND read_at IS NULL', Date.now(), other.id, id);
    res.render('messages', {
      title: 'Messages with ' + (other.shop_name || other.name), threads: null, other,
      thread: db.all('SELECT m.*, l.title item_title FROM messages m LEFT JOIN listings l ON l.id=m.listing_id WHERE (m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?) ORDER BY m.id', id, other.id, other.id, id),
      item: req.query.item ? db.get('SELECT id, title FROM listings WHERE id=?', +req.query.item || 0) : null
    });
  });
  app.post('/messages/:uid', requireLogin, (req, res, next) => {
    const other = db.get('SELECT id FROM users WHERE id=?', +req.params.uid || 0), body = clean(req.body.body, 2000);
    if (!other || other.id === req.user.id) return next();
    if (body) db.run('INSERT INTO messages (listing_id, from_id, to_id, body, created_at) VALUES (?,?,?,?,?)', +req.body.item || null, req.user.id, other.id, body, Date.now());
    res.redirect('/messages/' + other.id);
  });
};
module.exports.readAddress = readAddress;
