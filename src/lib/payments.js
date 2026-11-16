// Payments. Buyers pay Canado; Canado holds the money, deducts the fee and pays the seller.
// With STRIPE_SECRET_KEY set this uses Stripe Checkout for buyers and Stripe Connect (Express, Canada only) for seller payouts.
// Without it the site runs in test mode: payments are simulated and payouts are recorded for manual sending.
const config = require('../config');
const db = require('../db');

const enabled = !!config.stripeKey;
const stripe = enabled ? require('stripe')(config.stripeKey) : null;

async function createCheckout(order) {
  const line = (name, cents) => ({ quantity: 1, price_data: { currency: 'cad', unit_amount: cents, product_data: { name } } });
  const items = [line(`${order.title}${order.qty > 1 ? ' x ' + order.qty : ''}`, order.item_cents)];
  if (order.ship_cents) items.push(line(order.ship_service || 'Canada Post shipping', order.ship_cents));
  if (order.tax_cents) items.push(line(order.tax_label || 'Sales tax', order.tax_cents));
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', line_items: items, client_reference_id: String(order.id),
    metadata: { order_id: String(order.id) }, payment_intent_data: { transfer_group: 'order_' + order.id, metadata: { order_id: String(order.id) } },
    success_url: `${config.baseUrl}/checkout/${order.id}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/checkout/${order.id}`
  });
  return session.url;
}

// Returns the payment reference if the session is paid for this order and amount, otherwise null.
async function verifySession(sessionId, order) {
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  if (s.payment_status !== 'paid' || s.client_reference_id !== String(order.id) || s.amount_total !== order.total_cents) return null;
  return s.payment_intent;
}

function parseWebhook(rawBody, signature) {
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}

async function refund(order) {
  if (enabled && order.pay_ref && order.pay_ref.startsWith('pi_')) await stripe.refunds.create({ payment_intent: order.pay_ref });
}

// Seller onboarding. Stripe verifies identity and bank account; country is fixed to Canada.
async function connectLink(user) {
  let acct = user.stripe_account;
  if (!acct) {
    const a = await stripe.accounts.create({ type: 'express', country: 'CA', email: user.email, capabilities: { transfers: { requested: true } }, metadata: { user_id: String(user.id) } });
    acct = a.id;
    db.run('UPDATE users SET stripe_account=? WHERE id=?', acct, user.id);
  }
  const link = await stripe.accountLinks.create({ account: acct, type: 'account_onboarding', refresh_url: `${config.baseUrl}/sell/payouts`, return_url: `${config.baseUrl}/sell/payouts?connected=1` });
  return link.url;
}
async function refreshConnect(user) {
  if (!enabled || !user.stripe_account) return false;
  const a = await stripe.accounts.retrieve(user.stripe_account);
  const ready = a.country === 'CA' && a.payouts_enabled ? 1 : 0;
  db.run('UPDATE users SET stripe_ready=? WHERE id=?', ready, user.id);
  return !!ready;
}
async function transfer(payout, seller) {
  const t = await stripe.transfers.create({ amount: payout.amount_cents, currency: 'cad', destination: seller.stripe_account, metadata: { payout_id: String(payout.id) } }, { idempotencyKey: 'payout_' + payout.id });
  return t.id;
}

module.exports = { enabled, createCheckout, verifySession, parseWebhook, refund, connectLink, refreshConnect, transfer };
