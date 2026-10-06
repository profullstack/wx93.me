import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SITE_URL = 'https://wx93.me';
process.env.ALT_HOSTS = '9xq.me';

const { classify, isPrefetch } = await import('../apps/web/src/ua.js');
const { aliasProblem, randomCode, CODE_PATH } = await import('../apps/web/src/codes.js');
const { parseExpiry, parseRedirectType, codeFrom, referrerHost, HttpError } = await import('../apps/web/src/parse.js');
const abuse = await import('../apps/web/src/abuse.js');
const { priceQuote, TERM_MS } = await import('../apps/web/src/billing.js');
const { qrSvg } = await import('../apps/web/src/qr.js');
const { sign } = await import('../apps/web/src/webhooks.js');
const { installScript } = await import('../apps/web/src/install.js');
const { parse } = await import('../packages/cli/src/cli.js');
const { TOOLS, handle } = await import('../packages/cli/src/tools.js');
const { PLANS } = await import('../apps/web/src/config.js');

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('who is clicking', () => {
  test('a browser is a person', () => {
    const c = classify(CHROME);
    expect(c.browserLike).toBe(true);
    expect(c.bot).toBe(false);
    expect(c.device).toBe('desktop');
    expect(c.browser).toBe('Chrome');
    expect(classify(IPHONE).device).toBe('mobile');
    expect(classify(IPHONE).os).toBe('iOS');
  });
  test('unfurlers, crawlers and scripts get the plain redirect', () => {
    for (const ua of [
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Twitterbot/1.0',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'TelegramBot (like TwitterBot)',
      'WhatsApp/2.23.20.0',
      'curl/8.5.0',
      'python-requests/2.31',
      '',
      undefined,
    ]) {
      const c = classify(ua);
      expect(c.browserLike).toBe(false);
      expect(c.bot).toBe(true);
    }
    expect(classify('Slackbot-LinkExpanding 1.0').unfurler).toBe(true);
  });
  test('prefetches are not visits', () => {
    expect(isPrefetch(new Headers({ 'sec-purpose': 'prefetch;prerender' }))).toBe(true);
    expect(isPrefetch(new Headers({}))).toBe(false);
  });
});

describe('codes', () => {
  test('random codes are base62 of the asked length', () => {
    for (let i = 0; i < 200; i++) expect(randomCode(6)).toMatch(/^[0-9A-Za-z]{6}$/);
  });
  test('aliases: shape and reserved words', () => {
    expect(aliasProblem('launch-2026')).toBeNull();
    expect(aliasProblem('ab')).toMatch(/3 to 64/);
    expect(aliasProblem('-nope')).toMatch(/3 to 64/);
    expect(aliasProblem('Pricing')).toMatch(/reserved/);
    expect(aliasProblem('api')).toMatch(/reserved/);
    expect(CODE_PATH.test('abc123')).toBe(true);
    expect(CODE_PATH.test('a/b')).toBe(false);
  });
});

