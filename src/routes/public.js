const db = require('../db');
const market = require('../lib/market');
const shipping = require('../lib/shipping');
const geo = require('../lib/geo');
const { requireLogin } = require('../lib/auth');
const { parseCents, clean } = require('../lib/view');

const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const CARD = `l.*, (SELECT file FROM photos WHERE listing_id=l.id ORDER BY pos LIMIT 1) photo, u.shop_name, u.city seller_city, u.province seller_prov`;
const LIVE = `l.status='active' AND (l.ends_at IS NULL OR l.ends_at>?) AND u.seller_status='approved'`;

module.exports = app => {
  app.get('/', (req, res) => {
    const now = Date.now();
    res.render('home', {
      ending: db.all(`SELECT ${CARD} FROM listings l JOIN users u ON u.id=l.seller_id WHERE ${LIVE} AND l.format='auction' ORDER BY l.ends_at LIMIT 6`, now),
      fresh: db.all(`SELECT ${CARD} FROM listings l JOIN users u ON u.id=l.seller_id WHERE ${LIVE} ORDER BY l.created_at DESC LIMIT 12`, now),
      counts: db.get(`SELECT COUNT(*) listings, COUNT(DISTINCT l.seller_id) sellers FROM listings l JOIN users u ON u.id=l.seller_id WHERE ${LIVE}`, now)
    });
  });

  app.get('/search', (req, res) => {
    const f = { q: clean(req.query.q, 80), cat: clean(req.query.cat, 30), format: clean(req.query.format, 10), prov: clean(req.query.prov, 2), to: clean(req.query.to, 4), sort: clean(req.query.sort, 10) || 'new', min: parseCents(req.query.min), max: parseCents(req.query.max) };
    const where = [LIVE], p = [Date.now()];
    for (const word of f.q.split(/\s+/).filter(Boolean).slice(0, 6)) { where.push("(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')"); const w = '%' + word.replace(/[\\%_]/g, '\\$&') + '%'; p.push(w, w); }
    if (geo.CATEGORIES[f.cat]) { where.push('l.category=?'); p.push(f.cat); }
    if (f.format === 'auction' || f.format === 'fixed') { where.push('l.format=?'); p.push(f.format); }
    if (geo.PROVINCES[f.prov]) { where.push('u.province=?'); p.push(f.prov); }
    if (['ca', 'us', 'intl'].includes(f.to)) where.push(`l.ship_${f.to}=1`);
    if (f.min != null) { where.push('l.current_cents>=?'); p.push(f.min); }
    if (f.max != null) { where.push('l.current_cents<=?'); p.push(f.max); }
    const order = { new: 'l.created_at DESC', low: 'l.current_cents ASC', high: 'l.current_cents DESC', ending: 'CASE WHEN l.ends_at IS NULL THEN 1 ELSE 0 END, l.ends_at ASC', bids: 'l.bid_count DESC' }[f.sort] || 'l.created_at DESC';
    const page = Math.max(1, parseInt(req.query.page) || 1), size = 24;
    const total = db.get(`SELECT COUNT(*) n FROM listings l JOIN users u ON u.id=l.seller_id WHERE ${where.join(' AND ')}`, ...p).n;
    const rows = db.all(`SELECT ${CARD} FROM listings l JOIN users u ON u.id=l.seller_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, size, (page - 1) * size);
    const qs = new URLSearchParams(Object.entries(req.query).filter(([k, v]) => k !== 'page' && v)).toString();
    res.render('search', { title: f.q ? `"${f.q}"` : 'Browse listings', f, rows, total, page, pages: Math.ceil(total / size), qs });
  });

  app.get('/item/:id', a(async (req, res, next) => {
    const l = db.get('SELECT * FROM listings WHERE id=?', +req.params.id || 0);
    if (!l || l.status === 'removed') return next();
    const seller = db.get('SELECT * FROM users WHERE id=?', l.seller_id);
    const mine = req.user && req.user.id === l.seller_id;
    if (!mine) db.run('UPDATE listings SET views=views+1 WHERE id=?', l.id);
    const u = req.user || {};
    const dest = { country: clean(req.query.country, 2).toUpperCase() || u.ship_country || 'CA', postal: clean(req.query.postal, 12) || u.ship_postal || '' };
    if (!geo.COUNTRIES[dest.country]) dest.country = 'CA';
    let ship = null;
    if (dest.country !== 'CA' && dest.country !== 'US' || dest.postal) ship = await shipping.quote(l, seller, dest);
    res.render('item', {
      title: l.title, l, seller, mine, dest, ship,
      photos: db.all('SELECT * FROM photos WHERE listing_id=? ORDER BY pos', l.id),
      stats: market.sellerStats(seller.id),
      bids: db.all('SELECT b.amount_cents, b.created_at, b.bidder_id, u.name FROM bids b JOIN users u ON u.id=b.bidder_id WHERE b.listing_id=? ORDER BY b.id DESC LIMIT 15', l.id),
      watching: !!(req.user && db.get('SELECT 1 FROM watch WHERE user_id=? AND listing_id=?', req.user.id, l.id)),
      myOffer: req.user ? db.get("SELECT * FROM offers WHERE listing_id=? AND buyer_id=? ORDER BY id DESC LIMIT 1", l.id, req.user.id) : null
    });
  }));

  app.post('/item/:id/bid', requireLogin, (req, res) => {
    const r = market.placeBid(+req.params.id, req.user, parseCents(req.body.amount));
    req.flash(r.msg, r.ok ? 'good' : 'bad');
    res.redirect('/item/' + (+req.params.id));
  });
  app.post('/item/:id/buy', requireLogin, (req, res) => {
    const r = market.buyNow(+req.params.id, req.user, parseInt(req.body.qty) || 1);
    if (!r.ok) { req.flash(r.msg, 'bad'); return res.redirect('/item/' + (+req.params.id)); }
    res.redirect('/checkout/' + r.orderId);
  });
  app.post('/item/:id/offer', requireLogin, (req, res) => {
    const l = db.get('SELECT * FROM listings WHERE id=?', +req.params.id || 0), cents = parseCents(req.body.amount);
    const back = '/item/' + (+req.params.id);
    if (!l || !market.isLive(l) || !l.allow_offers || l.bid_count || l.seller_id === req.user.id) { req.flash('This listing is not accepting offers.', 'bad'); return res.redirect(back); }
    if (!cents || cents < 100) { req.flash('Enter an offer of at least $1.00.', 'bad'); return res.redirect(back); }
    if (db.get("SELECT COUNT(*) n FROM offers WHERE listing_id=? AND buyer_id=?", l.id, req.user.id).n >= 3) { req.flash('You have used your three offers on this listing.', 'bad'); return res.redirect(back); }
    db.run("UPDATE offers SET status='expired' WHERE listing_id=? AND buyer_id=? AND status='pending'", l.id, req.user.id);
    db.run('INSERT INTO offers (listing_id, buyer_id, amount_cents, created_at) VALUES (?,?,?,?)', l.id, req.user.id, cents, Date.now());
    db.notify(l.seller_id, `New offer of $${(cents / 100).toFixed(2)} on "${l.title}".`, '/sell/hub?tab=offers');
    req.flash('Offer sent. The seller will accept or decline it.', 'good');
    res.redirect(back);
  });
  app.post('/item/:id/watch', requireLogin, (req, res) => {
    const id = +req.params.id || 0;
    if (db.get('SELECT 1 FROM watch WHERE user_id=? AND listing_id=?', req.user.id, id)) db.run('DELETE FROM watch WHERE user_id=? AND listing_id=?', req.user.id, id);
    else if (db.get('SELECT id FROM listings WHERE id=?', id)) db.run('INSERT INTO watch (user_id, listing_id) VALUES (?,?)', req.user.id, id);
    res.redirect(req.body.back === 'account' ? '/account?tab=watch' : '/item/' + id);
  });

  app.get('/user/:id', (req, res, next) => {
    const seller = db.get("SELECT * FROM users WHERE id=? AND seller_status='approved'", +req.params.id || 0);
    if (!seller) return next();
    res.render('profile', {
      title: seller.shop_name, seller, stats: market.sellerStats(seller.id),
      listings: db.all(`SELECT ${CARD} FROM listings l JOIN users u ON u.id=l.seller_id WHERE ${LIVE} AND l.seller_id=? ORDER BY l.created_at DESC LIMIT 48`, Date.now(), seller.id),
      feedback: db.all('SELECT f.*, u.name, o.title FROM feedback f JOIN users u ON u.id=f.from_id JOIN orders o ON o.id=f.order_id WHERE f.to_id=? ORDER BY f.id DESC LIMIT 30', seller.id)
    });
  });

  for (const [url, page, title] of [['/fees', 'fees', 'Fees and payouts'], ['/shipping', 'shipping', 'Shipping with Canada Post'], ['/switch', 'switch', 'Switch from eBay'], ['/terms', 'terms', 'User agreement']])
    app.get(url, (req, res) => res.render('page', { title, page }));
};
