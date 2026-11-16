// Marketplace rules: bidding, orders, the 3% fee, held funds and payouts.
const config = require('../config');
const db = require('../db');
const payments = require('./payments');
const { taxFor } = require('./geo');

const DAY = 86400e3;
const increment = c => c < 100 ? 5 : c < 500 ? 25 : c < 2500 ? 50 : c < 10000 ? 100 : c < 25000 ? 250 : c < 50000 ? 500 : c < 100000 ? 1000 : c < 250000 ? 2500 : 5000;
const minNextBid = l => l.bid_count ? l.current_cents + increment(l.current_cents) : l.price_cents;
const isLive = l => l.status === 'active' && (!l.ends_at || l.ends_at > Date.now());

// Proxy bidding: the bidder gives a maximum; the price only rises as far as needed to beat the other bidder.
function placeBid(listingId, user, maxCents) {
  return db.tx(() => {
    const l = db.get('SELECT * FROM listings WHERE id=?', listingId);
    if (!l || l.format !== 'auction' || !isLive(l)) return { ok: false, msg: 'This auction has ended.' };
    if (l.seller_id === user.id) return { ok: false, msg: 'You cannot bid on your own listing.' };
    if (!Number.isInteger(maxCents) || maxCents < minNextBid(l)) {
      if (!(l.high_bidder_id === user.id && maxCents > l.high_max_cents)) return { ok: false, msg: `Enter at least $${(minNextBid(l) / 100).toFixed(2)}.` };
    }
    const now = Date.now();
    let current = l.current_cents, high = l.high_bidder_id, highMax = l.high_max_cents, msg, outbid = null, count = l.bid_count + 1;
    if (!high) { current = l.price_cents; high = user.id; highMax = maxCents; msg = 'You are the highest bidder.'; }
    else if (high === user.id) {
      if (maxCents <= highMax) return { ok: false, msg: 'You are already the highest bidder with a maximum at or above that amount.' };
      highMax = maxCents; count = l.bid_count; msg = 'Your maximum bid was raised.';
    }
    else if (maxCents > highMax) { outbid = high; current = Math.min(maxCents, highMax + increment(highMax)); high = user.id; highMax = maxCents; msg = 'You are the highest bidder.'; }
    else { current = Math.min(highMax, maxCents + increment(maxCents)); msg = 'You were outbid right away by another bidder\'s higher maximum. Bid again to stay in.'; }
    db.run('UPDATE listings SET current_cents=?, high_bidder_id=?, high_max_cents=?, bid_count=? WHERE id=?', current, high, highMax, count, l.id);
    db.run('INSERT INTO bids (listing_id, bidder_id, max_cents, amount_cents, created_at) VALUES (?,?,?,?,?)', l.id, user.id, maxCents, current, now);
    if (outbid) db.notify(outbid, `You were outbid on "${l.title}".`, '/item/' + l.id);
    return { ok: high === user.id, msg, leading: high === user.id };
  });
}

