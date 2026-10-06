import { isIP } from 'node:net';
import { db } from '@wx93/db';
import { config } from './config.js';

/**
 * What a short link may point at.
 *
 * A shortener is a laundering service for bad URLs unless it refuses them on the
 * way in, so every destination passes three gates before it gets a code:
 *
 *   1. shape    http(s) only, a real hostname, no credentials, no private
 *               addresses, not another shortener (chains hide the end), not us
 *   2. lists    our blocklist table, plus the open URLhaus and OpenPhish feeds,
 *               refreshed every few hours and swept over existing links too
 *   3. lookup   Google Safe Browsing, when SAFE_BROWSING_API_KEY is set
 *
 * Anonymous creates get one more, heuristic, check: a phishing-shaped URL
 * (credential words on a throwaway host) needs an account.
 */

const MAX_URL = 2048;

/** Other shorteners. A chain hides the real destination from every check here. */
export const SHORTENERS = new Set([
  'bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'v.gd', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'bl.ink', 's.id', 'shorte.st',
  'adf.ly', 'bc.vc', 'ouo.io', 'tr.im', 'clck.ru', 'qr.ae', 'lnkd.in', 'trib.al', 'soo.gd',
  'urlz.fr', 'x.gd', 'u.to', 'short.io', 'shorturl.com', 'tinyurl.is', 'zpr.io', 'snip.ly',
]);

/** Free hosting where one subdomain is one tenant: match the full URL, never the whole host. */
export const SHARED_HOSTS = [
  'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'github.io', 'gitlab.io', 'web.app',
  'firebaseapp.com', 'glitch.me', 'herokuapp.com', 'onrender.com', 'fly.dev', 'railway.app',
  'blogspot.com', 'wixsite.com', 'weebly.com', 'square.site', 'webflow.io', 'framer.app',
  'replit.app', 'repl.co', 'surge.sh', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com',
  'googleapis.com', 'sites.google.com', 'docs.google.com', 'forms.gle', 'notion.site', 'ipfs.io',
  'r2.dev', 'translate.goog',
];

export class DestinationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const privateV4 = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
};

/** Parse and normalise a destination, or throw DestinationError saying why not. */
export function checkShape(raw, { ownHosts = [] } = {}) {
  const input = String(raw ?? '').trim();
  if (!input) throw new DestinationError('give a URL to shorten');
  if (input.length > MAX_URL) throw new DestinationError(`URLs up to ${MAX_URL} characters`);
  if (/[\s<>"]/.test(input)) throw new DestinationError('that URL has spaces or quotes in it');
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    throw new DestinationError('that is not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new DestinationError('only http and https links can be shortened');
  if (u.username || u.password) throw new DestinationError('URLs with a username or password in them are refused (a classic phishing trick)');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new DestinationError('that URL has no host');
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) === 6) throw new DestinationError('IPv6 address links are refused; use a hostname');
  if (isIP(bare) === 4 && privateV4(bare)) throw new DestinationError('private and loopback addresses are refused');
  if (!isIP(bare)) {
    if (!host.includes('.') || /\.(local|localhost|internal|lan|home|corp|test|invalid|example|onion)$/.test(host) || host === 'localhost')
      throw new DestinationError('that host is not on the public internet');
    if (!/^[a-z0-9.-]+$/.test(host)) throw new DestinationError('that hostname has characters a hostname cannot');
  }
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new DestinationError('links to unusual ports are refused');
  const own = new Set([...config.shortHosts, ...ownHosts].map((h) => h.toLowerCase()));
  if (own.has(host) || own.has(host.replace(/^www\./, ''))) throw new DestinationError('that is already a wx93 link');
  if (suffixes(host).some((s) => SHORTENERS.has(s)))
    throw new DestinationError('links to other shorteners are refused: shorten the real destination instead');
  return { url: u.toString(), host };
}

/** www.a.b.example.com -> [www.a.b.example.com, a.b.example.com, b.example.com, example.com] */
export function suffixes(host) {
  const parts = host.split('.');
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  return out;
}

export const isShared = (host) => SHARED_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));

/* ---------------------------------------------------------------- feeds -- */

const feed = { hosts: new Set(), urls: new Set(), loadedAt: null, sources: {} };

const normUrl = (u) => {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
};

/** Parse URLhaus's hostfile (`127.0.0.1\thost`). Exported for tests. */
export function parseHostfile(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9.-]+)\s*$/i.exec(line);
    if (m && m[1] !== 'localhost') out.push(m[1].toLowerCase());
  }
  return out;
}

