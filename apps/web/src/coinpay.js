import { randomBytes } from 'node:crypto';
import { SIGN_IN_SCOPES, authorizeUrl, finishSignIn, pkce, randomToken, sameState } from '@profullstack/coinpay-onboard/oauth';
import { db } from '@wx93/db';
import { config } from './config.js';

/**
 * Sign in with CoinPay (CoinPay is the house master account).
 *
 * Confidential OIDC client: authorization code + PKCE S256 + state + nonce + the
 * client secret, exact redirect `${siteUrl}/api/v1/coinpay/oauth/callback`, scopes
 * openid profile email. The protocol half is @profullstack/coinpay-onboard/oauth.
 *
 * STANDING rule: a CoinPay login binds to the CoinPay `sub` (coinpay_identities).
 * It never signs in to an existing account because the CoinPay email matches
 * (CoinPay never verifies emails), never uses that email as the account's email
 * (on wx93 the email IS the account, proven by the magic link), and never grants
 * anything from it. Linking happens only from /account while signed in. A first
 * CoinPay login with no link makes a NEW account whose email is a random
 * placeholder under PLACEHOLDER_EMAIL_DOMAIN; nobody can receive mail there, so no
 * magic link can ever reach it. The CoinPay email stays on the identity row as
 * unverified contact info.
 */

export const CALLBACK_PATH = '/api/v1/coinpay/oauth/callback';
export const COOKIE = 'wx93_coinpay';
export const COOKIE_PATH = '/api/v1/coinpay/oauth';
export const COOKIE_MAX_AGE = 600;
export const PLACEHOLDER_EMAIL_DOMAIN = 'coinpay-users.wx93.me';

export function coinpayConfig() {
  const clientId = String(process.env.COINPAY_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(process.env.COINPAY_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  const base = String(process.env.COINPAY_OAUTH_ISSUER ?? '').trim().replace(/\/+$/, '') || 'https://coinpayportal.com';
  return { clientId, clientSecret, base, redirectUri: `${config.siteUrl}${CALLBACK_PATH}` };
}

export const isPlaceholderEmail = (email) =>
  typeof email === 'string' && email.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
export const placeholderEmail = () => `cp-${randomBytes(12).toString('hex')}@${PLACEHOLDER_EMAIL_DOMAIN}`;

/* ------------------------------------------------------------ pending cookie -- */

/** A new request: what goes in the httpOnly cookie, and the URL to send the browser to. */
export function begin(cfg, { mode, next }) {
  const { verifier, challenge } = pkce();
  const pending = { state: randomToken(), nonce: randomToken(), verifier, mode: mode === 'connect' ? 'connect' : 'login', next };
  const url = authorizeUrl({
    base: cfg.base,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    scopes: SIGN_IN_SCOPES,
    state: pending.state,
    nonce: pending.nonce,
    challenge,
  });
  return { pending, cookie: encodePending(pending), url };
}

export const encodePending = (p) =>
  Buffer.from(JSON.stringify({ s: p.state, n: p.nonce, v: p.verifier, m: p.mode, r: p.next ?? '' })).toString('base64url');

export function decodePending(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!o || typeof o.s !== 'string' || typeof o.n !== 'string' || typeof o.v !== 'string') return null;
    if (o.m !== 'login' && o.m !== 'connect') return null;
    return { state: o.s, nonce: o.n, verifier: o.v, mode: o.m, next: typeof o.r === 'string' ? o.r : '' };
  } catch {
    return null;
  }
}

export const stateMatches = (expected, got) => sameState(expected, got);

