import { createThrottle } from '@profullstack/throttle';
import { createGateway } from '@profullstack/x402-gateway';
import { config } from './config.js';
import { clientIp } from './geo.js';

/**
 * Rate limits (@profullstack/throttle) with an x402 answer (@profullstack/x402-gateway):
 * a caller past its allowance gets a 402 offering a pass instead of a bare 429,
 * and a pass is also how an agent with no account buys ad-free links.
 *
 * Mounted on the app's own routes only, never on the short links themselves: a
 * popular link is clicked from one office NAT or one unfurler farm many times a
 * minute, and a redirect that answered 402 would be a broken link.
 *
 * The caller is counted by X-Real-IP, which nginx sets to the TCP peer. Every
 * other forwarding header is client-writable behind our edge.
 */

let built = null;

export function gateway() {
  return (built ??= build()).gateway;
}

function build() {
  const x = config.x402;
  const gw = createGateway({
    siteUrl: config.siteUrl,
    siteName: 'wx93',
    coinpay: x.enabled ? { apiKey: x.scopedKey, baseUrl: config.coinpay.baseUrl } : undefined,
    payTo: x.enabled ? x.payTo : undefined,
    priceCents: x.priceCents,
    passMinutes: x.passMinutes,
    maxDays: 1,
    path: '/x402',
    // Short links are for everyone, crawlers included: never charge a declared bot for a redirect.
    isPaidAgent: () => false,
    openPaths: ['/pricing', '/docs', '/llms.txt'],
  });
  const throttle = createThrottle({
    gateway: x.enabled ? gw : undefined,
    limit: config.throttle.limit,
    identify: (request) => clientIp(request),
    credentialFrom: (request) => {
      const auth = request.headers.get('authorization');
      if (auth) return auth;
      const cookie = request.headers.get('cookie') ?? '';
      const m = cookie.match(new RegExp(`(?:^|;\\s*)${config.session.cookie}=([^;]+)`));
      return m ? m[1] : null;
    },
    rules: [
      { path: '/healthz', open: true },
      { path: '/api/v1/health', open: true },
      { path: '/webhooks/', open: true },
      // Anonymous link creation: a few an hour per address, then a pass.
      { path: '/api/v1/links', limit: config.links.anonPerHour, windowSeconds: 3600, credential: { limit: 1200, ceiling: 2400 } },
      { path: '/shorten', limit: config.links.anonPerHour, windowSeconds: 3600 },
      { path: '/api/v1/links/bulk', limit: 60, windowSeconds: 3600 },
      // One-off QR images are drawn per request (PNG and PDF are real work): an hour's allowance, more when signed in.
      ...['svg', 'png', 'pdf'].map((ext) => ({ path: `/qr/make.${ext}`, limit: 120, windowSeconds: 3600, credential: { limit: 1200, ceiling: 2400 } })),
      // Brute-force and mail-bomb shaped routes stay per-address whatever they present.
      { path: '/auth/', limit: 10, credential: false },
      { path: '/api/v1/reports', limit: 10, windowSeconds: 3600, credential: false },
      { path: '/report', limit: 10, windowSeconds: 3600, credential: false },
      { path: '/oauth/token', limit: 30, credential: false },
      // Guessing credit codes: a handful an hour per address is plenty for a person with one.
      { path: '/account/redeem', limit: 20, windowSeconds: 3600, credential: false },
      { path: '/api/v1/credits/redeem', limit: 20, windowSeconds: 3600, credential: false },
      { path: '/oauth/authorize', limit: 30, credential: false },
    ],
  });
  return { gateway: gw, throttle };
}

/** Hono middleware for the app's own routes. */
export function trafficGuard() {
  return async (c, next) => {
    if (config.throttle.off) return next();
    built ??= build();
    if (c.req.path === '/x402') {
      const sold = await built.gateway.handle(c.req.raw);
      if (sold) return sold;
    }
    const answer = await built.throttle.handle(c.req.raw);
    if (answer) return answer;
    return next();
  };
}

/**
 * The verified x402 pass on a request, or null. Verified here, never trusted by
 * header presence: the throttle lets an unpaid request through while it is under
 * its allowance, fake pass header and all.
 */
export async function paidPass(request) {
  if (!config.x402.enabled) return null;
  const gw = gateway();
  const token = gw.passFrom(request);
  if (!token) return null;
  const ok = await gw.verifyPass(token).catch(() => false);
  return ok ? token : null;
}

/**
 * The crawl door: the fleet's day pass ($1 a day over x402, or any coin / PayPal through
 * CoinPay's hosted checkout) sold on /crawl, charged to AI training crawlers, headless
 * browsers and SEO scrapers on wx93's own pages only. Short-link redirects, QR images
 * and the API stay free for every crawler (see `isPaidAgent` above); people, verified
 * search crawlers and the AI chat/search fetchers are never charged anywhere.
 *
 * Its own pass secret, so a crawl pass reads pages and never counts as an x402 link pass.
 */
export const CRAWL_PAGES = new Set(['/', '/pricing', '/docs', '/desktop', '/share', '/qr', '/report', '/offline']);
let crawl = null;

export function crawlGateway() {
  const x = config.x402;
  if (!x.scopedKey || !x.payTo) return null;
  return (crawl ??= createGateway({
    siteUrl: config.siteUrl,
    siteName: 'wx93',
    coinpay: { apiKey: x.scopedKey, baseUrl: config.coinpay.baseUrl },
    payTo: x.payTo,
    secret: `${x.scopedKey}:crawl`,
    contact: 'mailto:anthony@profullstack.com',
    exempt: (request) => (request.headers.get('cookie') ?? '').includes(`${config.session.cookie}=`),
  }));
}

export function crawlGuard() {
  return async (c, next) => {
    const path = c.req.path;
    if (path !== '/crawl' && !path.startsWith('/crawl/') && !CRAWL_PAGES.has(path)) return next();
    const gw = crawlGateway();
    const answer = gw ? await gw.handle(c.req.raw) : null;
    return answer ?? next();
  };
}

export const resetTrafficGuard = () => {
  built = null;
  crawl = null;
};