/** Parse a one-URL-per-line feed (OpenPhish). Exported for tests. */
export function parseUrlList(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l));
}

/** Load the open feeds into memory. Never throws: a feed that is down keeps the last copy. */
export async function refreshFeeds({ fetchImpl = fetch } = {}) {
  const get = async (url) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'wx93.me abuse-check' } });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return res.text();
  };
  const hosts = new Set();
  const urls = new Set();
  const sources = {};
  try {
    const list = parseHostfile(await get('https://urlhaus.abuse.ch/downloads/hostfile/'));
    for (const h of list) hosts.add(h);
    sources.urlhaus = list.length;
  } catch (err) {
    sources.urlhaus = `error: ${err.message}`;
  }
  try {
    const list = parseUrlList(await get('https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt'));
    for (const u of list) {
      urls.add(normUrl(u));
      const h = new URL(u).hostname.toLowerCase();
      if (!isShared(h)) hosts.add(h);
    }
    sources.openphish = list.length;
  } catch (err) {
    sources.openphish = `error: ${err.message}`;
  }
  if (hosts.size || urls.size) {
    feed.hosts = hosts;
    feed.urls = urls;
    feed.loadedAt = new Date();
  }
  feed.sources = sources;
  return { hosts: feed.hosts.size, urls: feed.urls.size, sources };
}

export const feedStatus = () => ({ hosts: feed.hosts.size, urls: feed.urls.size, loaded_at: feed.loadedAt, sources: feed.sources });

/** For tests: put known-bad entries in without the network. */
export function seedFeeds({ hosts = [], urls = [] }) {
  for (const h of hosts) feed.hosts.add(h.toLowerCase());
  for (const u of urls) feed.urls.add(normUrl(u));
}

function feedHit(url, host) {
  if (feed.urls.has(normUrl(url))) return 'listed in a phishing feed';
  if (!isShared(host) && suffixes(host).some((s) => feed.hosts.has(s))) return 'its host is listed in a malware or phishing feed';
  return null;
}

/* --------------------------------------------------------------- lookups -- */

async function blocklisted(host) {
  const rows = await db()`select domain, reason from blocklist where domain = any(${suffixes(host)}) limit 1`;
  return rows[0] ?? null;
}

async function safeBrowsing(url) {
  const key = config.abuse.safeBrowsingKey;
  if (!key) return null;
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client: { clientId: 'wx93.me', clientVersion: '1' },
        threatInfo: {
          threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url }],
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.matches?.length ? `flagged by Google Safe Browsing (${body.matches[0].threatType})` : null;
  } catch {
    // A lookup that times out must not block a create; the feeds still ran.
    return null;
  }
}

const PHISHY_WORDS = /(log-?in|sign-?in|verify|verification|account|secure|wallet|seed|recover|unlock|suspend|update-?payment|billing|password|2fa|airdrop|claim)/i;
const RISKY_TLDS = /\.(zip|mov|top|xyz|click|country|gq|tk|ml|cf|ga|work|rest|support|cam|quest|sbs|cfd)$/i;

/** A score for phishing shape. Only anonymous creates are refused on it. Exported for tests. */
export function phishScore(url, host) {
  let s = 0;
  if (host.startsWith('xn--') || host.includes('.xn--')) s += 2;
  if (RISKY_TLDS.test(host)) s += 1;
  if (PHISHY_WORDS.test(url)) s += 1;
  if (isShared(host) && PHISHY_WORDS.test(url)) s += 1;
  if ((host.match(/-/g) ?? []).length >= 2) s += 1;
  if (isIP(host)) s += 2;
  return s;
}

/**
 * The whole gate. Returns { url, host } or throws DestinationError.
 * `anonymous` adds the phishing-shape check.
 */
export async function checkDestination(raw, { anonymous = false, ownHosts = [] } = {}) {
  const { url, host } = checkShape(raw, { ownHosts });
  const listed = await blocklisted(host);
  if (listed) throw new DestinationError(`that destination is blocked (${listed.reason})`, 403);
  const hit = feedHit(url, host);
  if (hit) throw new DestinationError(`that destination is refused: ${hit}`, 403);
  if (anonymous && phishScore(url, host) >= 3)
    throw new DestinationError('that link looks like a phishing page; sign in to shorten it', 403);
  const sb = await safeBrowsing(url);
  if (sb) throw new DestinationError(`that destination is refused: ${sb}`, 403);
  return { url, host };
}

/** True when an existing link's destination is now known bad. For the sweeper. */
export function isKnownBad(url, host) {
  return Boolean(feedHit(url, host));
}