/** Code -> tokens (PKCE verifier + secret) -> id_token checks (iss/aud/exp/nonce) -> userinfo, sub matched. */
export async function claimsFor(cfg, { code, pending }, fetchImpl) {
  const r = await finishSignIn({
    code,
    verifier: pending.verifier,
    nonce: pending.nonce,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
    base: cfg.base,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const email = typeof r.email === 'string' && r.email.includes('@') ? r.email.slice(0, 320) : null;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 200) : null;
  return { sub: r.sub, email, name };
}

/* -------------------------------------------------------------------- store -- */

/** The real store. Tests pass an in-memory one with the same shape. */
export function pgStore(sql = db()) {
  return {
    async identityBySub(sub) {
      const [r] = await sql`select user_id, coinpay_sub, coinpay_email, created_via from coinpay_identities where coinpay_sub = ${sub}`;
      return r ?? null;
    },
    async identityByUser(userId) {
      const [r] = await sql`select user_id, coinpay_sub, coinpay_email, created_via from coinpay_identities where user_id = ${userId}`;
      return r ?? null;
    },
    async link(row) {
      const r = await sql`
        insert into coinpay_identities (user_id, coinpay_sub, coinpay_email, coinpay_name, created_via, last_login_at)
        values (${row.user_id}, ${row.coinpay_sub}, ${row.coinpay_email}, ${row.coinpay_name}, ${row.created_via}, now())
        on conflict do nothing returning user_id`;
      return r.length ? 'ok' : 'conflict';
    },
    async unlink(userId) {
      await sql`delete from coinpay_identities where user_id = ${userId}`;
    },
    async touch(sub) {
      await sql`update coinpay_identities set last_login_at = now() where coinpay_sub = ${sub}`;
    },
    /** A new account on a random placeholder address. Never admin: adminEmails cannot match it. */
    async createUser() {
      const [u] = await sql`insert into users (email, is_admin) values (${placeholderEmail()}, false) returning id`;
      return u.id;
    },
    async deleteUser(userId) {
      await sql`delete from users where id = ${userId}`;
    },
  };
}

/* ------------------------------------------------------------------ resolve -- */

/**
 * Which wx93 account a verified CoinPay sub belongs to. Never looks at the email:
 * a CoinPay login carrying an existing user's email gets a NEW account (or the one
 * already bound to its sub), never that user's.
 * -> { ok: true, userId, action: 'login'|'created'|'linked' } | { ok: false, code, error }
 */
export async function resolveCoinpayUser({ mode, currentUserId, claims }, store) {
  const bound = await store.identityBySub(claims.sub);
  if (mode === 'connect') {
    if (!currentUserId) return { ok: false, code: 'not_signed_in', error: 'Sign in to wx93 first, then connect CoinPay from your account page.' };
    if (bound) {
      if (bound.user_id === currentUserId) return { ok: true, userId: currentUserId, action: 'linked' };
      return { ok: false, code: 'linked_elsewhere', error: 'That CoinPay account is already connected to another wx93 account.' };
    }
    if (await store.identityByUser(currentUserId))
      return { ok: false, code: 'already_connected', error: 'This wx93 account is already connected to a different CoinPay account. Disconnect it first.' };
    const r = await store.link({ user_id: currentUserId, coinpay_sub: claims.sub, coinpay_email: claims.email, coinpay_name: claims.name, created_via: 'connect' });
    if (r === 'conflict') return { ok: false, code: 'linked_elsewhere', error: 'That CoinPay account was just connected elsewhere.' };
    return { ok: true, userId: currentUserId, action: 'linked' };
  }
  if (bound) {
    await store.touch(claims.sub);
    return { ok: true, userId: bound.user_id, action: 'login' };
  }
  const userId = await store.createUser({ name: claims.name });
  const r = await store.link({ user_id: userId, coinpay_sub: claims.sub, coinpay_email: claims.email, coinpay_name: claims.name, created_via: 'signup' });
  if (r === 'conflict') {
    // Lost a race with a parallel first login for the same sub: keep theirs.
    await store.deleteUser(userId).catch(() => {});
    const again = await store.identityBySub(claims.sub);
    if (again) return { ok: true, userId: again.user_id, action: 'login' };
    throw new Error('coinpay identity conflict');
  }
  return { ok: true, userId, action: 'created' };
}

/**
 * Disconnect is refused when CoinPay is the only way into the account: a
 * placeholder address cannot get a magic link. (A passkey added later is not
 * counted on purpose: losing the device would lock the account.)
 */
export async function disconnectCoinpay(user, store) {
  if (!(await store.identityByUser(user.id))) return { ok: true };
  if (isPlaceholderEmail(user.email)) return { ok: false, error: 'CoinPay is the only way to sign in to this account, so it cannot be disconnected.' };
  await store.unlink(user.id);
  return { ok: true };
}
