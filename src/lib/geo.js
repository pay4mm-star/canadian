// Provinces, countries, categories and sales tax tables.

const PROVINCES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon'
};

// First letter of a Canadian postal code maps to a province or territory. X is shared by NT and NU.
const POSTAL_PREFIX = { A: ['NL'], B: ['NS'], C: ['PE'], E: ['NB'], G: ['QC'], H: ['QC'], J: ['QC'], K: ['ON'], L: ['ON'], M: ['ON'], N: ['ON'], P: ['ON'], R: ['MB'], S: ['SK'], T: ['AB'], V: ['BC'], X: ['NT', 'NU'], Y: ['YT'] };

function normalizePostal(p) {
  const s = String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(s) ? s.slice(0, 3) + ' ' + s.slice(3) : null;
}
function postalMatchesProvince(postal, prov) {
  const list = POSTAL_PREFIX[(postal || '')[0]];
  return !!list && list.includes(prov);
}

// Combined sales tax charged to Canadian buyers, by destination province.
// Review these rates with an accountant before launch and whenever a province changes its rate.
const TAX = {
  AB: ['GST', 5], BC: ['GST + PST', 12], MB: ['GST + PST', 12], NB: ['HST', 15], NL: ['HST', 15], NS: ['HST', 14],
  NT: ['GST', 5], NU: ['GST', 5], ON: ['HST', 13], PE: ['HST', 15], QC: ['GST + QST', 14.975], SK: ['GST + PST', 11], YT: ['GST', 5]
};

const COUNTRIES = {
  CA: 'Canada', US: 'United States', GB: 'United Kingdom', AU: 'Australia', NZ: 'New Zealand', IE: 'Ireland', FR: 'France', DE: 'Germany',
  IT: 'Italy', ES: 'Spain', PT: 'Portugal', NL: 'Netherlands', BE: 'Belgium', LU: 'Luxembourg', CH: 'Switzerland', AT: 'Austria',
  SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', IS: 'Iceland', PL: 'Poland', CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary',
  RO: 'Romania', BG: 'Bulgaria', GR: 'Greece', HR: 'Croatia', SI: 'Slovenia', EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania', UA: 'Ukraine',
  TR: 'Türkiye', IL: 'Israel', AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait', EG: 'Egypt', MA: 'Morocco',
  ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya', GH: 'Ghana', IN: 'India', PK: 'Pakistan', BD: 'Bangladesh', LK: 'Sri Lanka',
  CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', JP: 'Japan', KR: 'South Korea', SG: 'Singapore', MY: 'Malaysia', TH: 'Thailand',
  VN: 'Vietnam', PH: 'Philippines', ID: 'Indonesia', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', CL: 'Chile', CO: 'Colombia',
  PE: 'Peru', CR: 'Costa Rica', PA: 'Panama', JM: 'Jamaica', TT: 'Trinidad and Tobago', BS: 'Bahamas', BB: 'Barbados', BM: 'Bermuda'
};

const CATEGORIES = {
  collectibles: 'Collectibles & art', cards: 'Sports cards & memorabilia', coins: 'Coins & stamps', electronics: 'Electronics',
  computers: 'Computers & tablets', phones: 'Cell phones', cameras: 'Cameras & photo', fashion: 'Clothing & accessories',
  jewellery: 'Jewellery & watches', home: 'Home & garden', tools: 'Tools & hardware', sports: 'Sporting goods', outdoors: 'Outdoors & camping',
  toys: 'Toys & hobbies', games: 'Video games', music: 'Music & instruments', books: 'Books & magazines', auto: 'Auto parts',
  baby: 'Baby & kids', health: 'Health & beauty', handmade: 'Handmade', business: 'Business & industrial', other: 'Everything else'
};
const CONDITIONS = ['New', 'New, open box', 'Refurbished', 'Used, like new', 'Used, good', 'Used, acceptable', 'For parts or not working', 'Vintage'];

// Tax for an order. Tax applies to item + shipping when the destination is in Canada.
// Exports are zero-rated: buyers outside Canada pay no Canadian sales tax (their own country may charge duties).
// If the seller is GST/HST registered the seller remits; otherwise the platform is treated as the supplier and remits.
function taxFor({ country, region, taxableCents, sellerRegistered }) {
  if (country !== 'CA' || !TAX[region]) return { cents: 0, label: null, rate: 0, remitter: null };
  const [label, rate] = TAX[region];
  return { cents: Math.round(taxableCents * rate / 100), label: `${label} ${rate}% (${region})`, rate, remitter: sellerRegistered ? 'seller' : 'platform' };
}

module.exports = { PROVINCES, TAX, COUNTRIES, CATEGORIES, CONDITIONS, normalizePostal, postalMatchesProvince, taxFor };
