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
