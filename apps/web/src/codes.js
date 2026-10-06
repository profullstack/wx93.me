import { randomInt } from 'node:crypto';

/**
 * Short codes: base62, random, six characters by default (56 billion of them).
 * Random rather than sequential so codes cannot be walked to enumerate links.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** What a custom alias may be: letters, digits, dash and underscore, 3 to 64 of them. */
export const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

/**
 * Paths the app itself answers. An alias may not take one, in any case, or a
 * link called "pricing" would shadow the pricing page (or the other way round).
 */
export const RESERVED = new Set(
  [
    'about', 'account', 'admin', 'api', 'app', 'assets', 'auth', 'billing', 'blog', 'crawl',
    'dashboard', 'desktop', 'dl', 'docs', 'download', 'favicon', 'healthz', 'help', 'icons',
    'install', 'legal', 'links', 'llms', 'login', 'logout', 'manifest', 'mcp', 'new', 'oauth', 'offline',
    'pricing', 'privacy', 'qr', 'report', 'robots', 'security', 'settings', 'share', 'signin', 'signout',
    'signup', 'sitemap', 'sitemaps', 'static', 'status', 'support', 'sw', 'terms', 'uninstall',
    'upgrade', 'webhooks', 'well-known', 'www', 'x402',
  ].map((s) => s.toLowerCase()),
);

export function aliasProblem(alias) {
  if (!ALIAS.test(alias)) return 'an alias is 3 to 64 letters, digits, dashes or underscores, starting with a letter or digit';
  if (RESERVED.has(alias.toLowerCase())) return `"${alias}" is reserved`;
  return null;
}

/** What the redirect route accepts as a code at all (random or alias). */
export const CODE_PATH = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
