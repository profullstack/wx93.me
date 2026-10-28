/**
 * End to end against a real Postgres: DATABASE_URL=postgres://... bun test
 * Without DATABASE_URL these tests are skipped (the unit tests still run).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const SITE = 'http://localhost:3999';
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
let app, auth, db, close, links;
let ipn = 0;
const ip = () => `198.51.100.${++ipn % 250}`;

const req = (path, { method = 'GET', headers = {}, body, json } = {}) =>
  app.fetch(
    new Request(`${SITE}${path}`, {
      method,
      headers: { 'x-real-ip': headers['x-real-ip'] ?? ip(), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
      redirect: 'manual',
    }),
  );

async function signIn(email) {
  const user = await auth.findOrCreateUser(email);
  const url = await auth.createLoginLink(email);
  const res = await req(new URL(url).pathname + new URL(url).search);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { user, cookie };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  Object.assign(process.env, {
    SITE_URL: SITE,
    ALT_HOSTS: '9xq.me',
    ADMIN_EMAILS: 'staff@example.test',
    COINPAY_API_KEY: 'cp_test_x',
    COINPAY_BUSINESS_ID: 'biz',
    COINPAY_WEBHOOK_SECRET: 'whsec_test',
    THREAT_FEEDS: '0',
    REPORT_THRESHOLD: '2',
    ANON_LINKS_PER_HOUR: '1000',
  });
  ({ db, close } = await import('../packages/db/src/index.js'));
  await db().unsafe('drop schema public cascade; create schema public;');
  await (await import('../packages/db/src/migrate.js')).migrate({ log: () => {} });
  const { configurePayments } = await import('../packages/payments/src/index.js');
  const { config } = await import('../apps/web/src/config.js');
  configurePayments({ sql: db(), coinpay: config.coinpay, siteUrl: config.siteUrl });
  app = (await import('../apps/web/src/app.js')).app;
  auth = await import('../apps/web/src/auth.js');
  links = await import('../apps/web/src/links.js');
});

afterAll(async () => {
  if (HAS_DB) await close();
});

d('anonymous links and how they answer', () => {
  let link;
  test('create without an account', async () => {
    const res = await req('/api/v1/links', { method: 'POST', json: { url: 'https://example.com/a?b=1' } });
    expect(res.status).toBe(201);
    link = await res.json();
    expect(link.short_url).toBe(`${SITE}/${link.code}`);
    expect(link.ad_free).toBe(false);
  });
  test('curl, bots and unfurlers get a plain 302', async () => {
    for (const ua of ['curl/8.5.0', 'Slackbot-LinkExpanding 1.0', 'Twitterbot/1.0', 'facebookexternalhit/1.1']) {
      const res = await req(`/${link.code}`, { headers: { 'user-agent': ua } });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://example.com/a?b=1');
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('vary')).toBe('User-Agent');
    }
  });
  test('a person in a browser gets the interstitial, which needs no JavaScript', async () => {
    const res = await req(`/${link.code}`, { headers: { 'user-agent': CHROME } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta http-equiv="refresh" content="5;url=https://example.com/a?b=1">');
    expect(html).toContain('href="https://example.com/a?b=1"');
    expect(html).toContain('class="ad ');
    expect(html).toContain('noindex');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('crawlproof');
    expect(res.headers.get('content-security-policy')).not.toContain('crawlproof.com');
  });
  test('site pages carry the CrawlProof stats tag, and the CSP allows it', async () => {
    for (const path of ['/', '/pricing', '/docs']) {
      const res = await req(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('data-site="1db8465f-dde9-47b1-b898-942367b075ad" src="https://crawlproof.com/stats.js"');
      const policy = res.headers.get('content-security-policy');
      expect(policy).toContain("script-src 'self' https://crawlproof.com");
      expect(policy).toContain("connect-src 'self' https://crawlproof.com");
    }
  });
  test('HEAD is a redirect too', async () => {
    const res = await req(`/${link.code}`, { method: 'HEAD', headers: { 'user-agent': CHROME } });
    expect([200, 302]).toContain(res.status);
  });
  test('code+ previews without going', async () => {
    const res = await req(`/${link.code}+`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('https://example.com/a?b=1');
  });
  test('clicks are counted, people and bots apart', async () => {
    await links.flushClicks();
    const [row] = await db()`select clicks, human_clicks from links where id = ${link.id}`;
    expect(Number(row.clicks)).toBeGreaterThanOrEqual(5);
    expect(Number(row.human_clicks)).toBe(1);
  });
  test('the second short domain resolves the same code, and sends the rest to the brand', async () => {
    const res = await req(`/${link.code}`, { headers: { host: '9xq.me', 'user-agent': 'curl/8' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/a?b=1');
    const home = await req('/pricing?x=1', { headers: { host: '9xq.me' } });
    expect(home.status).toBe(301);
    expect(home.headers.get('location')).toBe(`${SITE}/pricing?x=1`);
    const made = await (await req('/api/v1/links', { method: 'POST', json: { url: 'https://example.com/z', domain: '9xq.me' } })).json();
    expect(made.short_url).toBe(`https://9xq.me/${made.code}`);
    expect((await req(`/${made.code}`, { headers: { 'user-agent': 'curl/8' } })).status).toBe(302);
  });
  test('a page on the second short domain is branded and styled from wx93.me', async () => {
    const res = await req(`/${link.code}`, { headers: { host: '9xq.me', 'user-agent': CHROME } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<link rel="stylesheet" href="${SITE}/assets/app.css`);
    expect(html).toContain(`<meta property="og:image" content="${SITE}/icons/og.png?v=2">`);
    expect(html).toContain(`<a class="brand" href="${SITE}/">`);
    expect(html).not.toContain('9xq');
    expect(res.headers.get('content-security-policy')).toContain(`style-src 'self' ${new URL(SITE).origin}`);
  });
  test('unknown, expired and bad input', async () => {
    expect((await req('/zzzzzz')).status).toBe(404);
    const bad = await req('/api/v1/links', { method: 'POST', json: { url: 'javascript:alert(1)' } });
    expect(bad.status).toBe(400);
    const anonAlias = await req('/api/v1/links', { method: 'POST', json: { url: 'https://example.com', alias: 'mine' } });
    expect(anonAlias.status).toBe(401);
    const short = await (await req('/api/v1/links', { method: 'POST', json: { url: 'https://example.com/e', expires_in: '1m' } })).json();
    await db()`update links set expires_at = now() - interval '1 second' where id = ${short.id}`;
    links.clearCache();
    expect((await req(`/${short.code}`)).status).toBe(410);
  });
  test('anonymous phishing-shaped links need an account', async () => {
    const res = await req('/api/v1/links', { method: 'POST', json: { url: 'https://secure-login-verify.xyz/account/unlock' } });
    expect(res.status).toBe(403);
  });
  test('expand is public', async () => {
    const r = await (await req(`/api/v1/expand?url=${encodeURIComponent(`${SITE}/${link.code}`)}`)).json();
    expect(r.url).toBe('https://example.com/a?b=1');
  });
});

d('accounts, plans and money', () => {
  let alice;
  test('a magic link makes the account and a session', async () => {
    alice = await signIn('alice@example.test');
    const page = await req('/account', { headers: { cookie: alice.cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('alice@example.test');
  });
  test('free accounts cannot alias or mint API keys', async () => {
    const a = await req('/api/v1/links', { method: 'POST', headers: { cookie: alice.cookie }, json: { url: 'https://example.com', alias: 'alice-x' } });
    expect(a.status).toBe(402);
    const k = await req('/api/v1/keys', { method: 'POST', headers: { cookie: alice.cookie }, json: {} });
    expect(k.status).toBe(402);
  });
  test('a settled CoinPay payment turns Pro on, and her links stop showing the ad page', async () => {
    const own = await (await req('/api/v1/links', { method: 'POST', headers: { cookie: alice.cookie }, json: { url: 'https://example.com/alice' } })).json();
    const ref = `pay_${randomBytes(4).toString('hex')}`;
    await db()`insert into payments (user_id, provider, provider_ref, amount_cents, status) values (${alice.user.id}, 'coinpay', ${ref}, 500, 'pending')`;
    const body = JSON.stringify({ type: 'payment.confirmed', data: { payment_id: ref, status: 'confirmed', metadata: { user_id: alice.user.id, product: 'plan', plan: 'pro', term: 'month', kind: 'new' } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}`;
    const res = await req('/webhooks/coinpay', { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinpay-signature': sig }, body });
    expect(res.status).toBe(200);
    // Replayed: still one period.
    await req('/webhooks/coinpay', { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinpay-signature': sig }, body });
    const periods = await db()`select plan from plan_periods where user_id = ${alice.user.id}`;
    expect(periods.map((p) => p.plan)).toEqual(['pro']);
    links.clearCache();
    const hit = await req(`/${own.code}`, { headers: { 'user-agent': CHROME } });
    expect(hit.status).toBe(302);
    expect(hit.headers.get('cache-control')).toBe('private, no-cache');
  });
  test('a forged webhook is refused', async () => {
    const res = await req('/webhooks/coinpay', { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinpay-signature': 't=1,v1=00' }, body: '{}' });
    expect(res.status).toBe(401);
  });
  test('Pro: God Mode key, alias, 301, stats', async () => {
    const k = await (await req('/api/v1/keys', { method: 'POST', headers: { cookie: alice.cookie }, json: { name: 'agent' } })).json();
    expect(k.key).toStartWith('wx93_live_');
    const h = { authorization: `Bearer ${k.key}` };
    const l = await req('/api/v1/links', { method: 'POST', headers: h, json: { url: 'https://example.org/launch', alias: 'launch-day', redirect_type: 301 } });
    expect(l.status).toBe(201);
    const dup = await req('/api/v1/links', { method: 'POST', headers: h, json: { url: 'https://example.org/2', alias: 'launch-day' } });
    expect(dup.status).toBe(409);
    const r = await req('/launch-day', { headers: { 'user-agent': CHROME, referer: 'https://news.example.com/x' } });
    expect(r.status).toBe(301);
    expect(r.headers.get('cache-control')).toBe('public, max-age=3600');
    await links.flushClicks();
    const s = await (await req('/api/v1/links/launch-day/stats', { headers: h })).json();
    expect(s.humans).toBe(1);
    expect(s.referrers[0].key).toBe('news.example.com');
    expect(s.devices[0].key).toBe('desktop');
    const bulk = await req('/api/v1/links/bulk', { method: 'POST', headers: h, json: { links: ['https://a.example'] } });
    expect(bulk.status).toBe(402);
    const patched = await (await req('/api/v1/links/launch-day', { method: 'PATCH', headers: h, json: { url: 'https://example.org/moved' } })).json();
    expect(patched.url).toBe('https://example.org/moved');
    expect((await req('/launch-day', { headers: { 'user-agent': 'curl/8' } })).headers.get('location')).toBe('https://example.org/moved');
    expect((await req('/api/v1/links/launch-day', { method: 'DELETE', headers: h })).status).toBe(200);
    expect((await req('/launch-day')).status).toBe(404);
  });
});

d('OAuth 2.1 for the CLI', () => {
  test('authorization code + PKCE, then a rotating refresh', async () => {
    const { cookie } = await signIn('bob@example.test');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: 'wx93-cli', redirect_uri: 'http://127.0.0.1:53111/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', scope: 'read write' });
    const consent = await req(`/oauth/authorize?${q}`, { headers: { cookie } });
    expect(consent.status).toBe(200);
    const allow = await req('/oauth/authorize', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: SITE }, body: `${q}&decision=allow` });
    expect(allow.status).toBe(302);
    const code = new URL(allow.headers.get('location')).searchParams.get('code');
    const tok = await (await req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:53111/callback', client_id: 'wx93-cli', code_verifier: verifier }).toString() })).json();
    expect(tok.access_token).toStartWith('wx93_at_');
    const me = await (await req('/api/v1/me', { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
    expect(me.user.email).toBe('bob@example.test');
    expect(me.user.via).toBe('oauth');
    const again = await (await req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: 'wx93-cli' }).toString() })).json();
    expect(again.refresh_token).not.toBe(tok.refresh_token);
  });
});

d('abuse', () => {
  test('reports from distinct people pull a link', async () => {
    const l = await (await req('/api/v1/links', { method: 'POST', json: { url: 'https://example.com/bad' } })).json();
    for (const who of ['203.0.113.1', '203.0.113.2']) {
      const r = await req('/api/v1/reports', { method: 'POST', headers: { 'x-real-ip': who }, json: { url: l.short_url, reason: 'phishing' } });
      expect(r.status).toBe(202);
    }
    expect((await req(`/${l.code}`)).status).toBe(410);
  });
  test('the blocklist refuses a destination and its subdomains', async () => {
    await db()`insert into blocklist (domain, reason) values ('blocked-test.com', 'test')`;
    const r = await req('/api/v1/links', { method: 'POST', json: { url: 'https://sub.blocked-test.com/x' } });
    expect(r.status).toBe(403);
  });
  test('the HTML forms drop a bot that never rendered the page', async () => {
    const res = await req('/shorten', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'url=https%3A%2F%2Fexample.com' });
    expect(res.status).toBe(303);
  });
  test('/healthz touches the database', async () => {
    expect((await req('/healthz')).status).toBe(200);
  });
});

d('canonical host', () => {
  test('www on the primary 301s to the apex', async () => {
    const res = await app.fetch(new Request('http://www.localhost:3999/docs?a=1', { headers: { host: 'www.localhost' } }));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${SITE}/docs?a=1`);
  });
});

d('QR codes', () => {
  let pro;
  let free;
  let h;
  let menu;
  const scan = async (png) => {
    const { readBarcodes } = await import('zxing-wasm/reader');
    return (await readBarcodes(new Blob([png]), { formats: ['QRCode'], tryHarder: true })).map((r) => r.text);
  };
  const bytes = async (res) => Buffer.from(await res.arrayBuffer());

  test('a dynamic code: styled, a short link underneath, every format scans', async () => {
    pro = await signIn('qr-pro@example.test');
    await db()`insert into plan_periods (user_id, plan, term, starts_at, ends_at) values (${pro.user.id}, 'pro', 'month', now() - interval '1 day', now() + interval '30 days')`;
    h = { cookie: pro.cookie };
    const res = await req('/api/v1/qr', {
      method: 'POST',
      headers: h,
      json: { type: 'url', data: { url: 'https://example.com/menu' }, name: 'Table menu', style: { fg: '#1d4ed8', dots: 'dots', eye_frame: 'circle', eye_ball: 'circle' } },
    });
    expect(res.status).toBe(201);
    menu = await res.json();
    expect(menu).toMatchObject({ type: 'url', dynamic: true, name: 'Table menu', scans: 0, logo: false });
    expect(menu.encodes).toBe(`${menu.short_url}?qr`);
    expect(menu.style.dots).toBe('dots');

    const png = await req(`/api/v1/qr/${menu.id}/image.png?size=600`, { headers: h });
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(await scan(await bytes(png))).toEqual([menu.encodes]);
    const svg = await (await req(`/api/v1/qr/${menu.id}/image.svg`, { headers: h })).text();
    expect(svg).toContain('fill="#1d4ed8"');
    const pdf = await req(`/api/v1/qr/${menu.id}/image.pdf`, { headers: h });
    expect((await bytes(pdf)).subarray(0, 5).toString()).toBe('%PDF-');
    // The public image of its short link wears the saved design too.
    expect(await (await req(`/qr/${menu.link.code}.svg`)).text()).toContain('fill="#1d4ed8"');
    expect((await req(`/api/v1/qr/${menu.id}/image.png`)).status).toBe(401);
  });

  test('scans and clicks are counted apart, with unique visitors, a heatmap and live numbers', async () => {
    const at = { 'user-agent': CHROME, 'x-real-ip': '203.0.113.7' };
    expect((await req(`/${menu.link.code}?qr`, { headers: at })).status).toBe(302);
    expect((await req(`/${menu.link.code}?qr`, { headers: at })).status).toBe(302);
    expect((await req(`/${menu.link.code}`, { headers: { 'user-agent': CHROME, 'x-real-ip': '203.0.113.8' } })).status).toBe(302);
    await req(`/${menu.link.code}?qr`, { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' } });
    await links.flushClicks();
    const s = await (await req(`/api/v1/qr/${menu.id}/stats?tz=America/New_York`, { headers: h })).json();
    expect(s).toMatchObject({ humans: 3, scans: 2, visitors: 2, bots: 1, tz: 'America/New_York' });
    expect(s.sources).toEqual([
      { key: 'qr', clicks: 2 },
      { key: 'link', clicks: 1 },
    ]);
    expect(s.heatmap).toHaveLength(7);
    expect(s.heatmap.every((r) => r.length === 24)).toBe(true);
    expect(s.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(3);
    expect(s.week.this_week).toBe(3);
    expect(s.live.last_hour).toBe(3);
    expect(s.live.recent[0]).toHaveProperty('source');
    const onlyScans = await (await req(`/api/v1/qr/${menu.id}/stats?source=qr`, { headers: h })).json();
    expect(onlyScans.humans).toBe(2);
    // The link's own stats carry the same split.
    const ls = await (await req(`/api/v1/links/${menu.link.code}/stats`, { headers: h })).json();
    expect(ls.scans).toBe(2);
    expect((await req(`/api/v1/qr/${menu.id}`, { headers: h }).then((r) => r.json())).scans).toBe(3);
  });

  test('editing: the destination moves, the printed code does not; the type is fixed', async () => {
    const r = await req(`/api/v1/qr/${menu.id}`, { method: 'PATCH', headers: h, json: { data: { url: 'https://example.com/menu-winter' }, style: { fg: '#7c3aed' } } });
    expect(r.status).toBe(200);
    const q = await r.json();
    expect(q.encodes).toBe(menu.encodes);
    expect(q.style.fg).toBe('#7c3aed');
    expect((await req(`/${menu.link.code}`, { headers: { 'user-agent': 'curl/8' } })).headers.get('location')).toBe('https://example.com/menu-winter');
    expect((await req(`/api/v1/qr/${menu.id}`, { method: 'PATCH', headers: h, json: { type: 'wifi' } })).status).toBe(400);
    expect((await req(`/api/v1/qr/${menu.id}`, { method: 'PATCH', headers: h, json: { style: { fg: '#fefefe' } } })).status).toBe(400);
  });

  test('a logo: PNG in, still scans; SVG refused', async () => {
    const logo = await (await req('/qr/make.png?type=text&text=x&fg=%23ff0066&size=64')).arrayBuffer();
    // Any PNG will do as a logo; this one is a QR code, so read the big code by its text.
    const put = await req(`/api/v1/qr/${menu.id}/logo`, { method: 'PUT', headers: { ...h, 'content-type': 'image/png' }, body: logo });
    expect(put.status).toBe(200);
    expect((await put.json()).logo).toBe(true);
    const png = await bytes(await req(`/api/v1/qr/${menu.id}/image.png?size=700`, { headers: h }));
    expect(await scan(png)).toContain(menu.encodes);
    const bad = await req(`/api/v1/qr/${menu.id}/logo`, { method: 'PUT', headers: { ...h, 'content-type': 'image/svg+xml' }, body: '<svg onload="alert(1)"/>' });
    expect(bad.status).toBe(415);
    expect((await (await req(`/api/v1/qr/${menu.id}/logo`, { method: 'DELETE', headers: h })).json()).logo).toBe(false);
  });

  test('hosted pages: a contact card, an event and a link list', async () => {
    const card = await (await req('/api/v1/qr', { method: 'POST', headers: h, json: { type: 'vcard', data: { first: 'Ada', last: 'Lovelace', email: 'ada@example.com' } } })).json();
    expect(card.landing_url).toBe(`${SITE}/p/${card.id}`);
    const hop = await req(`/${card.link.code}?qr`, { headers: { 'user-agent': 'curl/8' } });
    expect(hop.headers.get('location')).toBe(card.landing_url);
    const page = await req(`/p/${card.id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`/p/${card.id}.vcf`);
    const vcf = await req(`/p/${card.id}.vcf`);
    expect(vcf.headers.get('content-type')).toContain('text/vcard');
    expect(await vcf.text()).toContain('FN:Ada Lovelace');

    const ev = await (await req('/api/v1/qr', { method: 'POST', headers: h, json: { type: 'event', data: { title: 'Launch', start: '2026-11-02T18:30', tz: 'America/Los_Angeles' } } })).json();
    expect(await (await req(`/p/${ev.id}.ics`)).text()).toContain('DTSTART;TZID=America/Los_Angeles:20261102T183000');
    expect((await req(`/p/${ev.id}.vcf`)).status).toBe(404);

    const list = await (await req('/api/v1/qr', { method: 'POST', headers: h, json: { type: 'links', data: { title: 'Find me', links: 'Blog | https://blog.example.com\nhttps://shop.example.com' } } })).json();
    const html = await (await req(`/p/${list.id}`)).text();
    expect(html).toContain('https://blog.example.com/');
    expect(html).toContain('shop.example.com');
    expect((await req('/p/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    // A hosted page's links get the same destination checks as a short link.
    const blocked = await req('/api/v1/qr', { method: 'POST', headers: h, json: { type: 'links', data: { title: 'x', links: 'Win | https://win.blocked-test.com/' } } });
    expect(blocked.status).toBe(403);
  });

  test('a static Wi-Fi code: no link, nothing to count, scans to its join string', async () => {
    const wifi = await (await req('/api/v1/qr', { method: 'POST', headers: h, json: { type: 'wifi', data: { ssid: 'Guest', password: 'welcome!' } } })).json();
    expect(wifi).toMatchObject({ dynamic: false, short_url: null, encodes: 'WIFI:T:WPA;S:Guest;P:welcome!;;', summary: 'Guest' });
    expect((await (await req(`/api/v1/qr/${wifi.id}/stats`, { headers: h })).json()).static).toBe(true);
    expect(await scan(await bytes(await req(`/api/v1/qr/${wifi.id}/image.png`, { headers: h })))).toEqual([wifi.encodes]);
    const all = await (await req('/api/v1/qr', { headers: h })).json();
    expect(all.qr_codes.map((q) => q.id)).toContain(wifi.id);
    expect(all.limit).toBe(1000);
  });

  test('Free keeps ten codes and gets totals only', async () => {
    free = await signIn('qr-free@example.test');
    const fh = { cookie: free.cookie };
    let first;
    for (let i = 0; i < 10; i++) {
      const r = await req('/api/v1/qr', { method: 'POST', headers: fh, json: { type: i ? 'text' : 'url', data: i ? { text: `note ${i}` } : { url: 'https://example.com/free' } } });
      expect(r.status).toBe(201);
      if (!i) first = await r.json();
    }
    const over = await req('/api/v1/qr', { method: 'POST', headers: fh, json: { type: 'text', data: { text: 'eleven' } } });
    expect(over.status).toBe(429);
    const s = await (await req(`/api/v1/qr/${first.id}/stats`, { headers: fh })).json();
    expect(s.upgrade).toBeDefined();
    expect(s.heatmap).toBeUndefined();
    expect((await req('/api/v1/qr', { method: 'POST', json: { type: 'text', data: { text: 'anon' } } })).status).toBe(401);
  });

  test('deleting a dynamic code takes its short link with it', async () => {
    const q = await (await req('/api/v1/qr', { method: 'POST', headers: h, json: { type: 'url', data: { url: 'https://example.com/gone' } } })).json();
    expect((await req(`/api/v1/qr/${q.id}`, { method: 'DELETE', headers: h })).status).toBe(200);
    expect((await req(`/${q.link.code}`, { headers: { 'user-agent': 'curl/8' } })).status).toBe(404);
    expect((await req(`/api/v1/qr/${q.id}`, { headers: h })).status).toBe(404);
  });

  test('the pages work with JavaScript off', async () => {
    expect((await req('/qr')).status).toBe(200);
    const made = await req('/qr', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'type=wifi&ssid=Cafe&password=latte&dots=rounded' });
    const html = await made.text();
    expect(made.status).toBe(200);
    expect(html).toContain('<svg');
    expect(html).toContain('action="/qr/make.png?download"');
    const dl = await req('/qr/make.png?download', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'type=wifi&ssid=Cafe&password=latte' });
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect(await scan(await bytes(dl))).toEqual(['WIFI:T:WPA;S:Cafe;P:latte;;']);
    expect((await req('/qr/make.svg?type=email&to=nope')).status).toBe(400);

    const form = await req('/account/qr', { method: 'POST', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: 'type=url&url=https%3A%2F%2Fexample.com%2Fform&name=From+a+form&fg=%23000000&bg=%23ffffff&dots=rounded' });
    expect(form.status).toBe(303);
    const detail = await req(form.headers.get('location'), { headers: h });
    const page = await detail.text();
    expect(page).toContain('From a form');
    expect(page).toContain('class="heat"');
    const list = await (await req('/account/qr', { headers: h })).text();
    expect(list).toContain('From a form');
    const restyle = await req(`${form.headers.get('location')}/style`, { method: 'POST', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: 'fg=%23eeeeee&bg=%23ffffff' });
    expect(restyle.status).toBe(400);
    expect(await restyle.text()).toContain('too close to scan');
  });

  test('9xq.me serves a code in every format', async () => {
    const res = await app.fetch(new Request(`http://9xq.me/qr/${menu.link.code}.png`, { headers: { host: '9xq.me', 'x-real-ip': ip() } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  test('the hosted MCP makes a code and returns its picture', async () => {
    const k = await (await req('/api/v1/keys', { method: 'POST', headers: h, json: { name: 'qr-agent' } })).json();
    const res = await req('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${k.key}` },
      json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_qr_code', arguments: { type: 'sms', data: { number: '+14085550100', message: 'hi' } } } },
    });
    const { result } = await res.json();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toStartWith('SMSTO:+14085550100:hi');
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });
});

d('signup profile (@profullstack/profile)', () => {
  const formPost = (fields) =>
    req('/auth/link', {
      method: 'POST',
      headers: { 'user-agent': CHROME, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams(fields).toString(),
    });
  const hidden = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));

  test('signup asks for the fields, sign-in does not', async () => {
    const signup = await (await req('/signup')).text();
    for (const name of ['first_name', 'last_name', 'company_domain', 'job_title', 'linkedin_url'])
      expect(signup.match(new RegExp(`name="${name}"`, 'g'))?.length).toBe(1);
    // The shared footer's newsletter form (@profullstack/footer 0.3+) has its own email field.
    const signupForm = signup.slice(0, signup.indexOf('class="pfs-footer'));
    expect(signupForm.match(/name="email"/g)?.length).toBe(1);
    expect(signup).toContain('name="mode" value="signup"');
    expect(signup).toContain('src="/assets/profile.js"');
    const signin = await (await req('/signin')).text();
    expect(signin).not.toContain('name="first_name"');
    expect(signin).not.toContain('name="mode"');
    expect((await req('/assets/profile.js')).headers.get('content-type')).toContain('javascript');
  });

  test('a signup without a last name is refused before any link exists', async () => {
    const res = await formPost({ mode: 'signup', email: 'nolast@acme.example', first_name: 'Ada' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('value="Ada"');
    expect(html).toContain('pfs-profile__error');
    const [{ n }] = await db()`select count(*)::int as n from login_tokens where email = 'nolast@acme.example'`;
    expect(n).toBe(0);
  });

  test('signup fields ride the token and are saved when the link is spent', async () => {
    const email = 'ada@acme.example';
    const guard = hidden(await (await req('/signup', { headers: { 'user-agent': CHROME } })).text());
    await Bun.sleep(1300); // the form guard refuses a form filled faster than a person can
    const res = await formPost({
      ...guard,
      mode: 'signup',
      email: 'Ada@Acme.example',
      first_name: 'Ada',
      last_name: 'Lovelace',
      company_domain: 'https://www.acme.example/about',
      job_title: 'VP Engineering',
      linkedin_url: 'in/ada-lovelace',
    });
    expect(res.status).toBe(200);
    const [token] = await db()`select profile from login_tokens where email = ${email}`;
    expect(token?.profile).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace', job_title: 'VP Engineering' });

    // The route's link went to the mailer; mint one the same way to spend it here.
    const url = new URL(await auth.createLoginLink(email, { profile: token.profile }));
    const spent = await req(url.pathname + url.search);
    expect(spent.status).toBe(302);
    const cookie = spent.headers.get('set-cookie').split(';')[0];
    const me = await req('/api/v1/me/profile', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).profile).toMatchObject({
      email,
      first_name: 'Ada',
      last_name: 'Lovelace',
      company_domain: 'acme.example',
      job_title: 'VP Engineering',
      linkedin_url: 'https://www.linkedin.com/in/ada-lovelace',
    });
    const [{ n }] = await db()`select count(*)::int as n from login_tokens where email = ${email} and used_at is not null and profile is not null`;
    expect(n).toBe(0);
    expect(await (await req('/account', { headers: { cookie } })).text()).toContain('value="Lovelace"');
  });

  test('plain sign-in carries no profile, and the profile API is 401 signed out', async () => {
    const guard = hidden(await (await req('/signin', { headers: { 'user-agent': CHROME } })).text());
    await Bun.sleep(1300);
    expect((await formPost({ ...guard, email: 'plain@acme.example' })).status).toBe(200);
    const [row] = await db()`select profile from login_tokens where email = 'plain@acme.example'`;
    expect(row.profile).toBeNull();
    const res = await req('/api/v1/me/profile');
    expect(res.status).toBe(401);
  });
});

d('credit codes and invites', () => {
  const magic = async (email, opts = {}) => {
    const url = new URL(await auth.createLoginLink(email, opts));
    return req(url.pathname + url.search, { headers: opts.cookie ? { cookie: opts.cookie } : {} });
  };
  const cookieOf = (res) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('wx93_session='));
  const planOf = async (cookie) => (await (await req('/api/v1/me', { headers: { cookie } })).json()).plan;

  test('staff mint a pro_days code; it redeems once, adds days of Pro, and is refused after', async () => {
    const staff = await signIn('staff@example.test');
    const mint = await req('/admin/credits', { method: 'POST', headers: { cookie: staff.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'days=30&max_redemptions=1&label=Preshy' });
    const page = await mint.text();
    const code = page.match(/value="(CR-[0-9A-Z-]+)"/)[1];
    expect(page).toContain('Preshy');
    // Only the hash is stored.
    const [{ n }] = await db()`select count(*)::int as n from credit_codes where hash = ${code}`;
    expect(n).toBe(0);

    const bob = await signIn('credit-bob@acme.example');
    expect(await planOf(bob.cookie)).toMatchObject({ key: 'free' });
    const r = await req('/api/v1/credits/redeem', { method: 'POST', headers: { cookie: bob.cookie }, json: { code: code.toLowerCase().replace(/-/g, ' ') } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, unit: 'pro_days', days: 30, plan: 'pro' });
    const [p] = await db()`select grant_source, ends_at - starts_at as span from plan_periods where user_id = ${bob.user.id}`;
    expect(p.grant_source).toMatch(/^code:/);

    const again = await req('/api/v1/credits/redeem', { method: 'POST', headers: { cookie: bob.cookie }, json: { code } });
    expect(again.status).toBe(400);
    expect((await again.json()).reason).toBe('already_redeemed');
    const carol = await signIn('credit-carol@acme.example');
    const used = await req('/account/redeem', { method: 'POST', headers: { cookie: carol.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${code}` });
    expect(await used.text()).toContain('already been used');
    const [{ periods }] = await db()`select count(*)::int as periods from plan_periods where user_id = ${carol.user.id}`;
    expect(periods).toBe(0);
  });

  test('only staff can mint', async () => {
    const eve = await signIn('mint-eve@acme.example');
    expect((await req('/api/v1/admin/credits', { method: 'POST', headers: { cookie: eve.cookie }, json: { days: 365 } })).status).toBe(403);
    expect((await req('/admin/credits', { method: 'POST', headers: { cookie: eve.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'days=365' })).status).toBe(303);
  });

  test('granted days are not money: an upgrade credits none of them, and a paid month queues after them', async () => {
    const { priceQuote } = await import('../apps/web/src/billing.js');
    const now = Date.now();
    const periods = [{ plan: 'pro', term: 'month', starts_at: new Date(now - 86400_000), ends_at: new Date(now + 20 * 86400_000), grant_source: 'code:x' }];
    expect(priceQuote({ now, current: 'pro', staff: false, periods, target: 'automation', term: 'month' }).credit_cents).toBe(0);
    const { grantProDays } = await import('../apps/web/src/credits.js');
    const u = await auth.findOrCreateUser('grant-twice@acme.example');
    expect(await grantProDays(u.id, 10, 'test:once')).not.toBeNull();
    expect(await grantProDays(u.id, 10, 'test:once')).toBeNull();
  });

  test('/i/<code> sets the invite, the emailed link carries it, and both sides get the bonus once', async () => {
    const ann = await signIn('inviter-ann@acme.example');
    const made = await req('/api/v1/invites', { method: 'POST', headers: { cookie: ann.cookie }, json: { note: 'for Dan' } });
    expect(made.status).toBe(201);
    const inv = await made.json();
    expect(inv.url).toBe(`${SITE}/i/${inv.code}`);

    // The landing page is never behind the throttle, and answers with the cookie.
    const land = await req(`/i/${inv.code}`, { headers: { 'user-agent': CHROME } });
    expect(land.status).toBe(200);
    expect(land.headers.get('set-cookie')).toContain(`wx93_invite=${inv.code}`);
    const signup = await req('/signup', { headers: { cookie: `wx93_invite=${inv.code}` } });
    expect(await signup.text()).toContain(`name="invite" value="${inv.code}"`);

    // Opened in another browser: no cookie, the invite rides the link.
    const spent = await magic('invitee-dan@newco.example', { invite: inv.code });
    expect(spent.status).toBe(302);
    expect(spent.headers.get('location')).toBe('/account?invited=1');
    const dan = cookieOf(spent);
    expect(await planOf(dan)).toMatchObject({ key: 'pro' });
    expect(await planOf(ann.cookie)).toMatchObject({ key: 'pro' });
    expect(await (await req('/account?invited=1', { headers: { cookie: dan } })).text()).toContain('Your invite added 7 days of Pro');

    // Used: nobody else can take it, and Dan cannot take a second invite.
    const again = await magic('invitee-erin@newco.example', { invite: inv.code });
    expect(again.headers.get('location')).toBe('/account');
    const second = await (await req('/api/v1/invites', { method: 'POST', headers: { cookie: ann.cookie }, json: {} })).json();
    const danUser = (await db()`select * from users where email = 'invitee-dan@newco.example'`)[0];
    const { acceptInvite } = await import('../apps/web/src/credits.js');
    expect((await acceptInvite({ ...danUser }, second.code, { created: true })).ok).toBe(false);

    const state = await (await req('/api/v1/invites', { headers: { cookie: ann.cookie } })).json();
    expect(state).toMatchObject({ quota: { total: 3, used: 2, left: 1 }, accepted: 1, bonus_days: 7 });
    expect(JSON.stringify(state)).not.toContain('invitee-dan');
  });

  test('no bonus for an existing account, a throwaway address or a mailbox alias of an account', async () => {
    const ann = await signIn('inviter-gate@acme.example');
    const code = async () => (await (await req('/api/v1/invites', { method: 'POST', headers: { cookie: ann.cookie }, json: {} })).json()).code;

    const c1 = await code();
    await auth.findOrCreateUser('already-here@acme.example');
    const old = await magic('already-here@acme.example', { invite: c1 });
    expect(old.headers.get('location')).toBe('/account');

    const throwaway = await magic('someone@mailinator.com', { invite: c1 });
    expect(throwaway.headers.get('location')).toBe('/account');

    await auth.findOrCreateUser('real.person@gmail.com');
    const alias = await magic('realperson+wx@gmail.com', { invite: c1 });
    expect(alias.headers.get('location')).toBe('/account');

    // Still unused after three refusals.
    const fine = await magic('fresh-person@otherco.example', { invite: c1 });
    expect(fine.headers.get('location')).toBe('/account?invited=1');
    const [{ n }] = await db()`select count(*)::int as n from invite_bonuses where inviter_id = ${ann.user.id}`;
    expect(n).toBe(1);
  });

  test('invite paths never collide with short links', async () => {
    const { aliasProblem } = await import('../apps/web/src/codes.js');
    for (const a of ['invites', 'Invites', 'redeem', 'credits', 'invite']) expect(aliasProblem(a)).toContain('reserved');
    const bad = await req('/i/<script>', { headers: { 'user-agent': CHROME } });
    expect(bad.status).toBe(404);
    // On the second short domain the invite pages go to the brand host.
    const alt = await req('/i/INV-AAAA-BBBB-CCCC', { headers: { host: '9xq.me' } });
    expect(alt.status).toBe(301);
    expect(alt.headers.get('location')).toBe(`${SITE}/i/INV-AAAA-BBBB-CCCC`);
  });

  test('sign-in next only goes to a same-origin path', async () => {
    const u = 'next-check@acme.example';
    for (const next of ['/\\evil.example', '//evil.example', '/\t/evil.example']) {
      const url = new URL(await auth.createLoginLink(u));
      const res = await req(`${url.pathname}${url.search}&next=${encodeURIComponent(next)}`);
      expect(res.headers.get('location')).toBe('/account');
    }
  });
});

d('customer webhooks (@profullstack/webhooks)', () => {
  let owner, h;
  test('the API needs a key, and creating one needs Automation', async () => {
    expect((await req('/api/v1/webhooks')).status).toBe(401);
    expect((await req('/api/v1/webhooks/whatever/test', { method: 'POST' })).status).toBe(401);
    owner = await signIn('hooks@example.test');
    h = { cookie: owner.cookie };
    const free = await req('/api/v1/webhooks', { method: 'POST', headers: h, json: { url: 'https://example.com/hooks/wx93' } });
    expect(free.status).toBe(402);
    await db()`insert into plan_periods (user_id, plan, term, starts_at, ends_at) values (${owner.user.id}, 'automation', 'month', now() - interval '1 day', now() + interval '30 days')`;
  });

  test('an endpoint from the old webhooks table keeps its id and secret, and clicks queue a delivery for it', async () => {
    // Migration 0005 ran in beforeAll on an empty table; run its copy step again on a row in the old shape.
    const migration = await Bun.file(new URL('../packages/db/migrations/0005_webhooks_hub.sql', import.meta.url)).text();
    const copy = migration.slice(migration.indexOf('insert into webhook_endpoints'), migration.indexOf('on conflict (id) do nothing;') + 'on conflict (id) do nothing;'.length);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const [old] = await db()`
      insert into webhooks_legacy (user_id, url, secret, events, failures)
      values (${owner.user.id}, 'https://example.com/hooks/old', ${secret}, '{link.created,link.clicked}', 2) returning id`;
    await db().unsafe(copy.replace('from webhooks w', 'from webhooks_legacy w'));

    const list = await (await req('/api/v1/webhooks', { headers: h })).json();
    expect(list.event_types).toEqual(['link.created', 'link.clicked']);
    const ep = list.endpoints.find((e) => e.id === old.id);
    expect(ep).toMatchObject({ url: 'https://example.com/hooks/old', events: ['link.created', 'link.clicked'], enabled: true, failures: 2 });
    expect(list.webhooks).toEqual(list.endpoints); // the pre-hub response key
    expect((await (await req(`/api/v1/webhooks/${old.id}/secret`, { headers: h })).json()).secret).toBe(secret);

    // A link of theirs, clicked by a person: one link.created and one link.clicked queued (the drainer is not running in tests).
    const link = await (await req('/api/v1/links', { method: 'POST', headers: h, json: { url: 'https://example.org/hooked' } })).json();
    links.clearCache();
    await req(`/${link.code}`, { headers: { 'user-agent': CHROME } });
    await Bun.sleep(100);
    const log = await (await req(`/api/v1/webhooks/${old.id}/deliveries`, { headers: h })).json();
    expect(log.deliveries.map((x) => x.event_type).sort()).toEqual(['link.clicked', 'link.created']);
    const clicked = log.deliveries.find((x) => x.event_type === 'link.clicked');
    expect(clicked.payload).toMatchObject({ type: 'link.clicked', source: SITE, subject: `link:${link.code}`, data: { link: { code: link.code } } });
  });

  test('create, change, rotate and delete through the API', async () => {
    const res = await req('/api/v1/webhooks', { method: 'POST', headers: h, json: { url: 'https://example.com/hooks/new', events: ['link.created'] } });
    expect(res.status).toBe(201);
    const made = await res.json();
    expect(made.secret).toStartWith('whsec_');
    expect(made.endpoint.events).toEqual(['link.created']);
    expect(made.id).toBe(made.endpoint.id); // the pre-hub response shape too
    const bad = await req('/api/v1/webhooks', { method: 'POST', headers: h, json: { url: 'https://example.com/x', events: ['room.joined'] } });
    expect(bad.status).toBe(400);
    const http = await req('/api/v1/webhooks', { method: 'POST', headers: h, json: { url: 'http://example.com/x' } });
    expect(http.status).toBe(400);
    const off = await (await req(`/api/v1/webhooks/${made.id}`, { method: 'PATCH', headers: h, json: { enabled: false } })).json();
    expect(off.enabled).toBe(false);
    const rotated = await (await req(`/api/v1/webhooks/${made.id}/rotate`, { method: 'POST', headers: h })).json();
    expect(rotated.secret).not.toBe(made.secret);
    // Someone else's id is not found.
    const other = await signIn('not-the-owner@example.test');
    expect((await req(`/api/v1/webhooks/${made.id}`, { headers: { cookie: other.cookie } })).status).toBe(404);
    expect((await req(`/api/v1/webhooks/${made.id}`, { method: 'DELETE', headers: h })).status).toBe(200);
    expect((await req(`/api/v1/webhooks/${made.id}`, { headers: h })).status).toBe(404);
  });

  test('the account page lists them with test, new secret, off and delete', async () => {
    const page = await (await req('/account', { headers: { ...h, 'user-agent': CHROME } })).text();
    expect(page).toContain('https://example.com/hooks/old');
    for (const action of ['test', 'rotate', 'disable', 'delete']) expect(page).toMatch(new RegExp(`/account/webhooks/[^"]+/${action}"`));
    expect(page).toContain('name="events" value="link.clicked"');
    const form = new URLSearchParams([['url', 'https://example.com/hooks/form'], ['events', 'link.clicked']]);
    const added = await (await req('/account/webhooks', { method: 'POST', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })).text();
    expect(added).toMatch(/signing secret \(shown once\): <code>whsec_/);
    const mine = await (await req('/api/v1/webhooks', { headers: h })).json();
    expect(mine.endpoints.find((e) => e.url === 'https://example.com/hooks/form').events).toEqual(['link.clicked']);
  });
});
