import { createCheckout } from '@profullstack/checkout';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, PLANS } from './config.js';

/**
 * The checkout page (@profullstack/checkout): one page per paid tier, the two
 * terms as its options, the year preselected. It only decides what the buyer
 * sees and which term they picked; the money still goes through startCheckout
 * in app.js, the same function the API route uses, so a session, its metadata
 * and the webhook grant are what they were before this page existed.
 */

export const TIERS = ['pro', 'automation'];
/** Below this there is nothing worth a payment (startCheckout refuses it too). */
export const MIN_CENTS = 50;

const TERMS = [
  { id: 'year', name: 'A year', words: 'a year', months: 12, popular: true },
  { id: 'month', name: 'A month', words: 'a month', months: 1, popular: false },
];

const usd = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

/**
 * The option cards for a tier. `amounts` is what each term would charge this
 * account right now ({ month, year } in cents, from billing.quote): the list
 * price, or less when unused paid Pro time is credited on an upgrade. Without
 * it (nobody signed in) the list prices stand. A term that would cost nothing
 * is not offered.
 */
export function planOptions(tier, amounts = {}) {
  const plan = PLANS[tier];
  if (!plan || !TIERS.includes(tier)) throw new Error('plan is pro or automation');
  return TERMS.map((t) => {
    const cents = amounts[t.id] ?? plan[`${t.id}Cents`];
    return { id: t.id, name: t.name, detail: `${usd(cents)} for ${t.words}`, price: cents / 100, months: t.months, popular: t.popular, cents };
  }).filter((o) => o.cents >= MIN_CENTS);
}

/**
 * A checkout for one request: the tier, who is signed in, and what each term
 * costs them. `start` is startCheckout. It is handed the amount the page showed
 * and refuses to open a session for any other.
 *
 * @param {object} args
 * @param {'pro'|'automation'} args.tier
 * @param {object|null} args.user  the session user, never anything from the request body
 * @param {string} [args.email]  shown as "Buying as"; '' hides the line
 * @param {{month?: number, year?: number}} [args.amounts]
 * @param {boolean} [args.extend]  the buyer is already on this tier
 * @param {boolean} [args.credited]  unused paid Pro time is taken off the prices
 * @param {(user: object, args: {plan: string, term: string, expectCents: number}) => Promise<{checkout_url: string, payment_ref: string}>} args.start
 * @param {(error: unknown) => void} [args.onError]
 */
export function planCheckout({ tier, user, email = '', amounts, extend = false, credited = false, start, onError }) {
  const plan = PLANS[tier];
  return createCheckout({
    site: config.host,
    siteUrl: config.siteUrl,
    title: `${extend ? 'Extend' : 'Get'} ${plan.name}`,
    subtitle: credited ? 'Prepaid for a month or a year. Your unused paid Pro time is credited in these prices.' : 'Prepaid for a month or a year. Extend whenever you like.',
    optionsLabel: 'Term',
    action: `/billing/checkout/${tier}`,
    page: `/checkout/${tier}`,
    options: planOptions(tier, amounts).map(({ cents, ...o }) => o),
    processor: 'Pay with any major coin or PayPal through CoinPay. Plans are prepaid and never renew by themselves.',
    requireAccount: true,
    signIn: '/signin',
    account: async () => (user ? { id: user.id, email } : null),
    pay: async (order) => {
      if (!user) throw new Error('checkout needs a signed-in user');
      const r = await start(user, { plan: tier, term: order.option.id, expectCents: order.totalCents });
      return { url: r.checkout_url, id: r.payment_ref };
    },
    onError,
  });
}

/* The package's stylesheet and its single-file browser script, served from our own
 * origin (the CSP allows no inline script and no other host for these). */
const asset = (specifier) => readFileSync(fileURLToPath(import.meta.resolve(specifier)));
const CSS = asset('@profullstack/checkout/checkout.css');
const JS = asset('@profullstack/checkout/browser.bundle.js');
const version = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);

export const CHECKOUT_ASSETS = {
  '/assets/checkout.css': { body: CSS, type: 'text/css; charset=utf-8', v: version(CSS) },
  '/assets/checkout.js': { body: JS, type: 'text/javascript; charset=utf-8', v: version(JS) },
};
