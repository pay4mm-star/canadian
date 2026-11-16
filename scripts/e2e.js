// End-to-end test: runs the whole buy, sell, ship and payout cycle against a throwaway database.
// Usage: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canado-test-'));
Object.assign(process.env, { DATA_DIR: dir, ADMIN_EMAIL: 'admin@test.ca', ADMIN_PASSWORD: 'admin-pass-1', STRIPE_SECRET_KEY: '', CANADAPOST_API_USER: '', AUTO_APPROVE_SELLERS: 'false', NODE_ENV: 'test', FEE_BPS: '300', FEE_ON_SHIPPING: 'true' });

const app = require('../src/server');
const db = require('../src/db');
const market = require('../src/lib/market');

let base, passed = 0;
const ok = (cond, name) => { assert.ok(cond, name); passed++; console.log('  ok  ' + name); };

class Client {
  constructor() { this.cookies = {}; }
  async req(method, url, body, multipart) {
    const headers = { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload;
    if (body && multipart) { payload = body; } else if (body) { payload = new URLSearchParams({ _csrf: this.csrf || '', ...body }).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([a-f0-9]+)"/); if (m) this.csrf = m[1];
    return { status: res.status, text, location: res.headers.get('location') };
  }
  get(url) { return this.req('GET', url); }
  post(url, body) { return this.req('POST', url, body); }
  async register(name, email) { await this.get('/register'); const r = await this.post('/register', { name, email, password: 'password-1' }); assert.equal(r.status, 302); return this; }
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const listingForm = (fields, withPhoto) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, String(v)); if (withPhoto) f.append('photos', new Blob([PNG], { type: 'image/png' }), 'a.png'); return f; };
const orderRow = id => db.get('SELECT * FROM orders WHERE id=?', id);

(async () => {
  const server = app.listen(0);
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    console.log('Public pages');
    const anon = new Client();
    for (const p of ['/', '/search', '/fees', '/shipping', '/switch', '/terms', '/login', '/register', '/forgot']) ok((await anon.get(p)).status === 200, 'GET ' + p);
    ok((await anon.get('/nope')).status === 404, 'unknown page is 404');
    ok((await anon.get('/account')).status === 302, 'account requires sign-in');
    ok((await anon.get('/admin')).status === 404, 'admin hidden from visitors');
    ok((await new Client().req('POST', '/login', { email: 'x', password: 'y' })).status === 403, 'POST without CSRF token is refused');

    console.log('Seller onboarding (Canadian only)');
    const seller = await new Client().register('Sam Seller', 'seller@test.ca');
    const apply = { legal_name: 'Sam Seller Inc', shop_name: 'Maple Finds', phone: '905 555 0123', addr1: '1 Yonge St', city: 'Richmond Hill', province: 'ON', postal: 'L4C 1A1', attest: 'on' };
    await seller.get('/sell/apply');
    ok((await seller.post('/sell/apply', { ...apply, postal: '90210' })).status === 400, 'US ZIP rejected for sellers');
    ok((await seller.post('/sell/apply', { ...apply, postal: 'V6B 1A1' })).status === 400, 'postal code must match province');
    ok((await seller.post('/sell/apply', apply)).status === 302, 'valid Canadian application accepted');
    ok(db.get("SELECT seller_status s FROM users WHERE email='seller@test.ca'").s === 'pending', 'seller is pending until approved');
    ok((await seller.get('/sell/new')).location === '/sell/apply', 'pending seller cannot list');

    const admin = new Client(); await admin.get('/login');
    ok((await admin.post('/login', { email: 'admin@test.ca', password: 'admin-pass-1' })).status === 302, 'admin signs in');
    const sellerId = db.get("SELECT id FROM users WHERE email='seller@test.ca'").id;
    await admin.get('/admin?tab=sellers');
    await admin.post(`/admin/sellers/${sellerId}/approve`, {});
    ok(db.get('SELECT seller_status s FROM users WHERE id=?', sellerId).s === 'approved', 'admin approves seller');

    console.log('Listings');
    const baseListing = { title: 'Vintage wool blanket', description: 'Clean, no holes.', category: 'home', condition: 'Vintage', weight_kg: '1.5', handling_days: 2, ship_ca: 'on', ship_us: 'on', ship_intl: 'on', ship_mode: 'calculated' };
    await seller.get('/sell/new');
    let r = await seller.req('POST', '/sell/new?_csrf=' + seller.csrf, listingForm({ ...baseListing, format: 'fixed', price: '40.00', quantity: 5, allow_offers: 'on' }, true), true);
    ok(r.status === 302 && /\/item\/\d+/.test(r.location), 'fixed-price listing created with photo');
    const fixedId = +r.location.split('/').pop();
    ok(db.get('SELECT COUNT(*) n FROM photos WHERE listing_id=?', fixedId).n === 1, 'photo saved');
    r = await seller.req('POST', '/sell/new?_csrf=' + seller.csrf, listingForm({ ...baseListing, title: 'Hockey card lot 1972', category: 'cards', format: 'auction', price: '10.00', bin: '100.00', duration: 7, weight_kg: '0.2' }), true);
    const auctionId = +r.location.split('/').pop();
    ok(auctionId > fixedId, 'auction listing created');
    r = await seller.req('POST', '/sell/new?_csrf=' + seller.csrf, listingForm({ ...baseListing, format: 'fixed', price: '0.10' }), true);
    ok(r.status === 400, 'invalid price rejected');
    r = await seller.req('POST', '/sell/new', listingForm({ ...baseListing, format: 'fixed', price: '5' }), true);
    ok(r.status === 403, 'listing upload without CSRF token refused');
    ok((await anon.get('/item/' + fixedId)).status === 200, 'listing page renders');
    ok((await anon.get(`/item/${fixedId}?country=GB`)).text.includes('International'), 'international Canada Post rates shown');
    ok((await anon.get(`/item/${fixedId}?country=CA&postal=V6B1A1`)).text.includes('Xpresspost'), 'domestic Canada Post rates shown');
    ok((await anon.get('/search?q=blanket')).text.includes('Vintage wool blanket'), 'search finds listing');
    ok((await anon.get('/search?q=zzzz')).text.includes('0 listings'), 'search with no match');
    ok((await anon.get('/user/' + sellerId)).status === 200, 'seller profile renders');

    console.log('Bidding (proxy bids)');
    const alice = await new Client().register('Alice Buyer', 'alice@test.ca');
    const bob = await new Client().register('Bob Buyer', 'bob@test.com');
    await alice.get('/item/' + auctionId);
    await alice.post(`/item/${auctionId}/bid`, { amount: '20.00' });
    let a = db.get('SELECT * FROM listings WHERE id=?', auctionId);
    ok(a.current_cents === 1000 && a.bid_count === 1, 'first bid sits at the starting price');
    await bob.get('/item/' + auctionId);
    await bob.post(`/item/${auctionId}/bid`, { amount: '15.00' });
    a = db.get('SELECT * FROM listings WHERE id=?', auctionId);
    ok(a.current_cents === 1550 && a.high_bidder_id !== db.get("SELECT id FROM users WHERE email='bob@test.com'").id, 'lower max is outbid automatically');
    await bob.post(`/item/${auctionId}/bid`, { amount: '30.00' });
    a = db.get('SELECT * FROM listings WHERE id=?', auctionId);
    const bobId = db.get("SELECT id FROM users WHERE email='bob@test.com'").id, aliceId = db.get("SELECT id FROM users WHERE email='alice@test.ca'").id;
    ok(a.current_cents === 2050 && a.high_bidder_id === bobId, 'higher max takes the lead one increment above');
    await seller.get('/item/' + auctionId);
    await seller.post(`/item/${auctionId}/bid`, { amount: '50.00' });
    ok(db.get('SELECT bid_count n FROM listings WHERE id=?', auctionId).n === 3, 'seller cannot bid on own listing');
    r = await bob.post(`/item/${auctionId}/buy`, {});
    ok(r.location === '/item/' + auctionId, 'Buy It Now disabled once bidding starts');
    db.run('UPDATE listings SET ends_at=? WHERE id=?', Date.now() - 1000, auctionId);
    market.closeAuctions();
    const auctionOrder = db.get('SELECT * FROM orders WHERE listing_id=?', auctionId);
    ok(auctionOrder && auctionOrder.buyer_id === bobId && auctionOrder.item_cents === 2050, 'auction closes and winner gets an order');

    console.log('Checkout: US buyer (no Canadian tax)');
    ok((await alice.get('/checkout/' + auctionOrder.id)).status === 404, 'another buyer cannot open the order');
    await bob.get('/checkout/' + auctionOrder.id);
    r = await bob.post(`/checkout/${auctionOrder.id}/address`, { ship_name: 'Bob Buyer', ship_addr1: '5 Main St', ship_city: 'Buffalo', ship_region: 'NY', ship_postal: '14201', ship_country: 'US' });
    r = await bob.get('/checkout/' + auctionOrder.id);
    ok(r.text.includes('Tracked Packet USA'), 'US Canada Post services offered');
    r = await bob.post(`/checkout/${auctionOrder.id}/pay`, { service: 'USA.TP' });
    ok(r.location === `/checkout/${auctionOrder.id}/test`, 'goes to test payment when Stripe is off');
    await bob.get(r.location);
    await bob.post(`/checkout/${auctionOrder.id}/test`, {});
    let o = orderRow(auctionOrder.id);
    ok(o.status === 'paid' && o.tax_cents === 0, 'paid, no tax on export');
    ok(o.fee_cents === Math.round((o.item_cents + o.ship_cents) * 0.03), '3% fee on item + shipping');
    ok(o.net_cents === o.item_cents + o.ship_cents - o.fee_cents && o.total_cents === o.item_cents + o.ship_cents, 'seller net and buyer total are right');
    ok(o.funds_status === 'held' && o.available_at === null, 'new seller funds held until shipped');

    console.log('Checkout: Ontario buyer (HST, platform remits)');
    await alice.get('/item/' + fixedId);
    r = await alice.post(`/item/${fixedId}/buy`, { qty: 2 });
    const fixedOrderId = +r.location.split('/').pop();
    await alice.get(r.location);
    ok((await alice.post(`/checkout/${fixedOrderId}/address`, { ship_name: 'Alice', ship_addr1: '9 King St', ship_city: 'Toronto', ship_region: 'BC', ship_postal: 'M5V 1A1', ship_country: 'CA' })).location.includes('edit=1'), 'mismatched province and postal code rejected');
    await alice.post(`/checkout/${fixedOrderId}/address`, { ship_name: 'Alice', ship_addr1: '9 King St', ship_city: 'Toronto', ship_region: 'Ontario', ship_postal: 'm5v1a1', ship_country: 'CA' });
    await alice.get('/checkout/' + fixedOrderId);
    await alice.post(`/checkout/${fixedOrderId}/pay`, { service: 'DOM.RP' });
    await alice.get(`/checkout/${fixedOrderId}/test`);
    await alice.post(`/checkout/${fixedOrderId}/test`, {});
    o = orderRow(fixedOrderId);
    ok(o.status === 'paid' && o.item_cents === 8000 && o.qty === 2, 'two units bought');
    ok(o.tax_cents === Math.round((o.item_cents + o.ship_cents) * 0.13) && o.tax_remitter === 'platform', '13% HST charged, remitted by Canado for an unregistered seller');
    ok(o.net_cents === o.item_cents + o.ship_cents - o.fee_cents, 'tax is not paid to an unregistered seller');
    ok(db.get('SELECT sold_qty s FROM listings WHERE id=?', fixedId).s === 2, 'stock reduced');

    console.log('Shipping, delivery and payout');
    await seller.get('/orders/' + fixedOrderId);
    await seller.post(`/orders/${fixedOrderId}/ship`, { tracking: 'bad' });
    ok(orderRow(fixedOrderId).status === 'paid', 'invalid tracking number rejected');
    await seller.post(`/orders/${fixedOrderId}/ship`, { tracking: '1234567890123456' });
    o = orderRow(fixedOrderId);
    ok(o.status === 'shipped' && o.available_at > Date.now() + 6 * market.DAY, 'shipped; funds scheduled for release in 7 days');
    await alice.get('/orders/' + fixedOrderId);
    await alice.post(`/orders/${fixedOrderId}/received`, {});
    market.releaseFunds();
    o = orderRow(fixedOrderId);
    ok(o.status === 'delivered' && o.funds_status === 'available', 'delivery confirmed; funds available');
    await alice.post(`/orders/${fixedOrderId}/feedback`, { rating: 1, comment: 'Great seller' });
    ok(market.sellerStats(sellerId).positive === 100, 'feedback recorded');
    ok(market.balance(sellerId).available === o.net_cents, 'seller balance shows available funds');
    await seller.get('/sell/payouts');
    await seller.post('/sell/payouts', { schedule: 'weekly', payout_details: 'sam@test.ca' });
    await admin.get('/admin?tab=payouts');
    await admin.post('/admin/payouts/run', { force: '1' });
    const payout = db.get('SELECT * FROM payouts WHERE seller_id=?', sellerId);
    ok(payout && payout.amount_cents === o.net_cents && payout.status === 'scheduled', 'payout created for the net amount');
    ok(orderRow(fixedOrderId).funds_status === 'paid_out', 'order marked paid out');
    await admin.post(`/admin/payouts/${payout.id}/sent`, { reference: 'ET-123' });
    ok(market.balance(sellerId).paidOut === o.net_cents, 'payout marked sent');
    ok(market.payoutDue('daily') === true && typeof market.payoutDue('weekly') === 'boolean', 'payout schedules evaluate');

    console.log('Case, freeze and refund');
    await bob.get('/orders/' + auctionOrder.id);
    await bob.post(`/orders/${auctionOrder.id}/case`, { reason: 'Item not received', detail: 'Nothing has arrived after three weeks.' });
    ok(orderRow(auctionOrder.id).funds_status === 'frozen', 'opening a case freezes the seller funds');
    const kase = db.get('SELECT * FROM cases WHERE order_id=?', auctionOrder.id);
    await admin.get('/admin?tab=cases');
    await admin.post(`/admin/cases/${kase.id}/refund`, {});
    o = orderRow(auctionOrder.id);
    ok(o.status === 'refunded' && o.funds_status === 'refunded', 'admin refund closes the case');
    ok(market.balance(sellerId).frozen === 0, 'no funds left frozen');

    console.log('Offers, watchlist, messages');
    await alice.get('/item/' + fixedId);
    await alice.post(`/item/${fixedId}/offer`, { amount: '30.00' });
    const offer = db.get("SELECT * FROM offers WHERE status='pending'");
    await seller.get('/sell/hub?tab=offers');
    await seller.post(`/sell/offers/${offer.id}/accept`, {});
    ok(db.get("SELECT * FROM orders WHERE source='offer'").item_cents === 3000, 'accepted offer creates an order at the offer price');
    await alice.post(`/item/${fixedId}/watch`, {});
    ok((await alice.get('/account?tab=watch')).text.includes('Vintage wool blanket'), 'watchlist works');
    await alice.get('/messages/' + sellerId);
    await alice.post('/messages/' + sellerId, { body: 'Do you combine shipping?', item: fixedId });
    ok((await seller.get('/messages')).text.includes('Do you combine shipping?'), 'message delivered');
    const offerOrder = db.get("SELECT * FROM orders WHERE source='offer'");
    await alice.get('/orders/' + offerOrder.id);
    await alice.post(`/orders/${offerOrder.id}/cancel`, {});
    ok(orderRow(offerOrder.id).status === 'cancelled' && db.get('SELECT sold_qty s FROM listings WHERE id=?', fixedId).s === 2, 'cancelling an unpaid order restores stock');

    console.log('eBay CSV import');
    const csv = new FormData();
    csv.append('file', new Blob(['Item number,Title,Start price,Available quantity,Condition\n1,"Canon AE-1 camera, tested",C $180.00,1,Used\n2,,5,1,New\n3,Maple cutting board,74.00,4,New\n'], { type: 'text/csv' }), 'ebay.csv');
    await seller.get('/sell/import');
    r = await seller.req('POST', '/sell/import?_csrf=' + seller.csrf, csv, true);
    ok(r.text.includes('2 listings created') && db.get("SELECT price_cents p FROM listings WHERE title LIKE 'Canon%'").p === 18000, 'CSV import creates listings and skips bad rows');

    console.log('Signed-in pages render');
    for (const p of ['/account', '/account?tab=bids', '/account?tab=offers', '/account?tab=settings', '/notifications', '/messages', '/orders/' + fixedOrderId]) ok((await alice.get(p)).status === 200, 'buyer GET ' + p);
    for (const p of ['/sell/hub', '/sell/hub?tab=orders', '/sell/hub?tab=ended', '/sell/hub?tab=offers', '/sell/payouts', '/sell/import', '/sell/new', '/sell/edit/' + fixedId, '/orders/' + fixedOrderId]) ok((await seller.get(p)).status === 200, 'seller GET ' + p);
    for (const t of ['overview', 'sellers', 'listings', 'orders', 'cases', 'payouts', 'users']) ok((await admin.get('/admin?tab=' + t)).status === 200, 'admin GET ' + t);
    ok((await bob.get('/orders/' + fixedOrderId)).status === 404, 'buyers cannot see each other\'s orders');
    ok((await alice.get('/sell/hub')).location === '/sell/apply', 'non-sellers cannot reach the seller hub');

    console.log(`\nAll ${passed} checks passed.`);
  } catch (e) {
    console.error('\nFAILED:', e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n'));
    process.exitCode = 1;
  } finally {
    server.close();
    db.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
