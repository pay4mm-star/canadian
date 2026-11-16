const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const market = require('../lib/market');
const payments = require('../lib/payments');
const geo = require('../lib/geo');
const { requireLogin, requireSeller, token } = require('../lib/auth');
const { parseCents, clean } = require('../lib/view');

const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const uploadDir = path.join(config.dataDir, 'uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const photos = multer({
  storage: multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, token(12) + EXT[file.mimetype]) }),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, !!EXT[file.mimetype])
}).array('photos', 8);
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');

// multipart forms carry the CSRF token in the query string (checked in server.js) and their fields arrive after multer runs.
function readListing(b, existing) {
  const e = existing || {};
  const v = {
    title: clean(b.title, 80), description: clean(b.description, 8000), category: clean(b.category, 30), condition: clean(b.condition, 40),
    format: e.format || (b.format === 'auction' ? 'auction' : 'fixed'),
    price_cents: parseCents(b.price), bin_cents: b.bin ? parseCents(b.bin) : null, reserve_cents: b.reserve ? parseCents(b.reserve) : null,
    quantity: Math.max(1, Math.min(9999, parseInt(b.quantity) || 1)), allow_offers: b.allow_offers ? 1 : 0,
    weight_g: Math.round(parseFloat(b.weight_kg) * 1000), len_cm: parseInt(b.len_cm) || null, wid_cm: parseInt(b.wid_cm) || null, hgt_cm: parseInt(b.hgt_cm) || null,
    ship_mode: ['calculated', 'flat', 'free'].includes(b.ship_mode) ? b.ship_mode : 'calculated',
    flat_ca_cents: b.flat_ca !== '' && b.flat_ca != null ? parseCents(b.flat_ca) : null, flat_us_cents: b.flat_us !== '' && b.flat_us != null ? parseCents(b.flat_us) : null, flat_intl_cents: b.flat_intl !== '' && b.flat_intl != null ? parseCents(b.flat_intl) : null,
    ship_ca: b.ship_ca ? 1 : 0, ship_us: b.ship_us ? 1 : 0, ship_intl: b.ship_intl ? 1 : 0,
    handling_days: Math.max(1, Math.min(10, parseInt(b.handling_days) || 2)), duration: [1, 3, 5, 7, 10].includes(+b.duration) ? +b.duration : 7
  };
  let error = null;
  if (v.title.length < 5) error = 'Write a title of at least 5 characters.';
  else if (!geo.CATEGORIES[v.category]) error = 'Choose a category.';
  else if (!geo.CONDITIONS.includes(v.condition)) error = 'Choose a condition.';
  else if (!v.price_cents || v.price_cents < 99) error = 'Enter a price of at least $0.99.';
  else if (v.format === 'auction' && v.bin_cents != null && v.bin_cents <= v.price_cents) error = 'The Buy It Now price must be higher than the starting bid.';
  else if (v.format === 'auction' && v.reserve_cents != null && v.reserve_cents < v.price_cents) error = 'The reserve price cannot be lower than the starting bid.';
  else if (!(v.weight_g > 0) || v.weight_g > 30000) error = 'Enter the packed weight in kilograms (Canada Post accepts parcels up to 30 kg).';
  else if (!v.ship_ca && !v.ship_us && !v.ship_intl) error = 'Choose at least one destination you will ship to.';
  else if (v.ship_mode === 'flat' && ((v.ship_ca && v.flat_ca_cents == null) || (v.ship_us && v.flat_us_cents == null) || (v.ship_intl && v.flat_intl_cents == null))) error = 'Enter a flat shipping rate for each destination you ship to.';
  if (v.format === 'auction') { v.quantity = 1; v.allow_offers = v.allow_offers && !v.reserve_cents ? 1 : 0; } else { v.bin_cents = null; v.reserve_cents = null; }
  return { v, error };
}
const formOf = l => ({ ...l, price: l.price_cents != null ? (l.price_cents / 100).toFixed(2) : '', bin: l.bin_cents ? (l.bin_cents / 100).toFixed(2) : '', reserve: l.reserve_cents ? (l.reserve_cents / 100).toFixed(2) : '', weight_kg: l.weight_g ? l.weight_g / 1000 : '', flat_ca: l.flat_ca_cents != null ? (l.flat_ca_cents / 100).toFixed(2) : '', flat_us: l.flat_us_cents != null ? (l.flat_us_cents / 100).toFixed(2) : '', flat_intl: l.flat_intl_cents != null ? (l.flat_intl_cents / 100).toFixed(2) : '' });
const COLS = ['title', 'description', 'category', 'condition', 'price_cents', 'bin_cents', 'reserve_cents', 'quantity', 'allow_offers', 'weight_g', 'len_cm', 'wid_cm', 'hgt_cm', 'ship_mode', 'flat_ca_cents', 'flat_us_cents', 'flat_intl_cents', 'ship_ca', 'ship_us', 'ship_intl', 'handling_days'];

