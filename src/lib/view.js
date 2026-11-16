// Formatting helpers shared by routes and templates.
const fmt = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const money = cents => 'C' + fmt.format((cents || 0) / 100);

function timeLeft(ms) {
  const s = Math.floor((ms - Date.now()) / 1000);
  if (s <= 0) return 'Ended';
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
}
const date = ms => ms ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium' }).format(ms) : '';
const dateTime = ms => ms ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' }).format(ms) : '';

// "12.50" or "$1,250" -> integer cents, or null if not a valid positive amount.
function parseCents(v) {
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
const clean = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

const STATUS = { awaiting_payment: 'Awaiting payment', paid: 'Paid, awaiting shipment', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded' };
const FUNDS = { none: 'Not paid yet', held: 'On hold', available: 'Available for payout', paid_out: 'Paid out', frozen: 'Frozen (case open)', refunded: 'Refunded to buyer' };

module.exports = { money, timeLeft, date, dateTime, parseCents, clean, STATUS, FUNDS };