describe('parsing input', () => {
  const now = Date.UTC(2026, 9, 6);
  test('expiry', () => {
    expect(parseExpiry({}, now)).toBeNull();
    expect(parseExpiry({ expires_in: '7d' }, now).getTime()).toBe(now + 7 * 86400_000);
    expect(parseExpiry({ expires_in: '90m' }, now).getTime()).toBe(now + 90 * 60_000);
    expect(parseExpiry({ expires_at: '2027-01-01T00:00:00Z' }, now).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(() => parseExpiry({ expires_in: 'soon' }, now)).toThrow(HttpError);
    expect(() => parseExpiry({ expires_at: '2020-01-01' }, now)).toThrow(/past/);
    expect(() => parseExpiry({ expires_in: '11y' }, now)).toThrow(/ten years/);
  });
  test('redirect types', () => {
    expect(parseRedirectType(undefined)).toBeNull();
    expect(parseRedirectType('301')).toBe(301);
    expect(() => parseRedirectType(303)).toThrow();
  });
  test('a code from whatever was pasted', () => {
    expect(codeFrom('https://wx93.me/abc123', 'wx93.me')).toBe('abc123');
    expect(codeFrom('wx93.me/abc123+', 'wx93.me')).toBe('abc123');
    expect(codeFrom('abc123', 'wx93.me')).toBe('abc123');
    expect(codeFrom('https://evil.example/x/y', 'wx93.me')).toBeNull();
  });
  test('referrer host', () => {
    expect(referrerHost('https://www.news.ycombinator.com/item?id=1', 'wx93.me')).toBe('news.ycombinator.com');
    expect(referrerHost('https://wx93.me/abc', 'wx93.me')).toBeNull();
    expect(referrerHost('garbage', 'wx93.me')).toBeNull();
  });
});

describe('destination shape', () => {
  const ok = (u) => abuse.checkShape(u);
  const bad = (u, re) => expect(() => abuse.checkShape(u)).toThrow(re);
  test('normal links pass and get normalised', () => {
    expect(ok('https://example.com/a?b=1').url).toBe('https://example.com/a?b=1');
    expect(ok('example.com/path').url).toBe('https://example.com/path');
    expect(ok('http://8.8.8.8/').host).toBe('8.8.8.8');
  });
  test('refused shapes', () => {
    bad('javascript:alert(1)', /http and https/);
    bad('data:text/html,hi', /http and https/);
    bad('ftp://example.com', /http and https/);
    bad('https://user:pass@example.com', /username or password/);
    bad('http://127.0.0.1/', /private/);
    bad('http://10.0.0.5/', /private/);
    bad('http://169.254.169.254/latest', /private/);
    bad('http://localhost:3000', /public internet/);
    bad('http://printer.local', /public internet/);
    bad('https://bit.ly/abc', /other shorteners/);
    bad('https://www.tinyurl.com/abc', /other shorteners/);
    bad('https://wx93.me/abc', /already/);
    bad('https://9xq.me/abc', /already/);
    bad('https://example.com:22/', /ports/);
    bad('https://exa mple.com', /spaces/);
    bad(`https://example.com/${'a'.repeat(2100)}`, /2048/);
  });
  test('phishing shape scores', () => {
    expect(abuse.phishScore('https://example.com/blog', 'example.com')).toBe(0);
    expect(abuse.phishScore('https://secure-login-verify.xyz/account', 'secure-login-verify.xyz')).toBeGreaterThanOrEqual(3);
    expect(abuse.phishScore('https://xn--pypal-4ve.com/', 'xn--pypal-4ve.com')).toBeGreaterThanOrEqual(2);
  });
  test('feed parsers and matching', () => {
    expect(abuse.parseHostfile('# c\n127.0.0.1\tbad.example\n127.0.0.1\tlocalhost\n0.0.0.0 worse.example\n')).toEqual(['bad.example', 'worse.example']);
    expect(abuse.parseUrlList('https://x.pages.dev/\nnot a url\nhttp://y.example/z\n')).toHaveLength(2);
    abuse.seedFeeds({ hosts: ['malware-host.example'], urls: ['https://phish.pages.dev/login'] });
    expect(abuse.isKnownBad('https://a.malware-host.example/x', 'a.malware-host.example')).toBe(true);
    expect(abuse.isKnownBad('https://phish.pages.dev/login', 'phish.pages.dev')).toBe(true);
    // A shared host is matched by URL only, never by the whole host.
    expect(abuse.isKnownBad('https://other.pages.dev/', 'other.pages.dev')).toBe(false);
    expect(abuse.isShared('foo.vercel.app')).toBe(true);
  });
});

describe('plan arithmetic', () => {
  const now = Date.UTC(2026, 9, 6);
  test('a first purchase starts now', () => {
    const q = priceQuote({ now, current: 'free', staff: false, periods: [], target: 'pro', term: 'month' });
    expect(q).toMatchObject({ kind: 'new', amount_cents: PLANS.pro.monthCents });
    expect(q.ends_at.getTime() - q.starts_at.getTime()).toBe(TERM_MS.month);
  });
  test('a renewal queues after the paid time', () => {
    const end = new Date(now + 10 * 86400_000);
    const q = priceQuote({ now, current: 'pro', staff: false, periods: [{ plan: 'pro', term: 'month', starts_at: new Date(now - 20 * 86400_000), ends_at: end }], target: 'pro', term: 'year' });
    expect(q.kind).toBe('renew');
    expect(q.starts_at.getTime()).toBe(end.getTime());
    expect(q.amount_cents).toBe(PLANS.pro.yearCents);
  });
  test('an upgrade credits unused Pro time', () => {
    const q = priceQuote({
      now,
      current: 'pro',
      staff: false,
      periods: [{ plan: 'pro', term: 'month', starts_at: new Date(now - 15 * 86400_000), ends_at: new Date(now + 15 * 86400_000) }],
      target: 'automation',
      term: 'month',
    });
    expect(q.kind).toBe('upgrade');
    expect(q.credit_cents).toBe(250);
    expect(q.amount_cents).toBe(PLANS.automation.monthCents - 250);
  });
  test('staff pay nothing', () => {
    expect(priceQuote({ now, current: 'automation', staff: true, periods: [], target: 'pro', term: 'month' }).amount_cents).toBe(0);
  });
  test('prices are what the README says', () => {
    expect([PLANS.pro.monthCents, PLANS.pro.yearCents, PLANS.automation.monthCents, PLANS.automation.yearCents]).toEqual([500, 5000, 2900, 29000]);
  });
});

describe('outputs', () => {
  test('QR codes are standalone SVG', () => {
    const svg = qrSvg('https://wx93.me/abc123');
    expect(svg).toStartWith('<?xml');
    expect(svg).toContain('<path d="M');
    expect(svg).not.toContain('<script');
  });
  test('webhook signatures are HMAC over t.body', () => {
    expect(sign('s', '{}', 1)).toBe('t=1,v1=' + new Bun.CryptoHasher('sha256', 's').update('1.{}').digest('hex'));
  });
  test('the curl installer is valid sh, never sudo, and points at the site', () => {
    const script = installScript();
    expect(script).toContain('SITE="${WX93_SITE:-https://wx93.me}"');
    expect(script).toContain('$SITE/dl/wx93.mjs');
    expect(script).not.toMatch(/(^|[;&|]\s*)sudo\s/m);
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(script).toContain('--cli-only');
    const dir = mkdtempSync(join(tmpdir(), 'wx93-install-'));
    writeFileSync(join(dir, 'install.sh'), script);
    execFileSync('sh', ['-n', join(dir, 'install.sh')]);
  });
  test('the CLI parses flags', () => {
    expect(parse(['https://x.example', '--alias', 'a1', '--qr', '--json'])).toEqual({ positional: ['https://x.example'], flags: { alias: 'a1', qr: true, json: true } });
    expect(parse(['stats', 'abc', '--days=7']).flags.days).toBe('7');
  });
});

describe('MCP', () => {
  test('initialize and tools/list answer without a network', async () => {
    const auth = async () => ({ server: 'http://127.0.0.1:9', key: '' });
    const init = await handle({ method: 'initialize', params: {} }, { auth });
    expect(init.serverInfo.name).toBe('wx93');
    const { tools } = await handle({ method: 'tools/list' }, { auth });
    expect(tools.map((t) => t.name)).toContain('shorten_url');
    expect(TOOLS.every((t) => t.inputSchema.type === 'object')).toBe(true);
    await expect(handle({ method: 'nope' }, { auth })).rejects.toThrow(/method not found/);
  });
});

describe('copy', () => {
  test('no em dashes anywhere a person reads', async () => {
    for (const f of ['apps/web/src/pages.js', 'apps/web/src/app.js', 'README.md', 'packages/cli/src/cli.js', 'apps/web/src/install.sh.txt']) {
      const text = await Bun.file(join(import.meta.dir, '..', f)).text();
      expect(`${f}: ${text.includes('—')}`).toBe(`${f}: false`);
    }
  });
});
