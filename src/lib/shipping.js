// Canada Post is the only carrier on Canado.
// With API credentials set, rates come live from the Canada Post rating service.
// Without them, the site shows estimates from the table below so everything still works.
const config = require('../config');

const ZONE = { BC: 0, AB: 1, SK: 2, MB: 3, ON: 4, QC: 5, NB: 6, PE: 6, NS: 6, NL: 7, YT: 0, NT: 1, NU: 4 };
const NORTH = { YT: 2, NT: 2, NU: 3 };
const PREFIX = { A: 'NL', B: 'NS', C: 'PE', E: 'NB', G: 'QC', H: 'QC', J: 'QC', K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON', R: 'MB', S: 'SK', T: 'AB', V: 'BC', X: 'NT', Y: 'YT' };
const provOfPostal = p => PREFIX[String(p || '').toUpperCase()[0]] || null;

const NAMES = {
  'DOM.RP': 'Canada Post Regular Parcel', 'DOM.EP': 'Canada Post Expedited Parcel', 'DOM.XP': 'Canada Post Xpresspost', 'DOM.PC': 'Canada Post Priority',
  'USA.TP': 'Canada Post Tracked Packet USA', 'USA.SP.AIR': 'Canada Post Small Packet USA Air', 'USA.EP': 'Canada Post Expedited Parcel USA', 'USA.XP': 'Canada Post Xpresspost USA',
  'INT.SP.AIR': 'Canada Post Small Packet International Air', 'INT.SP.SURF': 'Canada Post Small Packet International Surface', 'INT.TP': 'Canada Post Tracked Packet International',
  'INT.XP': 'Canada Post Xpresspost International', 'INT.IP.AIR': 'Canada Post International Parcel Air', 'INT.IP.SURF': 'Canada Post International Parcel Surface'
};

function region(country) { return country === 'CA' ? 'ca' : country === 'US' ? 'us' : 'intl'; }

function estimate({ originPostal, country, postal, weightG }) {
  const kg = Math.max(0.1, weightG / 1000), extra = Math.max(0, kg - 1);
  const r = v => Math.round(v);
  if (country === 'CA') {
    const a = provOfPostal(originPostal) || 'ON', b = provOfPostal(postal) || 'ON';
    const d = Math.abs(ZONE[a] - ZONE[b]) + (NORTH[a] || 0) + (NORTH[b] || 0);
    const rp = 1300 + 260 * d + extra * (180 + 30 * d);
    return [
      { code: 'DOM.RP', cents: r(rp), days: `${2 + d} to ${5 + d}` },
      { code: 'DOM.XP', cents: r(rp * 1.45 + 300), days: `${1 + Math.floor(d / 3)} to ${2 + Math.floor(d / 2)}` },
      { code: 'DOM.PC', cents: r(rp * 2.3 + 800), days: d > 4 ? '1 to 2' : '1' }
    ];
  }
  if (country === 'US') {
    const out = [{ code: 'USA.EP', cents: r(2400 + 700 * kg), days: '4 to 7' }, { code: 'USA.XP', cents: r(3600 + 900 * kg), days: '2 to 3' }];
    if (kg <= 2) out.unshift({ code: 'USA.TP', cents: r(1700 + 900 * kg), days: '4 to 7' });
    return out;
  }
  const out = [{ code: 'INT.IP.SURF', cents: r(4200 + 800 * kg), days: '4 to 12 weeks' }, { code: 'INT.XP', cents: r(6500 + 1500 * kg), days: '4 to 7' }];
  if (kg <= 2) out.unshift({ code: 'INT.SP.AIR', cents: r(1300 + 2200 * kg), days: '6 to 10' }, { code: 'INT.TP', cents: r(2700 + 2400 * kg), days: '6 to 10' });
  return out;
}

// Live rates: POST /rs/ship/price on the Canada Post REST rating service.
async function live({ originPostal, country, postal, weightG, dims }) {
  const { user, pass, customer, host } = config.cp;
  const clean = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const dest = country === 'CA' ? `<domestic><postal-code>${clean(postal)}</postal-code></domestic>`
    : country === 'US' ? `<united-states><zip-code>${clean(postal).slice(0, 5)}</zip-code></united-states>`
    : `<international><country-code>${country}</country-code></international>`;
  const d = dims && dims.len && dims.wid && dims.hgt ? `<dimensions><length>${dims.len}</length><width>${dims.wid}</width><height>${dims.hgt}</height></dimensions>` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?><mailing-scenario xmlns="http://www.canadapost.ca/ws/ship/rate-v4"><customer-number>${customer}</customer-number><parcel-characteristics><weight>${Math.max(0.1, weightG / 1000).toFixed(3)}</weight>${d}</parcel-characteristics><origin-postal-code>${clean(originPostal)}</origin-postal-code><destination>${dest}</destination></mailing-scenario>`;
  const res = await fetch(`https://${host}/rs/ship/price`, {
    method: 'POST', body: xml, signal: AbortSignal.timeout(7000),
    headers: { Accept: 'application/vnd.cpc.ship.rate-v4+xml', 'Content-Type': 'application/vnd.cpc.ship.rate-v4+xml', 'Accept-language': 'en-CA', Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') }
  });
  const body = await res.text();
  if (!res.ok) throw new Error('Canada Post rating error ' + res.status);
  const out = [];
  for (const m of body.matchAll(/<price-quote>([\s\S]*?)<\/price-quote>/g)) {
    const tag = t => (m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
    const code = tag('service-code'), due = parseFloat(tag('due'));
    if (code && due > 0) out.push({ code, name: 'Canada Post ' + (tag('service-name') || code), cents: Math.round(due * 100), days: tag('expected-transit-time') || null });
  }
  if (!out.length) throw new Error('Canada Post returned no services');
  return out;
}

// Returns { options: [{code, name, cents, days}], estimated, error }.
async function quote(listing, seller, dest, qty = 1) {
  const reg = region(dest.country);
  if (!listing['ship_' + reg]) return { options: [], estimated: false, error: 'The seller does not ship this item to that destination.' };
  if (listing.ship_mode === 'free') return { options: [{ code: 'FREE', name: 'Canada Post (free shipping)', cents: 0, days: null }], estimated: false };
  if (listing.ship_mode === 'flat') {
    const cents = listing['flat_' + reg + '_cents'];
    if (cents == null) return { options: [], estimated: false, error: 'The seller has not set a shipping rate for that destination.' };
    return { options: [{ code: 'FLAT', name: 'Canada Post (seller flat rate)', cents: cents * qty, days: null }], estimated: false };
  }
  const args = { originPostal: seller.postal, country: dest.country, postal: dest.postal, weightG: listing.weight_g * qty, dims: { len: listing.len_cm, wid: listing.wid_cm, hgt: listing.hgt_cm } };
  let options, estimated = true;
  if (config.cp.user && config.cp.customer) {
    try { options = await live(args); estimated = false; } catch (e) { console.error('[shipping]', e.message); }
  }
  if (!options) options = estimate(args);
  options = options.map(o => ({ ...o, name: o.name || NAMES[o.code] || 'Canada Post ' + o.code })).sort((a, b) => a.cents - b.cents);
  return { options, estimated };
}

const trackingUrl = pin => 'https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=' + encodeURIComponent(String(pin || '').replace(/\s/g, ''));

module.exports = { quote, region, trackingUrl, provOfPostal };