function createOrder(l, buyerId, qty, itemCents, source) {
  const r = db.run('INSERT INTO orders (listing_id, seller_id, buyer_id, title, source, qty, item_cents, total_cents, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    l.id, l.seller_id, buyerId, l.title, source, qty, itemCents, itemCents, Date.now());
  db.notify(l.seller_id, `Sold: "${l.title}". Waiting for the buyer to pay.`, '/orders/' + r.lastInsertRowid);
  return r.lastInsertRowid;
}

// Buy It Now for fixed-price listings, and for auctions that have no bids yet.
function buyNow(listingId, user, qty) {
  return db.tx(() => {
    const l = db.get('SELECT * FROM listings WHERE id=?', listingId);
    if (!l || !isLive(l)) return { ok: false, msg: 'This listing is no longer available.' };
    if (l.seller_id === user.id) return { ok: false, msg: 'You cannot buy your own listing.' };
    let unit;
    if (l.format === 'fixed') unit = l.price_cents;
    else if (l.bin_cents && !l.bid_count) { unit = l.bin_cents; qty = 1; }
    else return { ok: false, msg: 'Buy It Now is not available on this listing.' };
    qty = Math.max(1, Math.min(qty | 0, l.quantity - l.sold_qty));
    if (qty < 1 || l.quantity - l.sold_qty < 1) return { ok: false, msg: 'This item is sold out.' };
    const sold = l.sold_qty + qty, done = sold >= l.quantity || l.format === 'auction';
    db.run('UPDATE listings SET sold_qty=?, status=? WHERE id=?', sold, done ? 'sold' : 'active', l.id);
    return { ok: true, orderId: createOrder(l, user.id, qty, unit * qty, l.format === 'fixed' ? 'fixed' : 'bin') };
  });
}

function acceptOffer(offerId, seller) {
  return db.tx(() => {
    const o = db.get('SELECT * FROM offers WHERE id=?', offerId);
    const l = o && db.get('SELECT * FROM listings WHERE id=?', o.listing_id);
    if (!o || !l || l.seller_id !== seller.id || o.status !== 'pending') return { ok: false, msg: 'That offer is no longer open.' };
    if (!isLive(l) || l.quantity - l.sold_qty < 1 || l.bid_count) return { ok: false, msg: 'This listing can no longer accept offers.' };
    const sold = l.sold_qty + 1;
    db.run('UPDATE listings SET sold_qty=?, status=? WHERE id=?', sold, sold >= l.quantity || l.format === 'auction' ? 'sold' : 'active', l.id);
    db.run("UPDATE offers SET status='accepted' WHERE id=?", o.id);
    const orderId = createOrder(l, o.buyer_id, 1, o.amount_cents, 'offer');
    db.notify(o.buyer_id, `Your offer on "${l.title}" was accepted. Pay now to complete the purchase.`, '/checkout/' + orderId);
    return { ok: true, orderId };
  });
}

function closeAuctions() {
  const due = db.all("SELECT * FROM listings WHERE status='active' AND ends_at IS NOT NULL AND ends_at<=?", Date.now());
  for (const l of due) db.tx(() => {
    if (l.format === 'auction' && l.high_bidder_id && (!l.reserve_cents || l.current_cents >= l.reserve_cents)) {
      db.run("UPDATE listings SET status='sold', sold_qty=1 WHERE id=?", l.id);
      const orderId = createOrder(l, l.high_bidder_id, 1, l.current_cents, 'auction');
      db.notify(l.high_bidder_id, `You won "${l.title}". Pay now to complete the purchase.`, '/checkout/' + orderId);
    } else {
      db.run("UPDATE listings SET status='ended' WHERE id=?", l.id);
      db.notify(l.seller_id, `"${l.title}" ended without a sale. You can relist it.`, '/sell/hub?tab=ended');
    }
    db.run("UPDATE offers SET status='expired' WHERE listing_id=? AND status='pending'", l.id);
  });
}

// Totals for an order once the address and Canada Post service are known.
function priceOrder(order, seller, dest, option) {
  const tax = taxFor({ country: dest.country, region: dest.region, taxableCents: order.item_cents + option.cents, sellerRegistered: !!seller.gst_registered });
  const fee = Math.round((order.item_cents + (config.feeOnShipping ? option.cents : 0)) * config.feeBps / 10000);
  const net = order.item_cents + option.cents + (tax.remitter === 'seller' ? tax.cents : 0) - fee;
  return { ship_cents: option.cents, ship_service: option.name, tax_cents: tax.cents, tax_label: tax.label, tax_remitter: tax.remitter, total_cents: order.item_cents + option.cents + tax.cents, fee_cents: fee, net_cents: net };
}

const completedSales = sellerId => db.get("SELECT COUNT(*) n FROM orders WHERE seller_id=? AND status='delivered'", sellerId).n;
const isNewSeller = sellerId => completedSales(sellerId) < config.newSellerSales;

// Payment received by Canado. The seller's share is held, then released on the payout rules.
function markPaid(orderId, ref) {
  return db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id=?', orderId);
    if (!o || o.status !== 'awaiting_payment') return false;
    const now = Date.now();
    const availableAt = isNewSeller(o.seller_id) ? null : now + config.holdDays * DAY;
    db.run("UPDATE orders SET status='paid', pay_ref=?, paid_at=?, funds_status='held', available_at=? WHERE id=?", ref, now, availableAt, o.id);
    db.notify(o.seller_id, `Payment received for "${o.title}". Ship it with Canada Post and add the tracking number.`, '/orders/' + o.id);
    return true;
  });
}

