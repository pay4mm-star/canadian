const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
const db = new Database(path.join(config.dataDir, 'canado.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// All money is stored as integer cents (CAD). All times are epoch milliseconds.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL,
  ship_name TEXT, ship_addr1 TEXT, ship_addr2 TEXT, ship_city TEXT, ship_region TEXT, ship_postal TEXT, ship_country TEXT,
  seller_status TEXT NOT NULL DEFAULT 'none', shop_name TEXT, legal_name TEXT, phone TEXT,
  addr1 TEXT, city TEXT, province TEXT, postal TEXT, gst_registered INTEGER NOT NULL DEFAULT 0, gst_number TEXT,
  ebay_user TEXT, payout_schedule TEXT NOT NULL DEFAULT 'daily', payout_details TEXT, stripe_account TEXT,
  stripe_ready INTEGER NOT NULL DEFAULT 0, reset_token TEXT, reset_expires INTEGER
);
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL, condition TEXT NOT NULL, format TEXT NOT NULL,
  price_cents INTEGER NOT NULL, bin_cents INTEGER, reserve_cents INTEGER,
  current_cents INTEGER NOT NULL, bid_count INTEGER NOT NULL DEFAULT 0, high_bidder_id INTEGER, high_max_cents INTEGER,
  quantity INTEGER NOT NULL DEFAULT 1, sold_qty INTEGER NOT NULL DEFAULT 0, allow_offers INTEGER NOT NULL DEFAULT 0,
  ends_at INTEGER, status TEXT NOT NULL DEFAULT 'active',
  weight_g INTEGER NOT NULL DEFAULT 500, len_cm INTEGER, wid_cm INTEGER, hgt_cm INTEGER,
  ship_mode TEXT NOT NULL DEFAULT 'calculated', flat_ca_cents INTEGER, flat_us_cents INTEGER, flat_intl_cents INTEGER,
  ship_ca INTEGER NOT NULL DEFAULT 1, ship_us INTEGER NOT NULL DEFAULT 1, ship_intl INTEGER NOT NULL DEFAULT 1,
  handling_days INTEGER NOT NULL DEFAULT 2, views INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_status ON listings(status, ends_at);
CREATE INDEX IF NOT EXISTS listings_seller ON listings(seller_id);
CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE, file TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bids (id INTEGER PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES listings(id), bidder_id INTEGER NOT NULL REFERENCES users(id), max_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES listings(id), buyer_id INTEGER NOT NULL REFERENCES users(id), amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS watch (user_id INTEGER NOT NULL, listing_id INTEGER NOT NULL, PRIMARY KEY (user_id, listing_id));
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES listings(id), seller_id INTEGER NOT NULL REFERENCES users(id), buyer_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, source TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
  item_cents INTEGER NOT NULL, ship_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
  fee_cents INTEGER NOT NULL DEFAULT 0, net_cents INTEGER NOT NULL DEFAULT 0, tax_label TEXT, tax_remitter TEXT,
  ship_service TEXT, ship_name TEXT, ship_addr1 TEXT, ship_addr2 TEXT, ship_city TEXT, ship_region TEXT, ship_postal TEXT, ship_country TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_payment', pay_ref TEXT, paid_at INTEGER, shipped_at INTEGER, tracking TEXT, delivered_at INTEGER,
  funds_status TEXT NOT NULL DEFAULT 'none', available_at INTEGER, payout_id INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_seller ON orders(seller_id, funds_status);
CREATE INDEX IF NOT EXISTS orders_buyer ON orders(buyer_id);
CREATE TABLE IF NOT EXISTS payouts (id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL REFERENCES users(id), amount_cents INTEGER NOT NULL, status TEXT NOT NULL, method TEXT NOT NULL, reference TEXT, created_at INTEGER NOT NULL, sent_at INTEGER);
CREATE TABLE IF NOT EXISTS adjustments (id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL REFERENCES users(id), order_id INTEGER, amount_cents INTEGER NOT NULL, reason TEXT NOT NULL, payout_id INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, listing_id INTEGER, from_id INTEGER NOT NULL REFERENCES users(id), to_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
CREATE INDEX IF NOT EXISTS messages_to ON messages(to_id, read_at);
CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, rating INTEGER NOT NULL, comment TEXT, created_at INTEGER NOT NULL, UNIQUE(order_id, from_id));
CREATE TABLE IF NOT EXISTS cases (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), opener_id INTEGER NOT NULL, reason TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, body TEXT NOT NULL, link TEXT, created_at INTEGER NOT NULL, read_at INTEGER);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);

const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
  tx: fn => db.transaction(fn)(),
  meta: k => (db.prepare('SELECT v FROM meta WHERE k=?').get(k) || {}).v,
  setMeta: (k, v) => db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)),
  notify: (userId, body, link) => db.prepare('INSERT INTO notifications (user_id, body, link, created_at) VALUES (?,?,?,?)').run(userId, body, link || null, Date.now())
};

module.exports = { db, ...q };
