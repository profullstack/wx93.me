/**
 * Sign in with CoinPay (apps/web/src/coinpay.js). The decision logic runs against
 * an in-memory store; with DATABASE_URL the real routes and pgStore run too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

process.env.SITE_URL = 'https://wx93.me';
process.env.COINPAY_OAUTH_CLIENT_ID = 'cp_test';
process.env.COINPAY_OAUTH_CLIENT_SECRET = 'cps_test';

const CP = await import('../apps/web/src/coinpay.js');
const K = await import('../apps/web/src/credits.js');

function memory() {
  const users = new Map([['victim', { email: 'victim@example.com' }]]);
  const ids = [];
  let n = 0;
  const store = {
    async identityBySub(sub) {
      return ids.find((i) => i.coinpay_sub === sub) ?? null;
    },
    async identityByUser(u) {
      return ids.find((i) => i.user_id === u) ?? null;
    },
    async link(row) {
      if (ids.some((i) => i.coinpay_sub === row.coinpay_sub || i.user_id === row.user_id)) return 'conflict';
      ids.push(row);
      return 'ok';
    },
    async unlink(u) {
      const i = ids.findIndex((x) => x.user_id === u);
      if (i >= 0) ids.splice(i, 1);
    },
    async touch() {},
    async createUser() {
      const id = `new-${++n}`;
      users.set(id, { email: CP.placeholderEmail() });
      return id;
    },
    async deleteUser(u) {
      users.delete(u);
    },
  };
  return { store, users, ids };
}

let m;
beforeEach(() => {
  m = memory();
});

const claims = (sub, email = null, name = null) => ({ sub, email, name });

describe('STANDING rule: bind by CoinPay sub, never by email', () => {
  test("a CoinPay login carrying an existing user's email does NOT get that account", async () => {
    const r = await CP.resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('attacker', 'victim@example.com', 'Mallory') }, m.store);
    expect(r.ok).toBe(true);
    expect(r.action).toBe('created');
    expect(r.userId).not.toBe('victim');
    expect(CP.isPlaceholderEmail(m.users.get(r.userId).email)).toBe(true);
    expect(await m.store.identityByUser('victim')).toBeNull();
    expect((await m.store.identityBySub('attacker')).coinpay_email).toBe('victim@example.com');
  });

  test('the same sub comes back to the same account', async () => {
    const a = await CP.resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('s1') }, m.store);
    const b = await CP.resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('s1', 'other@example.com') }, m.store);
    expect(b).toEqual({ ok: true, userId: a.userId, action: 'login' });
  });

  test('linking needs a signed-in session', async () => {
    const r = await CP.resolveCoinpayUser({ mode: 'connect', currentUserId: null, claims: claims('s', 'victim@example.com') }, m.store);
    expect(r).toMatchObject({ ok: false, code: 'not_signed_in' });
    expect(m.ids).toHaveLength(0);
  });

  test('after Connect, a CoinPay login reaches the connected account', async () => {
    expect(await CP.resolveCoinpayUser({ mode: 'connect', currentUserId: 'victim', claims: claims('vs') }, m.store)).toEqual({ ok: true, userId: 'victim', action: 'linked' });
    expect(await CP.resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('vs') }, m.store)).toEqual({ ok: true, userId: 'victim', action: 'login' });
  });

  test('a sub linked elsewhere, or a second CoinPay account, is refused', async () => {
    await CP.resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('s') }, m.store);
    expect(await CP.resolveCoinpayUser({ mode: 'connect', currentUserId: 'victim', claims: claims('s') }, m.store)).toMatchObject({ ok: false, code: 'linked_elsewhere' });
    await CP.resolveCoinpayUser({ mode: 'connect', currentUserId: 'victim', claims: claims('s2') }, m.store);
    expect(await CP.resolveCoinpayUser({ mode: 'connect', currentUserId: 'victim', claims: claims('s3') }, m.store)).toMatchObject({ ok: false, code: 'already_connected' });
  });

  test('disconnect is refused when CoinPay is the only way in', async () => {
    const r = await CP.resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('s') }, m.store);
    expect((await CP.disconnectCoinpay({ id: r.userId, email: m.users.get(r.userId).email }, m.store)).ok).toBe(false);
    await CP.resolveCoinpayUser({ mode: 'connect', currentUserId: 'victim', claims: claims('v') }, m.store);
    expect(await CP.disconnectCoinpay({ id: 'victim', email: 'victim@example.com' }, m.store)).toEqual({ ok: true });
  });

  test('a CoinPay-only account cannot take an invite bonus (no verified email)', async () => {
    const user = { id: 'u', email: CP.placeholderEmail(), is_admin: false, created_at: new Date().toISOString() };
    const sql = async () => [];
    expect(await K.inviteProblem(user, { created: true }, sql)).toMatch(/verified email/);
  });
});

describe('state, nonce and PKCE', () => {
  const cfg = CP.coinpayConfig();
  test('the authorize URL carries PKCE S256, state, nonce and the exact redirect', () => {
    const { pending, url } = CP.begin(cfg, { mode: 'login', next: '/account' });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://coinpayportal.com/api/oauth/authorize');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('state')).toBe(pending.state);
    expect(u.searchParams.get('nonce')).toBe(pending.nonce);
    expect(u.searchParams.get('redirect_uri')).toBe('https://wx93.me/api/v1/coinpay/oauth/callback');
    expect(u.searchParams.get('scope')).toBe('openid profile email');
  });
  test('the pending cookie round-trips and junk is refused', () => {
    const { pending, cookie } = CP.begin(cfg, { mode: 'connect', next: '' });
    expect(CP.decodePending(cookie)).toEqual(pending);
    expect(CP.decodePending('junk')).toBeNull();
    expect(CP.decodePending(undefined)).toBeNull();
  });
  test('a bad or missing state is refused', () => {
    expect(CP.stateMatches('abc', 'abc')).toBe(true);
    expect(CP.stateMatches('abc', 'abd')).toBe(false);
    expect(CP.stateMatches('abc', undefined)).toBe(false);
  });

  const jwt = (c) => ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(c)).toString('base64url'), 'sig'].join('.');
  const good = { iss: 'https://coinpayportal.com', aud: 'cp_test', sub: 's1', nonce: 'n1', exp: Math.floor(Date.now() / 1000) + 600 };
  const fakeFetch = (idClaims, seen = {}) => async (url, init) => {
    if (String(url).endsWith('/api/oauth/token')) {
      seen.body = new URLSearchParams(String(init.body));
      return Response.json({ access_token: 'at', id_token: jwt(idClaims) });
    }
    return Response.json({ sub: 's1', email: 'victim@example.com', name: 'Ann', email_verified: false });
  };
  const pending = { state: 'st', nonce: 'n1', verifier: 'v', mode: 'login', next: '' };

  test('the code exchange sends the verifier and the client secret, and returns the claims', async () => {
    const seen = {};
    expect(await CP.claimsFor(cfg, { code: 'c', pending }, fakeFetch(good, seen))).toEqual({ sub: 's1', email: 'victim@example.com', name: 'Ann' });
    expect(seen.body.get('code_verifier')).toBe('v');
    expect(seen.body.get('client_secret')).toBe('cps_test');
  });
  test('a wrong nonce, audience, issuer or an expired token is refused', async () => {
    for (const bad of [{ nonce: 'attacker' }, { nonce: undefined }, { aud: 'cp_other' }, { iss: 'https://evil.example' }, { exp: 1000 }]) {
      await expect(CP.claimsFor(cfg, { code: 'c', pending }, fakeFetch({ ...good, ...bad }))).rejects.toThrow();
    }
  });
});

/* ------------------------------------------------------------- against a DB -- */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;
d('routes and pgStore (DATABASE_URL)', () => {
  let app, db, auth;
  beforeAll(async () => {
    const { migrate } = await import('../packages/db/src/migrate.js');
    await migrate({ log: () => {} });
    ({ db } = await import('../packages/db/src/index.js'));
    auth = await import('../apps/web/src/auth.js');
    ({ app } = await import('../apps/web/src/app.js'));
  });
  afterAll(async () => {
    await db()`delete from users where email like ${'%@' + CP.PLACEHOLDER_EMAIL_DOMAIN} or email = 'cp-victim@example.com'`;
  });
  const req = (path, headers = {}) => app.fetch(new Request(`https://wx93.me${path}`, { headers: { 'x-real-ip': '198.51.100.7', ...headers }, redirect: 'manual' }));

  test('start 302s to CoinPay with PKCE + state + nonce; connect without a session goes to sign-in', async () => {
    const res = await req('/api/v1/coinpay/oauth/start?mode=login');
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location'));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(res.headers.get('set-cookie')).toMatch(/wx93_coinpay=.*HttpOnly/i);
    const c = await req('/api/v1/coinpay/oauth/start?mode=connect');
    expect(c.headers.get('location')).toBe('/signin?next=/account');
  });

  test('a forged state is refused', async () => {
    const { cookie } = CP.begin(CP.coinpayConfig(), { mode: 'login', next: '' });
    const res = await req('/api/v1/coinpay/oauth/callback?code=x&state=forged', { cookie: `wx93_coinpay=${cookie}` });
    expect(res.headers.get('location')).toBe('/signin?error=coinpay-state');
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/wx93_session=[^;]/);
  });

  test('pgStore: an email collision makes a new placeholder account, never the victim', async () => {
    const victim = await auth.findOrCreateUser('cp-victim@example.com');
    const store = CP.pgStore(db());
    const r = await CP.resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims(`sub-${Date.now()}`, 'cp-victim@example.com') }, store);
    expect(r.action).toBe('created');
    expect(r.userId).not.toBe(victim.id);
    const [u] = await db()`select email, is_admin from users where id = ${r.userId}`;
    expect(CP.isPlaceholderEmail(u.email)).toBe(true);
    expect(u.is_admin).toBe(false);
    expect(await store.identityByUser(victim.id)).toBeNull();
  });

  test('a magic link is never sent to a placeholder address', async () => {
    // /auth/link answers the same either way; the guard is the isPlaceholderEmail check before sending.
    expect(CP.isPlaceholderEmail(`cp-abc@${CP.PLACEHOLDER_EMAIL_DOMAIN}`)).toBe(true);
    expect(CP.isPlaceholderEmail('ann@example.com')).toBe(false);
  });
});