function insertListing(sellerId, v) {
  const now = Date.now(), ends = v.format === 'auction' ? now + v.duration * market.DAY : null;
  const cols = [...COLS, 'seller_id', 'format', 'current_cents', 'ends_at', 'created_at'];
  const vals = [...COLS.map(c => v[c]), sellerId, v.format, v.price_cents, ends, now];
  return db.run(`INSERT INTO listings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...vals).lastInsertRowid;
}

// Minimal CSV parser (quoted fields, embedded commas and newlines).
function parseCsv(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

module.exports = app => {
  app.get('/sell', (req, res) => res.redirect(req.user && req.user.seller_status === 'approved' ? '/sell/hub' : '/sell/apply'));

  /* ---------- Becoming a seller: Canadian sellers only ---------- */
  app.get('/sell/apply', requireLogin, (req, res) => res.render('sell_apply', { title: 'Sell on Canado', form: req.user }));
  app.post('/sell/apply', requireLogin, (req, res) => {
    if (['approved', 'suspended'].includes(req.user.seller_status)) return res.redirect('/sell');
    const b = req.body;
    const f = { legal_name: clean(b.legal_name, 100), shop_name: clean(b.shop_name, 40), phone: clean(b.phone, 20), addr1: clean(b.addr1, 120), city: clean(b.city, 80), province: clean(b.province, 2).toUpperCase(), postal: geo.normalizePostal(b.postal), gst_registered: b.gst_registered ? 1 : 0, gst_number: clean(b.gst_number, 20).toUpperCase().replace(/\s/g, ''), ebay_user: clean(b.ebay_user, 60) };
    let error = null;
    if (f.legal_name.length < 3) error = 'Enter your legal name or registered business name.';
    else if (f.shop_name.length < 3) error = 'Choose a shop name of at least 3 characters.';
    else if (db.get('SELECT id FROM users WHERE shop_name=? COLLATE NOCASE AND id<>?', f.shop_name, req.user.id)) error = 'That shop name is taken. Choose another.';
    else if (f.phone.replace(/\D/g, '').replace(/^1/, '').length !== 10) error = 'Enter a Canadian phone number with area code.';
    else if (!f.addr1 || !f.city) error = 'Enter the street address and city you ship from.';
    else if (!geo.PROVINCES[f.province]) error = 'Choose your province or territory.';
    else if (!f.postal || !geo.postalMatchesProvince(f.postal, f.province)) error = 'Enter a valid Canadian postal code for that province, like L4C 1A1.';
    else if (f.gst_registered && !/^\d{9}(RT\d{4})?$/.test(f.gst_number)) error = 'Enter your 9-digit business number, or the full GST/HST account like 123456789RT0001.';
    else if (!b.attest) error = 'Confirm that you live in or operate from Canada and ship from Canada.';
    if (error) return res.status(400).render('sell_apply', { title: 'Sell on Canado', form: { ...req.user, ...f, postal: f.postal || clean(b.postal, 10) }, error });
    const status = config.autoApproveSellers ? 'approved' : 'pending';
    db.run('UPDATE users SET seller_status=?, legal_name=?, shop_name=?, phone=?, addr1=?, city=?, province=?, postal=?, gst_registered=?, gst_number=?, ebay_user=? WHERE id=?', status, f.legal_name, f.shop_name, f.phone, f.addr1, f.city, f.province, f.postal, f.gst_registered, f.gst_registered ? f.gst_number : null, f.ebay_user || null, req.user.id);
    if (status === 'pending') for (const ad of db.all("SELECT id FROM users WHERE role='admin'")) db.notify(ad.id, `New seller application: ${f.shop_name} (${f.city}, ${f.province}).`, '/admin?tab=sellers');
    req.flash(status === 'approved' ? 'You are approved to sell. Create your first listing.' : 'Application received. We review new sellers before they can list, usually within one business day.', 'good');
    res.redirect(status === 'approved' ? '/sell/hub' : '/sell/apply');
  });

  /* ---------- Seller hub ---------- */
  app.get('/sell/hub', requireSeller, (req, res) => {
    const id = req.user.id, tab = ['active', 'orders', 'ended', 'offers'].includes(req.query.tab) ? req.query.tab : 'active';
    const data = {};
    if (tab === 'active') data.listings = db.all("SELECT l.*, (SELECT COUNT(*) FROM watch WHERE listing_id=l.id) watchers FROM listings l WHERE seller_id=? AND status='active' ORDER BY id DESC", id);
    if (tab === 'ended') data.listings = db.all("SELECT l.*, 0 watchers FROM listings l WHERE seller_id=? AND status IN ('ended','sold','cancelled','removed') ORDER BY id DESC LIMIT 200", id);
    if (tab === 'orders') data.orders = db.all('SELECT o.*, u.name buyer_name FROM orders o JOIN users u ON u.id=o.buyer_id WHERE o.seller_id=? ORDER BY o.id DESC LIMIT 200', id);
    if (tab === 'offers') data.offers = db.all("SELECT o.*, l.title, l.price_cents, u.name buyer_name FROM offers o JOIN listings l ON l.id=o.listing_id JOIN users u ON u.id=o.buyer_id WHERE l.seller_id=? ORDER BY o.status='pending' DESC, o.id DESC LIMIT 100", id);
    res.render('sell_hub', {
      title: 'Seller hub', tab, ...data, balance: market.balance(id), stats: market.sellerStats(id),
      toShip: db.get("SELECT COUNT(*) n FROM orders WHERE seller_id=? AND status='paid'", id).n,
      pendingOffers: db.get("SELECT COUNT(*) n FROM offers o JOIN listings l ON l.id=o.listing_id WHERE l.seller_id=? AND o.status='pending'", id).n
    });
  });

  app.get('/sell/new', requireSeller, (req, res) => res.render('sell_form', { title: 'Create a listing', l: { format: 'fixed', quantity: 1, ship_mode: 'calculated', ship_ca: 1, ship_us: 1, ship_intl: 1, handling_days: 2, duration: 7 }, photos: [], editing: false }));
  app.post('/sell/new', requireSeller, photos, (req, res) => {
    const { v, error } = readListing(req.body);
    if (error) { for (const f of req.files || []) fs.unlink(f.path, () => {}); return res.status(400).render('sell_form', { title: 'Create a listing', l: { ...req.body, ...v, price: req.body.price }, photos: [], editing: false, error: error + (req.files && req.files.length ? ' Add your photos again.' : '') }); }
    const id = insertListing(req.user.id, v);
    (req.files || []).forEach((f, i) => db.run('INSERT INTO photos (listing_id, file, pos) VALUES (?,?,?)', id, f.filename, i));
    req.flash('Your listing is live.', 'good');
    res.redirect('/item/' + id);
  });

  const own = (req, res) => {
    const l = db.get('SELECT * FROM listings WHERE id=? AND seller_id=?', +req.params.id || 0, req.user.id);
    if (!l) res.status(404).render('error', { title: 'Not found', message: 'That listing does not exist.' });
    return l;
  };
  app.get('/sell/edit/:id', requireSeller, (req, res) => {
    const l = own(req, res); if (!l) return;
    res.render('sell_form', { title: 'Edit listing', l: formOf(l), photos: db.all('SELECT * FROM photos WHERE listing_id=? ORDER BY pos', l.id), editing: true });
  });
  app.post('/sell/edit/:id', requireSeller, photos, (req, res) => {
    const l = own(req, res); if (!l) return;
    const bail = msg => { for (const f of req.files || []) fs.unlink(f.path, () => {}); req.flash(msg, 'bad'); res.redirect('/sell/edit/' + l.id); };
    if (l.status !== 'active') return bail('Only active listings can be edited. Relist it instead.');
    const { v, error } = readListing(req.body, l);
    if (error) return bail(error);
    if (l.bid_count && (v.price_cents !== l.price_cents || v.bin_cents !== l.bin_cents || v.reserve_cents !== l.reserve_cents)) return bail('Prices cannot be changed once an auction has bids.');
    if (v.quantity < l.sold_qty + 1) return bail(`Quantity must be at least ${l.sold_qty + 1} because ${l.sold_qty} already sold.`);
    db.run(`UPDATE listings SET ${COLS.map(c => c + '=?').join(',')}, current_cents=? WHERE id=?`, ...COLS.map(c => v[c]), l.bid_count ? l.current_cents : v.price_cents, l.id);
    for (const pid of [].concat(req.body.remove_photo || [])) {
      const ph = db.get('SELECT * FROM photos WHERE id=? AND listing_id=?', +pid || 0, l.id);
      if (ph) { db.run('DELETE FROM photos WHERE id=?', ph.id); fs.unlink(path.join(uploadDir, path.basename(ph.file)), () => {}); }
    }
    const have = db.get('SELECT COUNT(*) n, COALESCE(MAX(pos),-1) p FROM photos WHERE listing_id=?', l.id);
    (req.files || []).forEach((f, i) => { if (have.n + i < 8) db.run('INSERT INTO photos (listing_id, file, pos) VALUES (?,?,?)', l.id, f.filename, have.p + 1 + i); else fs.unlink(f.path, () => {}); });
    req.flash('Listing updated.', 'good');
    res.redirect('/item/' + l.id);
  });

  app.post('/sell/end/:id', requireSeller, (req, res) => {
    const l = own(req, res); if (!l) return;
    if (l.status !== 'active') req.flash('That listing is not active.', 'bad');
    else if (l.format === 'auction' && l.bid_count) req.flash('An auction with bids cannot be ended early.', 'bad');
    else { db.run("UPDATE listings SET status='cancelled' WHERE id=?", l.id); db.run("UPDATE offers SET status='expired' WHERE listing_id=? AND status='pending'", l.id); req.flash('Listing ended.', 'good'); }
    res.redirect('/sell/hub');
  });
  app.post('/sell/relist/:id', requireSeller, (req, res) => {
    const l = own(req, res); if (!l) return;
    if (!['ended', 'cancelled', 'sold'].includes(l.status)) { req.flash('That listing is still active.', 'bad'); return res.redirect('/sell/hub'); }
    const id = insertListing(req.user.id, { ...l, quantity: l.format === 'fixed' ? Math.max(1, l.quantity - l.sold_qty) : 1, duration: 7 });
    for (const p of db.all('SELECT * FROM photos WHERE listing_id=? ORDER BY pos', l.id)) {
      const copy = token(12) + path.extname(p.file);
      try { fs.copyFileSync(path.join(uploadDir, path.basename(p.file)), path.join(uploadDir, copy)); db.run('INSERT INTO photos (listing_id, file, pos) VALUES (?,?,?)', id, copy, p.pos); } catch (e) { /* photo missing on disk */ }
    }
    req.flash('Relisted. Review the details and make any changes.', 'good');
    res.redirect('/sell/edit/' + id);
  });

  app.post('/sell/offers/:id/:action', requireSeller, (req, res) => {
    if (req.params.action === 'accept') { const r = market.acceptOffer(+req.params.id, req.user); req.flash(r.ok ? 'Offer accepted. The buyer has been asked to pay.' : r.msg, r.ok ? 'good' : 'bad'); }
    else {
      const o = db.get("SELECT o.*, l.seller_id, l.title FROM offers o JOIN listings l ON l.id=o.listing_id WHERE o.id=? AND o.status='pending'", +req.params.id || 0);
      if (o && o.seller_id === req.user.id) { db.run("UPDATE offers SET status='declined' WHERE id=?", o.id); db.notify(o.buyer_id, `Your offer on "${o.title}" was declined.`, '/item/' + o.listing_id); req.flash('Offer declined.', 'good'); }
    }
    res.redirect('/sell/hub?tab=offers');
  });

  /* ---------- Payouts ---------- */
  app.get('/sell/payouts', requireSeller, a(async (req, res) => {
    if (req.query.connected) await payments.refreshConnect(req.user).catch(e => console.error('[connect]', e.message));
    const id = req.user.id;
    res.render('sell_payouts', {
      title: 'Payouts', seller: db.get('SELECT * FROM users WHERE id=?', id), balance: market.balance(id), isNew: market.isNewSeller(id), cfg: config, stripeOn: payments.enabled,
      payouts: db.all('SELECT * FROM payouts WHERE seller_id=? ORDER BY id DESC LIMIT 50', id),
      orders: db.all("SELECT * FROM orders WHERE seller_id=? AND funds_status<>'none' ORDER BY id DESC LIMIT 100", id),
      adjustments: db.all('SELECT * FROM adjustments WHERE seller_id=? ORDER BY id DESC LIMIT 50', id)
    });
  }));
  app.post('/sell/payouts', requireSeller, (req, res) => {
    const schedule = ['daily', 'weekly', 'biweekly', 'monthly'].includes(req.body.schedule) ? req.body.schedule : 'daily';
    const email = clean(req.body.payout_details, 120).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { req.flash('Enter a valid Interac e-Transfer email address.', 'bad'); return res.redirect('/sell/payouts'); }
    db.run('UPDATE users SET payout_schedule=?, payout_details=? WHERE id=?', schedule, email || null, req.user.id);
    req.flash('Payout settings saved.', 'good');
    res.redirect('/sell/payouts');
  });
  app.post('/sell/payouts/connect', requireSeller, a(async (req, res) => {
    if (!payments.enabled) { req.flash('Bank payouts are not switched on yet.', 'bad'); return res.redirect('/sell/payouts'); }
    res.redirect(303, await payments.connectLink(req.user));
  }));

  /* ---------- Import listings from an eBay CSV export ---------- */
  app.get('/sell/import', requireSeller, (req, res) => res.render('sell_import', { title: 'Import from eBay', result: null }));
  app.post('/sell/import', requireSeller, csvUpload, (req, res) => {
    if (!req.file) { req.flash('Choose a CSV file to upload.', 'bad'); return res.redirect('/sell/import'); }
    const rows = parseCsv(req.file.buffer.toString('utf8'));
    const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
    const col = (...names) => { for (const n of names) { const i = head.findIndex(h => h === n); if (i >= 0) return i; } for (const n of names) { const i = head.findIndex(h => h.includes(n)); if (i >= 0) return i; } return -1; };
    const ix = { title: col('title', 'item title'), price: col('current price', 'start price', 'price'), qty: col('available quantity', 'quantity'), cond: col('condition'), desc: col('description'), format: col('format', 'listing type') };
    if (ix.title < 0 || ix.price < 0) return res.status(400).render('sell_import', { title: 'Import from eBay', result: { error: 'This file needs a "Title" column and a price column ("Start price", "Current price" or "Price"). Found: ' + head.slice(0, 12).join(', ') } });
    let made = 0; const skipped = [];
    for (const [n, r] of rows.slice(0, 2000).entries()) {
      const title = clean(r[ix.title], 80), price = parseCents(String(r[ix.price] || '').replace(/[A-Za-z]/g, ''));
      if (title.length < 5 || !price || price < 99) { skipped.push(`Row ${n + 2}: ${title ? 'no valid price' : 'no title'}`); continue; }
      const condRaw = ix.cond >= 0 ? String(r[ix.cond]).toLowerCase() : '';
      const condition = condRaw.includes('new') ? 'New' : condRaw.includes('refurb') ? 'Refurbished' : condRaw.includes('parts') ? 'For parts or not working' : 'Used, good';
      insertListing(req.user.id, { title, description: ix.desc >= 0 ? clean(r[ix.desc], 8000) : '', category: 'other', condition, format: 'fixed', price_cents: price, bin_cents: null, reserve_cents: null, quantity: Math.max(1, Math.min(9999, parseInt(ix.qty >= 0 ? r[ix.qty] : 1) || 1)), allow_offers: 0, weight_g: 500, len_cm: null, wid_cm: null, hgt_cm: null, ship_mode: 'calculated', flat_ca_cents: null, flat_us_cents: null, flat_intl_cents: null, ship_ca: 1, ship_us: 1, ship_intl: 1, handling_days: 2 });
      made++;
    }
    res.render('sell_import', { title: 'Import from eBay', result: { made, skipped: skipped.slice(0, 20), more: Math.max(0, skipped.length - 20) } });
  });
};