function markShipped(order, tracking) {
  const now = Date.now();
  const availableAt = order.available_at || now + config.newSellerHoldDays * DAY;
  db.run("UPDATE orders SET status='shipped', shipped_at=?, tracking=?, available_at=? WHERE id=? AND status='paid'", now, tracking, availableAt, order.id);
  db.notify(order.buyer_id, `"${order.title}" has shipped with Canada Post. Tracking: ${tracking}`, '/orders/' + order.id);
}

function markDelivered(order) {
  const now = Date.now();
  db.run("UPDATE orders SET status='delivered', delivered_at=?, available_at=MIN(COALESCE(available_at, ?), ?) WHERE id=? AND status='shipped'", now, now, now, order.id);
}

function cancelUnpaid(order, why) {
  db.tx(() => {
    const r = db.run("UPDATE orders SET status='cancelled' WHERE id=? AND status='awaiting_payment'", order.id);
    if (!r.changes) return;
    const l = db.get('SELECT * FROM listings WHERE id=?', order.listing_id);
    if (l) {
      const sold = Math.max(0, l.sold_qty - order.qty);
      const reopen = l.format === 'fixed' && l.status === 'sold';
      db.run('UPDATE listings SET sold_qty=?, status=? WHERE id=?', sold, reopen ? 'active' : (l.format === 'auction' ? 'ended' : l.status), l.id);
    }
    db.notify(order.seller_id, `Order #${order.id} for "${order.title}" was cancelled: ${why}.`, '/sell/hub?tab=ended');
    db.notify(order.buyer_id, `Order #${order.id} for "${order.title}" was cancelled: ${why}.`, '/orders/' + order.id);
  });
}

// Full refund to the buyer. If the seller was already paid, the amount is recovered from their next payout.
async function refundOrder(order, note) {
  await payments.refund(order);
  db.tx(() => {
    if (order.funds_status === 'paid_out') db.run('INSERT INTO adjustments (seller_id, order_id, amount_cents, reason, created_at) VALUES (?,?,?,?,?)', order.seller_id, order.id, -order.net_cents, `Refund of order #${order.id}`, Date.now());
    db.run("UPDATE orders SET status='refunded', funds_status='refunded' WHERE id=?", order.id);
    db.notify(order.buyer_id, `Order #${order.id} was refunded in full. ${note || ''}`.trim(), '/orders/' + order.id);
    db.notify(order.seller_id, `Order #${order.id} was refunded to the buyer. ${note || ''}`.trim(), '/orders/' + order.id);
  });
}

function releaseFunds() {
  db.run("UPDATE orders SET funds_status='available' WHERE funds_status='held' AND available_at IS NOT NULL AND available_at<=? AND status IN ('paid','shipped','delivered')", Date.now());
}

function balance(sellerId) {
  const sum = st => db.get('SELECT COALESCE(SUM(net_cents),0) s FROM orders WHERE seller_id=? AND funds_status=?', sellerId, st).s;
  const adj = db.get('SELECT COALESCE(SUM(amount_cents),0) s FROM adjustments WHERE seller_id=? AND payout_id IS NULL', sellerId).s;
  return { held: sum('held'), available: sum('available') + adj, frozen: sum('frozen'), paidOut: db.get("SELECT COALESCE(SUM(amount_cents),0) s FROM payouts WHERE seller_id=? AND status='sent'", sellerId).s, adjustments: adj };
}

function torontoParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, day: +p.day, weekday: p.weekday, hour: +p.hour, week: Math.floor(d.getTime() / (7 * DAY)) };
}
// Payout schedules: daily, weekly (Tuesdays), every two weeks (alternate Tuesdays), monthly (the 1st).
function payoutDue(schedule, t = torontoParts()) {
  if (schedule === 'weekly') return t.weekday === 'Tue';
  if (schedule === 'biweekly') return t.weekday === 'Tue' && t.week % 2 === 0;
  if (schedule === 'monthly') return t.day === 1;
  return true;
}

