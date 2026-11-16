// Optional demo data so the site is not empty on first look. Usage: npm run seed
// Creates one demo seller, one demo buyer and a handful of listings. Delete the data folder to start clean.
require('../src/server');
const db = require('../src/db');
const { hashPassword } = require('../src/lib/auth');

if (db.get("SELECT id FROM users WHERE email='seller@example.com'")) { console.log('Demo data already present.'); process.exit(0); }
const now = Date.now(), DAY = 86400e3, pw = hashPassword('demo-password');
const seller = db.run(`INSERT INTO users (email, pass_hash, name, created_at, seller_status, shop_name, legal_name, phone, addr1, city, province, postal, payout_details)
  VALUES ('seller@example.com', ?, 'Demo Seller', ?, 'approved', 'Northern Finds', 'Demo Seller', '905 555 0100', '100 Demo Street', 'Richmond Hill', 'ON', 'L4C 1A1', 'seller@example.com')`, pw, now).lastInsertRowid;
db.run("INSERT INTO users (email, pass_hash, name, created_at) VALUES ('buyer@example.com', ?, 'Demo Buyer', ?)", pw, now);

const items = [
  ['Hockey card lot, early 1970s, 42 cards', 'cards', 'Used, good', 'auction', 2500, 12000, 3, 200],
  ['35 mm film camera with 50 mm lens, tested', 'cameras', 'Used, good', 'auction', 9900, null, 5, 900],
  ['Commemorative circulation coin set, 24 coins', 'coins', 'Used, like new', 'auction', 1500, null, 1, 300],
  ['Vintage wool point blanket, striped', 'home', 'Vintage', 'fixed', 21000, null, null, 2200],
  ['Refurbished 14-inch business laptop, 16 GB', 'computers', 'Refurbished', 'fixed', 48900, null, null, 2400],
  ['Hand-thrown stoneware mugs, set of 4', 'handmade', 'New', 'fixed', 9600, null, null, 1800],
  ['20 V cordless drill kit with two batteries', 'tools', 'Used, like new', 'fixed', 11500, null, null, 3200],
  ['Aluminum snowshoes, 25 in, with poles', 'outdoors', 'Used, good', 'fixed', 13000, null, null, 2600],
  ['End-grain maple cutting board, 14 x 18 in', 'handmade', 'New', 'fixed', 7400, null, null, 2100],
  ['Senior hockey skates, size 9, sharpened', 'sports', 'Used, good', 'fixed', 14000, null, null, 2300]
];
items.forEach(([title, category, condition, format, price, bin, days, weight], i) => {
  db.run(`INSERT INTO listings (seller_id, title, description, category, condition, format, price_cents, bin_cents, current_cents, quantity, allow_offers, ends_at, weight_g, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, seller, title, 'Demo listing. Replace with your own description.', category, condition, format, price, bin, price, format === 'fixed' ? 3 : 1, format === 'fixed' ? 1 : 0, days ? now + days * DAY : null, weight, now - i * 60000);
});
console.log('Demo data created. Sign in as seller@example.com or buyer@example.com with password "demo-password".');
process.exit(0);
