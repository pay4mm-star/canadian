const path = require('path');
require('dotenv').config();
const env = process.env;

module.exports = {
  port: +env.PORT || 3000,
  baseUrl: (env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  prod: env.NODE_ENV === 'production',
  sessionSecret: env.SESSION_SECRET || 'dev-secret-change-me',
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Fees: one final value fee, no listing fees, no subscriptions.
  feeBps: +(env.FEE_BPS || 300), // 300 basis points = 3%
  feeOnShipping: env.FEE_ON_SHIPPING !== 'false', // fee applies to item price + shipping (never to tax)

  // Payouts
  holdDays: +(env.HOLD_DAYS || 2), // established sellers: funds available this many days after payment
  newSellerSales: +(env.NEW_SELLER_SALES || 5), // sellers below this many completed sales are "new"
  newSellerHoldDays: +(env.NEW_SELLER_HOLD_DAYS || 7), // new sellers: days after shipping (or on delivery confirmation)
  minPayoutCents: +(env.MIN_PAYOUT_CENTS || 100),
  unpaidCancelDays: +(env.UNPAID_CANCEL_DAYS || 4),
  autoDeliverDays: +(env.AUTO_DELIVER_DAYS || 30),
  autoApproveSellers: env.AUTO_APPROVE_SELLERS === 'true',

  // Payments (Stripe). Without a key the site runs in test mode with simulated payments.
  stripeKey: env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',

  // Canada Post rating API. Without credentials the site shows estimated rates.
  cp: {
    user: env.CANADAPOST_API_USER || '',
    pass: env.CANADAPOST_API_PASSWORD || '',
    customer: env.CANADAPOST_CUSTOMER_NUMBER || '',
    host: env.CANADAPOST_ENV === 'production' ? 'soa-gw.canadapost.ca' : 'ct.soa-gw.canadapost.ca'
  },

  adminEmail: env.ADMIN_EMAIL || 'admin@canado.ca',
  adminPassword: env.ADMIN_PASSWORD || ''
};