async function runPayouts({ force = false } = {}) {
  releaseFunds();
  const sellers = db.all("SELECT DISTINCT seller_id id FROM orders WHERE funds_status='available'");
  const created = [];
  for (const { id } of sellers) {
    const seller = db.get('SELECT * FROM users WHERE id=?', id);
    if (!force && !payoutDue(seller.payout_schedule)) continue;
    const viaStripe = payments.enabled && seller.stripe_account && seller.stripe_ready;
    const payout = db.tx(() => {
      const b = balance(id);
      if (b.available < config.minPayoutCents) return null;
      const r = db.run('INSERT INTO payouts (seller_id, amount_cents, status, method, created_at) VALUES (?,?,?,?,?)', id, b.available, 'scheduled', viaStripe ? 'stripe' : 'manual', Date.now());
      db.run("UPDATE orders SET funds_status='paid_out', payout_id=? WHERE seller_id=? AND funds_status='available'", r.lastInsertRowid, id);
      db.run('UPDATE adjustments SET payout_id=? WHERE seller_id=? AND payout_id IS NULL', r.lastInsertRowid, id);
      return db.get('SELECT * FROM payouts WHERE id=?', r.lastInsertRowid);
    });
    if (!payout) continue;
    if (viaStripe) {
      try {
        const ref = await payments.transfer(payout, seller);
        db.run("UPDATE payouts SET status='sent', reference=?, sent_at=? WHERE id=?", ref, Date.now(), payout.id);
        db.notify(id, `Payout of $${(payout.amount_cents / 100).toFixed(2)} is on its way to your bank.`, '/sell/payouts');
      } catch (e) {
        console.error('[payout]', payout.id, e.message);
        db.run("UPDATE payouts SET method='manual', reference=? WHERE id=?", 'Stripe transfer failed: ' + e.message.slice(0, 200), payout.id);
      }
    }
    created.push(payout.id);
  }
  return created;
}

function markPayoutSent(payoutId, reference) {
  const p = db.get('SELECT * FROM payouts WHERE id=?', payoutId);
  if (!p || p.status === 'sent') return false;
  db.run("UPDATE payouts SET status='sent', reference=?, sent_at=? WHERE id=?", reference || p.reference, Date.now(), p.id);
  db.notify(p.seller_id, `Payout of $${(p.amount_cents / 100).toFixed(2)} was sent.`, '/sell/payouts');
  return true;
}

function sellerStats(id) {
  const f = db.get('SELECT COUNT(*) n, COALESCE(SUM(rating=1),0) pos, COALESCE(SUM(rating=-1),0) neg FROM feedback WHERE to_id=?', id);
  const rated = f.pos + f.neg;
  return { count: f.n, positive: rated ? Math.round(f.pos * 1000 / rated) / 10 : null, sales: completedSales(id) };
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    closeAuctions();
    const now = Date.now();
    for (const o of db.all("SELECT * FROM orders WHERE status='awaiting_payment' AND created_at<?", now - config.unpaidCancelDays * DAY)) cancelUnpaid(o, 'the buyer did not pay in time');
    for (const o of db.all("SELECT * FROM orders WHERE status='shipped' AND shipped_at<?", now - config.autoDeliverDays * DAY)) markDelivered(o);
    releaseFunds();
    const t = torontoParts();
    if (t.hour >= 6 && db.meta('last_payout_day') !== t.ymd) { db.setMeta('last_payout_day', t.ymd); await runPayouts(); }
  } catch (e) { console.error('[tick]', e); }
  ticking = false;
}

module.exports = { increment, minNextBid, isLive, placeBid, buyNow, acceptOffer, closeAuctions, priceOrder, markPaid, markShipped, markDelivered, cancelUnpaid, refundOrder, releaseFunds, balance, payoutDue, runPayouts, markPayoutSent, sellerStats, isNewSeller, tick, DAY };
