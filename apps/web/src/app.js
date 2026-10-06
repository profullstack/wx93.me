import { createHash, randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, healthcheck } from '@wx93/db';
import * as pay from '@wx93/payments';
import { createFormGuard } from '@profullstack/form-guard';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { checkDestination, checkShape, DestinationError, feedStatus } from './abuse.js';
import { adFrameOrigins } from './ads.js';
import * as auth from './auth.js';
import { applyPurchase, billingState, currentPlan, quote } from './billing.js';
import { aliasProblem, CODE_PATH, RESERVED } from './codes.js';
import { config, PLANS } from './config.js';
import { clientIp, countryOf } from './geo.js';
import { installScript } from './install.js';
import {
  adFree,
  CodeTaken,
  deleteLink,
  insertLink,
  invalidate,
  linkStats,
  linksThisMonth,
  listLinks,
  ownedLink,
  publicLink,
  recordClick,
  resolve,
  setDisabled,
  shortUrl,
  updateLink,
} from './links.js';
import { sendAbuseNotice, sendLoginLink, sendReceipt } from './mail.js';
import { mountMcp } from './mcp-http.js';
import { mountOAuth, userFromAccessToken } from './oauth.js';
import * as P from './pages.js';
import { codeFrom, HttpError, parseExpiry, parseRedirectType, referrerHost } from './parse.js';
import { qrSvg } from './qr.js';
import { paidPass, trafficGuard } from './throttle.js';
import { classify, isPrefetch } from './ua.js';
import { EVENTS, deliver, forgetHooks, newSecret } from './webhooks.js';

export const app = new Hono();
const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', 'public');

/* ------------------------------------------------------------ middleware -- */

const csp = () =>
  [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    `frame-src ${adFrameOrigins().join(' ') || "'none'"}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://coinpayportal.com http://127.0.0.1:* http://localhost:*",
    "object-src 'none'",
  ].join('; ');

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  if ((c.res.headers.get('content-type') ?? '').includes('text/html')) {
    if (!c.res.headers.get('content-security-policy')) c.header('content-security-policy', csp());
    c.header('x-frame-options', 'DENY');
    if (!c.res.headers.get('referrer-policy')) c.header('referrer-policy', 'strict-origin-when-cross-origin');
  }
});

const guard = trafficGuard();
for (const p of ['/api/*', '/auth/*', '/oauth/*', '/shorten', '/report', '/mcp', '/billing/*', '/account/*', '/admin/*', '/x402'])
  app.use(p, guard);

// A cross-site form post cannot ride the Lax session cookie, but say no to a foreign Origin anyway.
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !c.req.path.startsWith('/webhooks/') && !c.req.path.startsWith('/oauth/token')) {
    const origin = c.req.header('origin');
    if (origin && origin !== 'null' && origin !== new URL(config.siteUrl).origin && getCookie(c, config.session.cookie) && !c.req.header('authorization'))
      return c.json({ error: 'cross-site request refused' }, 403);
  }
  return next();
});

/*
 * Second short domains (9xq.me): only short codes, their `+` previews and their
 * QR codes are served there. Everything else is the app, which lives on the
 * primary host, so it 301s to the same path on wx93.me.
 */
app.use('*', async (c, next) => {
  const raw = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '');
  // www.wx93.me is an alias: one canonical origin for pages, passkeys and cookies.
  if (raw === `www.${config.host}`) {
    const u = new URL(c.req.url);
    return c.redirect(`${config.siteUrl}${u.pathname}${u.search}`, 301);
  }
  const host = raw.replace(/^www\./, '');
  if (!config.altHosts.includes(host)) return next();
  const path = c.req.path;
  if (/^\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\+?$/.test(path) && !RESERVED.has(path.slice(1).replace(/\+$/, '').toLowerCase())) return next();
  if (/^\/qr\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.svg$/.test(path) || path === '/robots.txt' || path === '/healthz') return next();
  const u = new URL(c.req.url);
  return c.redirect(`${config.siteUrl}${path}${u.search}`, 301);
});

/* ---------------------------------------------------------------- helpers -- */

/** Who is asking: an API key, an OAuth token, a browser session, or nobody (a first-class answer). */
async function caller(c) {
  const authz = c.req.header('authorization');
  if (authz) {
    const u = (await auth.userFromApiKey(authz)) ?? (await userFromAccessToken(authz));
    if (u) return { user: u, via: u.api_key_id ? 'api-key' : 'oauth', apiKeyId: u.api_key_id ?? null };
  }
  const u = await auth.userFromSession(getCookie(c, config.session.cookie));
  return u ? { user: u, via: 'session', apiKeyId: null } : { user: null, via: null, apiKeyId: null };
}

const pepper = (s) => createHash('sha256').update(`${config.secret}:${s}`).digest('hex').slice(0, 32);
const fingerprint = (token) => `x402:${createHash('sha256').update(String(token)).digest('hex').slice(0, 24)}`;

async function body(c) {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) return c.req.json().catch(() => ({}));
  return c.req.parseBody().catch(() => ({}));
}

const apiError = (c, err) => {
  if (err instanceof HttpError || err instanceof DestinationError)
    return c.json({ error: err.message, ...(err.extra ?? {}) }, err.status);
  if (err instanceof CodeTaken) return c.json({ error: err.message }, 409);
  console.error(`[api] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: 'something went wrong on our side' }, 500);
};

const requireUser = async (c) => {
  const who = await caller(c);
  if (!who.user) throw new HttpError(401, 'sign in, or send Authorization: Bearer <key>');
  return who;
};

const NEEDS = { aliases: 'Pro', stats: 'Pro', apiKeys: 'Pro', bulk: 'Automation', webhooks: 'Automation', domains: 'Automation' };
const requireFeature = (plan, feature, label) => {
  if (!plan[feature]) throw new HttpError(402, `${label} need the ${NEEDS[feature]} plan`, { upgrade: `${config.siteUrl}/pricing` });
};

/** Guards for the three public forms. Tokens are bound per form; IP is X-Real-IP, never a header the client writes. */
const guards = {
  shorten: createFormGuard({ secret: config.secret, binding: 'shorten', minAgeMs: 800, rateLimit: false }),
  signin: createFormGuard({ secret: config.secret, binding: 'signin', minAgeMs: 1200, rateLimit: { max: 10, windowMs: 3600_000 } }),
  report: createFormGuard({ secret: config.secret, binding: 'report', minAgeMs: 1500, rateLimit: { max: 10, windowMs: 3600_000 } }),
};
const guardFields = async (name) => guards[name].hiddenHTML(await guards[name].issue());
const guardCheck = (name, c, fields) => guards[name].check({ fields, headers: c.req.raw.headers, ip: clientIp(c.req.raw) ?? undefined });

/* ------------------------------------------------------------ the creator -- */

/**
 * Create one link for whoever is asking. All the rules live here so the web
 * form, the API, bulk and MCP cannot drift apart.
 */
async function createOne({ who, plan, input, pass, ip }) {
  const anonymous = !who.user && !pass;
  const { url, host } = await checkDestination(input.url, { anonymous });

  let alias = input.alias ? String(input.alias).trim() : null;
  if (alias) {
    if (!who.user) throw new HttpError(401, 'custom aliases need an account (Pro and up)');
    requireFeature(plan, 'aliases', 'Custom aliases');
    const problem = aliasProblem(alias);
    if (problem) throw new HttpError(400, problem);
  } else alias = null;

  const redirectType = parseRedirectType(input.redirect_type);
  if (redirectType && redirectType !== 302 && !plan.aliases) requireFeature(plan, 'aliases', 'Redirect types');

  let domainId = null;
  let hostname = null;
  let shortHost = null;
  const wanted = input.domain ? String(input.domain).trim().toLowerCase().replace(/^www\./, '') : '';
  if (wanted && config.altHosts.includes(wanted)) shortHost = wanted;
  else if (wanted && wanted !== config.host) {
    if (!who.user) throw new HttpError(401, 'custom domains need an account');
    if (!plan.domains) requireFeature(plan, 'domains', 'Custom domains');
    const [d] = await db()`select id, hostname from domains where user_id = ${who.user.id} and lower(hostname) = ${String(input.domain).toLowerCase()} and verified_at is not null`;
    if (!d) throw new HttpError(400, `${input.domain} is not a verified domain on your account`);
    domainId = d.id;
    hostname = d.hostname;
  }

  const link = await insertLink({
    url,
    host,
    alias,
    domainId,
    userId: who.user?.id ?? null,
    apiKeyId: who.apiKeyId ?? null,
    payer: pass ? fingerprint(pass) : null,
    adFreeUntil: pass ? new Date(Date.now() + config.x402.adFreeDays * 86400_000) : null,
    redirectType: redirectType ?? 302,
    title: input.title ? String(input.title).slice(0, 200) : null,
    shortHost,
    expiresAt: parseExpiry(input),
    ip: ip ? pepper(ip) : null,
  });
  return publicLink({ ...link, hostname, paid: !plan.interstitial });
}

/** Quotas, checked before any work. Returns the plan. */
async function admit({ who, pass, count = 1 }) {
  const plan = await currentPlan(who.user);
  if (who.user) {
    const used = await linksThisMonth(who.user.id);
    if (used + count > plan.linksPerMonth)
      throw new HttpError(429, `${plan.name} makes ${plan.linksPerMonth.toLocaleString('en-US')} links a month and this account has made ${used}`, { upgrade: `${config.siteUrl}/pricing` });
  } else if (pass) {
    const [{ n }] = await db()`
      select count(*)::int as n from links where payer = ${fingerprint(pass)}
      and created_at > now() - ${`${config.x402.passMinutes} minutes`}::interval`;
    if (n + count > config.x402.passLinks) throw new HttpError(402, `this pass has made its ${config.x402.passLinks} links; buy another at ${config.siteUrl}/x402`);
  }
  return plan;
}

/* ------------------------------------------------------------------ pages -- */

const pub = (file) => readFileSync(join(PUBLIC, file));
const ASSETS = {
  '/assets/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/assets/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
};
for (const [path, [file, type]] of Object.entries(ASSETS))
  app.get(path, (c) => c.body(pub(file), 200, { 'content-type': type, 'cache-control': path === '/sw.js' ? 'no-cache' : 'public, max-age=3600' }));
app.get('/icons/:name{[a-z0-9-]+\\.png}', (c) => {
  try {
    return c.body(pub(`icons/${c.req.param('name')}`), 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
  } catch {
    return c.notFound();
  }
});
const WEBAUTHN_JS = [join(here, '..', 'node_modules'), join(here, '..', '..', '..', 'node_modules')]
  .map((d) => join(d, '@simplewebauthn/browser/dist/bundle/index.umd.min.js'))
  .map((p) => {
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  })
  .find(Boolean);
app.get('/assets/webauthn.js', (c) =>
  WEBAUTHN_JS ? c.body(WEBAUTHN_JS, 200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' }) : c.text('missing', 404),
);
// The bundled CLI the installer downloads (built into the image; see Dockerfile).
app.get('/dl/wx93.mjs', (c) => {
  try {
    return c.body(pub('dl/wx93.mjs'), 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' });
  } catch {
    return c.text('the CLI bundle is not built on this server; npm i -g @profullstack/wx93', 404);
  }
});

app.get('/healthz', async (c) => {
  // Touches the database through the same pool the requests use.
  try {
    if (await Promise.race([healthcheck(), new Promise((r) => setTimeout(() => r(false), 3000))])) return c.text('ok');
  } catch {}
  return c.text('database unreachable', 503);
});
app.get('/api/v1/health', async (c) => {
  let dbOk = false;
  try {
    dbOk = await healthcheck();
  } catch {}
  return c.json({ ok: dbOk, db: dbOk ? 'ok' : 'down', feeds: feedStatus(), x402: config.x402.enabled, payments: config.coinpay.enabled }, dbOk ? 200 : 503);
});

app.get('/', async (c) => {
  const { user } = await caller(c);
  return c.html(P.Landing({ user, plan: await currentPlan(user), guardFields: await guardFields('shorten') }));
});
// The PWA share target: "Share to wx93" from any app lands here with the link filled in.
app.get('/share', async (c) => {
  const { user } = await caller(c);
  const pick = [c.req.query('url'), c.req.query('text'), c.req.query('title')].map((v) => String(v ?? '').match(/https?:\/\/\S+/)?.[0]).find(Boolean) ?? '';
  return c.html(P.Landing({ user, plan: await currentPlan(user), guardFields: await guardFields('shorten'), value: pick }), 200, { 'x-robots-tag': 'noindex' });
});
app.get('/pricing', async (c) => {
  const { user } = await caller(c);
  return c.html(
    P.Pricing({ user, plan: await currentPlan(user), chains: config.coinpay.chains, defaultChain: config.coinpay.defaultChain, paymentsOn: config.coinpay.enabled }),
  );
});
app.get('/docs', async (c) => c.html(P.Docs({ user: (await caller(c)).user })));
app.get('/desktop', async (c) => c.html(P.Desktop({ user: (await caller(c)).user })));
app.get('/offline', (c) => c.html(P.Offline()));
for (const [path, signup] of [
  ['/signin', false],
  ['/signup', true],
])
  app.get(path, async (c) =>
    c.html(
      P.SignIn({
        signup,
        next: c.req.query('next') ?? '',
        error: c.req.query('error') === 'expired' ? 'That link has expired or was already used. Ask for a new one.' : null,
        guardFields: await guardFields('signin'),
        user: (await caller(c)).user,
      }),
    ),
  );

/** The shorten form, with JavaScript off. */
app.post('/shorten', async (c) => {
  const fields = await c.req.parseBody();
  const who = await caller(c);
  if (!who.user) {
    const verdict = await guardCheck('shorten', c, fields);
    if (verdict.action === 'drop') return c.redirect('/', 303);
    if (verdict.action === 'retry')
      return c.html(P.Gone({ title: 'Try that again', message: 'That was very quick. Paste the link and press Shorten once more.', status: 400 }), 400);
  }
  try {
    const plan = await admit({ who });
    const link = await createOne({
      who,
      plan,
      input: { url: fields.url, alias: fields.alias || null, expires_in: fields.expires_in || null, domain: fields.domain || null },
      ip: clientIp(c.req.raw),
    });
    return c.html(
      P.ShortenResult({
        link,
        user: who.user,
        plan,
        guardFields: who.user ? '' : await guardFields('shorten'),
        notice: link.ad_free ? '' : 'People who open it see a short ad page first; previews and bots go straight through. <a href="/pricing">Pro</a> links skip it.',
      }),
    );
  } catch (err) {
    const status = err.status ?? 500;
    if (status === 500) console.error('[shorten]', err);
    return c.html(P.Gone({ title: 'Could not shorten that', message: status === 500 ? 'Something went wrong on our side.' : err.message, status, user: who.user }), status);
  }
});

/* -------------------------------------------------------------------- auth -- */

app.post('/auth/link', async (c) => {
  const fields = await c.req.parseBody();
  const email = String(fields.email ?? '').trim();
  const verdict = await guardCheck('signin', c, fields);
  // Answer the same whatever happens next: a different answer for a known address enumerates accounts.
  if (verdict.action !== 'drop' && verdict.action !== 'limited' && auth.EMAIL.test(email)) {
    try {
      await sendLoginLink({ email, url: await auth.createLoginLink(email, { next: String(fields.next ?? '') }) });
    } catch (err) {
      console.error(`[auth] could not send link: ${err?.message ?? err}`);
    }
  }
  return c.html(P.Sent({ email }));
});

app.get('/auth/magic', async (c) => {
  const token = c.req.query('t');
  const s = token ? await auth.consumeLoginLink(token, { userAgent: c.req.header('user-agent') }) : null;
  if (!s) return c.redirect('/signin?error=expired', 302);
  c.header('set-cookie', auth.sessionCookie(s.sessionId));
  const next = c.req.query('next');
  return c.redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : '/account', 302);
});

app.post('/auth/signout', async (c) => {
  await auth.endSession(getCookie(c, config.session.cookie));
  c.header('set-cookie', auth.sessionCookie('', { clear: true }));
  return c.redirect('/', 303);
});

app.post('/auth/passkey/register/options', async (c) => {
  const who = await caller(c);
  if (who.via !== 'session') return c.json({ error: 'sign in with the emailed link first' }, 401);
  return c.json(await auth.passkeyRegistrationOptions(who.user));
});
app.post('/auth/passkey/register/verify', async (c) => {
  const who = await caller(c);
  if (who.via !== 'session') return c.json({ error: 'sign in first' }, 401);
  const { response, challengeId } = await c.req.json().catch(() => ({}));
  const ok = await auth.verifyPasskeyRegistration({ user: who.user, response, challengeId }).catch(() => false);
  return ok ? c.json({ ok: true }) : c.json({ error: 'that passkey could not be saved' }, 400);
});
app.post('/auth/passkey/login/options', async (c) => c.json(await auth.passkeyAuthenticationOptions()));
app.post('/auth/passkey/login/verify', async (c) => {
  const { response, challengeId } = await c.req.json().catch(() => ({}));
  const s = await auth.verifyPasskeyAuthentication({ response, challengeId, userAgent: c.req.header('user-agent') }).catch(() => null);
  if (!s) return c.json({ error: 'that passkey did not work; use the email link instead' }, 401);
  c.header('set-cookie', auth.sessionCookie(s.sessionId));
  return c.json({ ok: true, next: '/account' });
});

mountOAuth(app);

/* ---------------------------------------------------------------- account -- */

async function accountPage(c, user, extra = {}) {
  const plan = await currentPlan(user);
  const sql = db();
  const [links, usage, keys, [pk], hooks, domains, billing] = await Promise.all([
    listLinks(user.id, { limit: 100 }),
    linksThisMonth(user.id),
    sql`select id, name, prefix, created_at, last_used_at from api_keys where user_id = ${user.id} and revoked_at is null order by created_at desc`,
    sql`select count(*)::int as n from passkeys where user_id = ${user.id}`,
    sql`select id, url, events, last_status, disabled_at from webhooks where user_id = ${user.id} order by created_at`,
    sql`select id, hostname, verify_token, verified_at from domains where user_id = ${user.id} order by created_at`,
    billingState(user),
  ]);
  return c.html(
    P.Account({ user, plan, links: links.map(publicLink), usage: { links: usage }, keys, passkeys: pk.n, hooks, domains, billing, ...extra }),
  );
}

const sessionUser = async (c) => {
  const who = await caller(c);
  return who.via === 'session' ? who.user : null;
};

app.get('/account', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin?next=/account', 302);
  const flash = c.req.query('paid') ? 'Thanks. Your plan switches on as soon as the payment confirms on chain, usually within a minute or two.' : null;
  return accountPage(c, user, { flash });
});

app.post('/account/keys', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin', 303);
  const plan = await currentPlan(user);
  if (!plan.apiKeys) return accountPage(c, user, { flash: 'API keys come with Pro.' });
  const f = await c.req.parseBody();
  const key = await auth.createApiKey({ userId: user.id, name: String(f.name || 'default').slice(0, 60) });
  return accountPage(c, user, { created: key.key });
});
app.post('/account/keys/:id/revoke', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin', 303);
  await db()`update api_keys set revoked_at = now() where id = ${c.req.param('id')} and user_id = ${user.id}`.catch(() => {});
  return c.redirect('/account#keys', 303);
});
app.post('/account/webhooks', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin', 303);
  try {
    const hook = await addWebhook(user, await c.req.parseBody());
    return accountPage(c, user, { flash: `Webhook added. Its signing secret (shown once): <code>${P.e(hook.secret)}</code>` });
  } catch (err) {
    return accountPage(c, user, { flash: P.e(err.message) });
  }
});
app.post('/account/webhooks/:id/delete', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin', 303);
  await db()`delete from webhooks where id = ${c.req.param('id')} and user_id = ${user.id}`.catch(() => {});
  forgetHooks(user.id);
  return c.redirect('/account#webhooks', 303);
});
app.post('/account/domains', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin', 303);
  try {
    await addDomain(user, (await c.req.parseBody()).hostname);
    return c.redirect('/account#domains', 303);
  } catch (err) {
    return accountPage(c, user, { flash: P.e(err.message) });
  }
});
app.post('/account/domains/:id/verify', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin', 303);
  const r = await verifyDomain(user, c.req.param('id')).catch((err) => ({ verified: false, error: err.message }));
  return accountPage(c, user, { flash: r.verified ? 'Domain verified.' : P.e(r.error ?? 'The TXT record was not found yet. DNS can take a few minutes.') });
});
app.get('/account/links/:id', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin', 302);
  const link = await ownedLink(user.id, c.req.param('id'));
  if (!link) return c.html(P.Gone({ title: 'No such link', message: 'It is not one of yours, or it was deleted.', user }), 404);
  const plan = await currentPlan(user);
  return c.html(P.LinkStatsPage({ user, link: publicLink(link), stats: await linkStats(link.id, { days: 30, full: plan.stats }), full: plan.stats }));
});
app.post('/account/links/:id/delete', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin', 303);
  const link = await ownedLink(user.id, c.req.param('id'));
  if (link) await deleteLink(link);
  return c.redirect('/account', 303);
});

/* --------------------------------------------------------- shared actions -- */

async function addWebhook(user, input) {
  const plan = await currentPlan(user);
  requireFeature(plan, 'webhooks', 'Webhooks');
  const { url } = checkShape(input.url);
  if (!url.startsWith('https://')) throw new HttpError(400, 'webhooks must be https');
  const events = Array.isArray(input.events) ? input.events.filter((x) => EVENTS.includes(x)) : EVENTS;
  const [{ n }] = await db()`select count(*)::int as n from webhooks where user_id = ${user.id}`;
  if (n >= 10) throw new HttpError(400, 'ten webhooks per account');
  const secret = newSecret();
  const [row] = await db()`
    insert into webhooks (user_id, url, secret, events) values (${user.id}, ${url}, ${secret}, ${events.length ? events : EVENTS})
    returning id, url, events, created_at`;
  forgetHooks(user.id);
  return { ...row, secret };
}

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function addDomain(user, hostname) {
  const plan = await currentPlan(user);
  requireFeature(plan, 'domains', 'Custom domains');
  const h = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(h)) throw new HttpError(400, 'that is not a hostname');
  if (h === config.host || h.endsWith(`.${config.host}`)) throw new HttpError(400, 'that one is ours');
  const [{ n }] = await db()`select count(*)::int as n from domains where user_id = ${user.id}`;
  if (n >= plan.domains) throw new HttpError(400, `${plan.name} includes ${plan.domains} custom domains`);
  try {
    const [row] = await db()`
      insert into domains (user_id, hostname, verify_token) values (${user.id}, ${h}, ${`wx93-verify=${randomBytes(12).toString('hex')}`})
      returning id, hostname, verify_token, verified_at, created_at`;
    return row;
  } catch {
    throw new HttpError(409, 'that domain is already registered here');
  }
}

async function verifyDomain(user, id) {
  const [d] = await db()`select * from domains where id = ${id} and user_id = ${user.id}`;
  if (!d) throw new HttpError(404, 'no such domain');
  if (d.verified_at) return { verified: true, domain: d };
  let records = [];
  try {
    records = (await resolveTxt(`_wx93.${d.hostname}`)).map((r) => r.join(''));
  } catch {}
  if (!records.includes(d.verify_token)) return { verified: false, error: `TXT _wx93.${d.hostname} should be ${d.verify_token}`, found: records };
  const [row] = await db()`update domains set verified_at = now() where id = ${d.id} returning *`;
  return { verified: true, domain: row };
}

/* ---------------------------------------------------------------- REST API -- */

app.get('/api/v1/me', async (c) => {
  try {
    const { user, via } = await requireUser(c);
    const plan = await currentPlan(user);
    return c.json({
      user: { id: user.id, email: user.email, admin: user.is_admin, via },
      plan: { key: plan.key, name: plan.name, paid_through: plan.paid_through, staff: plan.staff },
      limits: { links_per_month: plan.linksPerMonth, aliases: plan.aliases, stats: plan.stats, api_keys: plan.apiKeys, bulk: plan.bulk, webhooks: plan.webhooks, domains: plan.domains, interstitial: plan.interstitial },
      usage: { links_this_month: await linksThisMonth(user.id) },
    });
  } catch (err) {
    return apiError(c, err);
  }
});

app.post('/api/v1/links', async (c) => {
  try {
    const who = await caller(c);
    const pass = who.user ? null : await paidPass(c.req.raw);
    const plan = await admit({ who, pass });
    const link = await createOne({ who, plan, input: await body(c), pass, ip: clientIp(c.req.raw) });
    return c.json(link, 201);
  } catch (err) {
    return apiError(c, err);
  }
});

app.post('/api/v1/links/bulk', async (c) => {
  try {
    const who = await requireUser(c);
    const plan = await currentPlan(who.user);
    requireFeature(plan, 'bulk', 'Bulk create');
    const b = await body(c);
    const items = Array.isArray(b.links) ? b.links : null;
    if (!items?.length) throw new HttpError(400, 'send {"links": [{"url": "..."}, ...]}');
    if (items.length > 1000) throw new HttpError(400, 'up to 1,000 links per request');
    await admit({ who, count: items.length });
    const ip = clientIp(c.req.raw);
    const results = [];
    for (const item of items) {
      try {
        results.push({ ok: true, link: await createOne({ who, plan, input: typeof item === 'string' ? { url: item } : (item ?? {}), ip }) });
      } catch (err) {
        if (!(err instanceof HttpError || err instanceof DestinationError || err instanceof CodeTaken)) throw err;
        results.push({ ok: false, error: err.message, input: item });
      }
    }
    return c.json({ created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }, 207);
  } catch (err) {
    return apiError(c, err);
  }
});

app.get('/api/v1/links', async (c) => {
  try {
    const { user } = await requireUser(c);
    const rows = await listLinks(user.id, { limit: c.req.query('limit'), before: c.req.query('before'), q: c.req.query('q') });
    return c.json({ links: rows.map(publicLink), next_before: rows.length ? rows[rows.length - 1].created_at : null });
  } catch (err) {
    return apiError(c, err);
  }
});

const mine = async (c) => {
  const { user } = await requireUser(c);
  const link = await ownedLink(user.id, c.req.param('ref'));
  if (!link) throw new HttpError(404, 'no such link on your account');
  return { user, link };
};

app.get('/api/v1/links/:ref', async (c) => {
  try {
    return c.json(publicLink((await mine(c)).link));
  } catch (err) {
    return apiError(c, err);
  }
});

app.patch('/api/v1/links/:ref', async (c) => {
  try {
    const { user, link } = await mine(c);
    const plan = await currentPlan(user);
    const b = await body(c);
    const patch = {};
    if (b.url !== undefined) Object.assign(patch, await checkDestination(b.url));
    if (b.title !== undefined) patch.title = b.title ? String(b.title).slice(0, 200) : null;
    if (b.expires_at !== undefined || b.expires_in !== undefined) patch.expiresAt = b.expires_at === null ? null : parseExpiry(b);
    if (b.redirect_type !== undefined) {
      patch.redirectType = parseRedirectType(b.redirect_type) ?? 302;
      if (patch.redirectType !== 302) requireFeature(plan, 'aliases', 'Redirect types');
    }
    return c.json(publicLink(await updateLink(link, patch)));
  } catch (err) {
    return apiError(c, err);
  }
});

app.delete('/api/v1/links/:ref', async (c) => {
  try {
    const { link } = await mine(c);
    await deleteLink(link);
    return c.json({ deleted: true, id: link.id, code: link.code });
  } catch (err) {
    return apiError(c, err);
  }
});

app.get('/api/v1/links/:ref/stats', async (c) => {
  try {
    const { user, link } = await mine(c);
    const plan = await currentPlan(user);
    const stats = await linkStats(link.id, { days: c.req.query('days') ?? 30, full: plan.stats });
    return c.json({ link: publicLink(link), ...stats, ...(plan.stats ? {} : { upgrade: `${config.siteUrl}/pricing`, note: 'Free shows totals; daily, referrers, countries and devices come with Pro.' }) });
  } catch (err) {
    return apiError(c, err);
  }
});

app.get('/api/v1/links/:ref/qr.svg', async (c) => {
  try {
    const { link } = await mine(c);
    return c.body(qrSvg(publicLink(link).short_url, { size: Number(c.req.query('size')) || 320 }), 200, { 'content-type': 'image/svg+xml' });
  } catch (err) {
    return apiError(c, err);
  }
});

/** Where a wx93 link goes, without following it. Public: a safety check anyone can run. */
app.get('/api/v1/expand', async (c) => {
  const raw = c.req.query('url') ?? '';
  let host = config.host;
  try {
    host = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {}
  const code = codeFrom(raw, host.replace(/^www\./, ''));
  const link = code ? await resolve(host, code) : null;
  if (!link) return c.json({ error: 'not a wx93 link we know' }, 404);
  const expired = link.expires_at && new Date(link.expires_at) < new Date();
  return c.json({ code: link.code, url: link.disabled_at ? null : link.url, disabled: Boolean(link.disabled_at), expired: Boolean(expired), created_at: link.created_at });
});

app.get('/api/v1/keys', async (c) => {
  try {
    const { user } = await requireUser(c);
    const keys = await db()`select id, name, prefix, created_at, last_used_at from api_keys where user_id = ${user.id} and revoked_at is null order by created_at desc`;
    return c.json({ keys });
  } catch (err) {
    return apiError(c, err);
  }
});
app.post('/api/v1/keys', async (c) => {
  try {
    const { user } = await requireUser(c);
    requireFeature(await currentPlan(user), 'apiKeys', 'API keys');
    const b = await body(c);
    const key = await auth.createApiKey({ userId: user.id, name: String(b.name || 'default').slice(0, 60) });
    return c.json({ ...key, shown_once: true }, 201);
  } catch (err) {
    return apiError(c, err);
  }
});
app.delete('/api/v1/keys/:id', async (c) => {
  try {
    const { user } = await requireUser(c);
    const rows = await db()`update api_keys set revoked_at = now() where id = ${c.req.param('id')} and user_id = ${user.id} and revoked_at is null returning id`.catch(() => []);
    return c.json({ revoked: rows.length > 0 });
  } catch (err) {
    return apiError(c, err);
  }
});

app.get('/api/v1/webhooks', async (c) => {
  try {
    const { user } = await requireUser(c);
    return c.json({ webhooks: await db()`select id, url, events, created_at, last_status, last_error, last_delivery_at, disabled_at from webhooks where user_id = ${user.id} order by created_at` });
  } catch (err) {
    return apiError(c, err);
  }
});
app.post('/api/v1/webhooks', async (c) => {
  try {
    const { user } = await requireUser(c);
    return c.json({ ...(await addWebhook(user, await body(c))), shown_once: ['secret'] }, 201);
  } catch (err) {
    return apiError(c, err);
  }
});
app.delete('/api/v1/webhooks/:id', async (c) => {
  try {
    const { user } = await requireUser(c);
    const rows = await db()`delete from webhooks where id = ${c.req.param('id')} and user_id = ${user.id} returning id`.catch(() => []);
    forgetHooks(user.id);
    return c.json({ deleted: rows.length > 0 });
  } catch (err) {
    return apiError(c, err);
  }
});
app.post('/api/v1/webhooks/:id/test', async (c) => {
  try {
    const { user } = await requireUser(c);
    const [hook] = await db()`select id, url, secret, events from webhooks where id = ${c.req.param('id')} and user_id = ${user.id}`.catch(() => []);
    if (!hook) throw new HttpError(404, 'no such webhook');
    const r = await deliver({ hook, body: JSON.stringify({ id: `evt_test_${randomBytes(6).toString('hex')}`, type: 'ping', created_at: new Date().toISOString(), data: {} }), attempt: 2 });
    return c.json(r);
  } catch (err) {
    return apiError(c, err);
  }
});

app.get('/api/v1/domains', async (c) => {
  try {
    const { user } = await requireUser(c);
    return c.json({ domains: await db()`select id, hostname, verify_token, verified_at, created_at from domains where user_id = ${user.id} order by created_at` });
  } catch (err) {
    return apiError(c, err);
  }
});
app.post('/api/v1/domains', async (c) => {
  try {
    const { user } = await requireUser(c);
    const d = await addDomain(user, (await body(c)).hostname);
    return c.json({ ...d, instructions: `Add TXT _wx93.${d.hostname} = ${d.verify_token}, point ${d.hostname} at ${config.host} (CNAME), then POST /api/v1/domains/${d.id}/verify` }, 201);
  } catch (err) {
    return apiError(c, err);
  }
});
app.post('/api/v1/domains/:id/verify', async (c) => {
  try {
    const { user } = await requireUser(c);
    return c.json(await verifyDomain(user, c.req.param('id')));
  } catch (err) {
    return apiError(c, err);
  }
});
app.delete('/api/v1/domains/:id', async (c) => {
  try {
    const { user } = await requireUser(c);
    const rows = await db()`delete from domains where id = ${c.req.param('id')} and user_id = ${user.id} returning id`.catch(() => []);
    return c.json({ deleted: rows.length > 0 });
  } catch (err) {
    return apiError(c, err);
  }
});

/* ------------------------------------------------------------------ money -- */

async function startCheckout(user, { plan, term, chain }) {
  if (!pay.paymentsEnabled()) throw new HttpError(503, 'payments are being switched on; try again shortly');
  if (!PLANS[plan] || plan === 'free') throw new HttpError(400, 'plan is pro or automation');
  if (!['month', 'year'].includes(term)) throw new HttpError(400, 'term is month or year');
  const ch = String(chain || config.coinpay.defaultChain).toUpperCase();
  if (!config.coinpay.chains.includes(ch)) throw new HttpError(400, `chain is one of ${config.coinpay.chains.join(', ')}`);
  const q = await quote(user, plan, term);
  if (q.kind === 'staff') throw new HttpError(400, 'staff accounts are never billed');
  if (q.amount_cents < 50) throw new HttpError(400, 'nothing to pay: your current plan already covers that');
  const { checkoutUrl, paymentRef } = await pay.createCheckout({
    user,
    amountCents: q.amount_cents,
    description: `wx93 ${PLANS[plan].name}, one ${term}${q.kind === 'upgrade' ? ' (upgrade, unused Pro credited)' : ''}`,
    metadata: { product: 'plan', plan, term, kind: q.kind },
    blockchain: ch,
    successUrl: `${config.siteUrl}/account?paid=1`,
    cancelUrl: `${config.siteUrl}/pricing`,
  });
  return { checkout_url: checkoutUrl, payment_ref: paymentRef, quote: q };
}

app.post('/billing/checkout', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect('/signin?next=/pricing', 303);
  const f = await c.req.parseBody();
  try {
    const r = await startCheckout(user, { plan: String(f.plan), term: String(f.term || 'month'), chain: f.chain ? String(f.chain) : null });
    return c.redirect(r.checkout_url, 303);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[checkout]', err);
    return c.html(P.Gone({ title: 'Checkout did not start', message: err instanceof HttpError ? err.message : 'CoinPay did not answer. Try again in a minute.', status: 502, user }), 502);
  }
});
app.post('/api/v1/billing/checkout', async (c) => {
  try {
    const { user } = await requireUser(c);
    const b = await body(c);
    return c.json(await startCheckout(user, { plan: String(b.plan), term: String(b.term || 'month'), chain: b.chain }));
  } catch (err) {
    if (!(err instanceof HttpError)) return c.json({ error: 'could not start checkout', detail: String(err?.message ?? err).slice(0, 200) }, 502);
    return apiError(c, err);
  }
});
app.get('/api/v1/billing', async (c) => {
  try {
    const { user } = await requireUser(c);
    return c.json(await billingState(user));
  } catch (err) {
    return apiError(c, err);
  }
});

/** CoinPay calls this when money moves. The signature covers the RAW body. */
app.post('/webhooks/coinpay', async (c) => {
  const raw = await c.req.text();
  const ok = pay.verifyWebhook({ rawBody: raw, signatureHeader: c.req.header('x-coinpay-signature') ?? c.req.header('coinpay-signature') });
  if (!ok) return c.json({ error: 'bad signature' }, 401);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  let receipt = null;
  try {
    const result = await pay.settleWebhook(payload, {
      async grant(tx, { meta, payment }) {
        if (meta.product !== 'plan') return null;
        const period = await applyPurchase(tx, { userId: meta.user_id, plan: meta.plan, term: meta.term, kind: meta.kind, paymentId: payment.id });
        if (period) receipt = { userId: meta.user_id, plan: PLANS[meta.plan]?.name ?? meta.plan, term: meta.term, endsAt: period.ends_at, amountCents: payment.amount_cents };
        return period ?? { alreadyGranted: true };
      },
    });
    if (receipt) {
      const [u] = await db()`select email from users where id = ${receipt.userId}`;
      if (u) sendReceipt({ email: u.email, ...receipt }).catch((err) => console.error(`[mail] receipt: ${err?.message ?? err}`));
    }
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error('[webhook] coinpay', err);
    // 2xx for a payload we will never be able to use, or CoinPay retries it forever.
    return c.json({ ok: false, error: String(err?.message ?? err).slice(0, 200) }, /missing/.test(String(err?.message)) ? 200 : 500);
  }
});

/* ------------------------------------------------------------------ abuse -- */

async function fileReport(c, { url, reason, details, email }) {
  const r = ['phishing', 'malware', 'spam', 'illegal', 'other'].includes(String(reason)) ? String(reason) : 'other';
  const code = codeFrom(url, config.host);
  const link = code ? await resolve(config.host, code) : null;
  const reporter = pepper(clientIp(c.req.raw) ?? `anon-${randomBytes(8).toString('hex')}`);
  await db()`
    insert into reports (link_id, reported, reason, details, email, reporter)
    values (${link?.id ?? null}, ${String(url).slice(0, 500)}, ${r}, ${details ? String(details).slice(0, 2000) : null},
            ${email && auth.EMAIL.test(String(email)) ? String(email) : null}, ${reporter})
    on conflict do nothing`;
  if (link && !link.disabled_at) {
    const [{ n }] = await db()`select count(distinct reporter)::int as n from reports where link_id = ${link.id} and resolved_at is null`;
    if (n >= config.links.reportThreshold) {
      await setDisabled(link.id, `reported ${n} times (${r}), pending review`);
      for (const to of config.adminEmails) sendAbuseNotice({ to, link, count: n }).catch(() => {});
    }
  }
  return { received: true, matched: Boolean(link) };
}

app.get('/report', async (c) => c.html(P.ReportPage({ guardFields: await guardFields('report'), code: c.req.query('code') ?? '', user: (await caller(c)).user })));
app.post('/report', async (c) => {
  const f = await c.req.parseBody();
  const verdict = await guardCheck('report', c, f);
  if (verdict.action === 'retry') return c.html(P.ReportPage({ guardFields: await guardFields('report'), error: 'That was very quick; please send it again.' }), 400);
  if (verdict.action === 'limited') return c.html(P.ReportPage({ guardFields: await guardFields('report'), error: 'Too many reports from here; try later.' }), 429);
  if (verdict.action !== 'drop') await fileReport(c, f);
  return c.html(P.ReportPage({ done: true }));
});
app.post('/api/v1/reports', async (c) => {
  try {
    const b = await body(c);
    if (!b.url) throw new HttpError(400, 'send {"url": "<the wx93 link>", "reason": "phishing"}');
    return c.json(await fileReport(c, b), 202);
  } catch (err) {
    return apiError(c, err);
  }
});

const adminUser = async (c) => {
  const who = await caller(c);
  return who.user?.is_admin ? who.user : null;
};
app.get('/admin', async (c) => {
  const user = await adminUser(c);
  if (!user) return c.redirect('/signin', 302);
  const reports = await db()`
    select r.link_id, max(r.reported) as reported, l.code, l.url, l.disabled_at, mode() within group (order by r.reason) as reason,
           count(distinct r.reporter)::int as reporters, max(r.created_at) as last
    from reports r left join links l on l.id = r.link_id
    where r.resolved_at is null group by r.link_id, l.code, l.url, l.disabled_at order by last desc limit 200`;
  return c.html(P.Admin({ user, reports, feed: feedStatus() }));
});
app.post('/admin/links/:id/:action{disable|enable}', async (c) => {
  if (!(await adminUser(c))) return c.redirect('/signin', 303);
  const disable = c.req.param('action') === 'disable';
  await setDisabled(c.req.param('id'), disable ? 'removed for abuse' : null);
  await db()`update reports set resolved_at = now(), resolution = ${disable ? 'disabled' : 'restored'} where link_id = ${c.req.param('id')} and resolved_at is null`;
  return c.redirect('/admin', 303);
});
app.post('/admin/blocklist', async (c) => {
  if (!(await adminUser(c))) return c.redirect('/signin', 303);
  const f = await c.req.parseBody();
  const domain = String(f.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (domain) {
    await db()`insert into blocklist (domain, reason) values (${domain}, ${String(f.reason || 'abuse').slice(0, 200)}) on conflict (domain) do update set reason = excluded.reason`;
    const hit = await db()`update links set disabled_at = now(), disabled_reason = 'destination blocklisted' where (host = ${domain} or host like ${`%.${domain}`}) and disabled_at is null returning code`;
    for (const { code } of hit) invalidate(code);
  }
  return c.redirect('/admin', 303);
});

/* -------------------------------------------------------------- agents etc -- */

mountMcp(app, { caller });

app.get('/install', (c) => c.body(installScript(), 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'public, max-age=300' }));
app.get('/install.sh', (c) => c.body(installScript(), 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'public, max-age=300' }));
app.get('/upgrade.sh', (c) => c.body(installScript(), 200, { 'content-type': 'text/x-shellscript; charset=utf-8' }));
app.get('/uninstall.sh', (c) =>
  c.body(
    `#!/bin/sh\n# Removes the wx93 CLI and desktop app that ${config.siteUrl}/install put in place. Config in ~/.config/wx93 is kept.\nset -eu\nU="\${XDG_DATA_HOME:-$HOME/.local/share}/wx93/uninstall.sh"\nif [ -x "$U" ]; then exec "$U"; fi\necho "wx93 does not look installed by the curl installer (no $U)." >&2\n`,
    200,
    { 'content-type': 'text/x-shellscript; charset=utf-8' },
  ),
);

app.get('/robots.txt', (c) =>
  c.text(['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /account', 'Disallow: /admin', 'Disallow: /oauth/', '', `Sitemap: ${config.siteUrl}/sitemap.xml`, ''].join('\n')),
);

// Sitemap index (house pattern): /sitemap.xml -> chunks under /sitemaps/. Short
// links redirect, so they are never listed; the static pages are the whole map.
const STATIC_PAGES = [
  ['/', 'daily', '1.0'],
  ['/pricing', 'weekly', '0.8'],
  ['/docs', 'weekly', '0.8'],
  ['/desktop', 'monthly', '0.5'],
  ['/signup', 'monthly', '0.5'],
  ['/report', 'monthly', '0.3'],
];
const BUILT = new Date().toISOString().slice(0, 10);
app.get('/sitemap.xml', (c) =>
  c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap><loc>${config.siteUrl}/sitemaps/static.xml</loc><lastmod>${BUILT}</lastmod></sitemap>\n</sitemapindex>\n`,
    200,
    { 'content-type': 'application/xml; charset=utf-8' },
  ),
);
app.get('/sitemaps/static.xml', (c) =>
  c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${STATIC_PAGES.map(
      ([p, f, pr]) => `  <url><loc>${config.siteUrl}${p}</loc><lastmod>${BUILT}</lastmod><changefreq>${f}</changefreq><priority>${pr}</priority></url>`,
    ).join('\n')}\n</urlset>\n`,
    200,
    { 'content-type': 'application/xml; charset=utf-8' },
  ),
);

app.get('/llms.txt', (c) =>
  c.text(`# wx93.me

> URL shortener for people and agents. Short links are plain HTTP redirects (they work with JavaScript off). Stats, QR codes, custom aliases, expiry, webhooks, custom domains.

## Shorten (no account needed)
POST ${config.siteUrl}/api/v1/links  {"url": "https://...", "alias"?: "...", "expires_in"?: "7d", "redirect_type"?: 301|302|307|308}
-> 201 {"short_url": "${config.siteUrl}/abc123", "id", "code", "qr_svg", ...}

## Auth
- Authorization: Bearer wx93_live_... (God Mode API key, Pro and up) or an OAuth 2.1 token from \`wx93 login\`.
- No auth: free links (people see a ${config.links.interstitialSeconds}s ad page; bots and link previews get the direct 302). ${config.links.anonPerHour} per hour per address.
- x402: past the free allowance the API answers 402 with an offer. A $${(config.x402.priceCents / 100).toFixed(2)} pass = ${config.x402.passMinutes} min, ${config.x402.passLinks} ad-free links. Send it as x-crawl-pass. Buy one: ${config.siteUrl}/x402

## Other endpoints
- GET /api/v1/links, GET|PATCH|DELETE /api/v1/links/{id|code}, GET /api/v1/links/{id|code}/stats?days=30
- POST /api/v1/links/bulk {"links": [...]} (Automation, up to 1,000)
- GET /api/v1/expand?url=${config.siteUrl}/abc123  (where a link goes, without following it)
- GET /qr/{code}.svg
- Two short domains, one namespace: every code works on wx93.me and 9xq.me. Pick the one a link is shown with by "domain": "9xq.me".
- POST /api/v1/reports {"url", "reason": "phishing|malware|spam|illegal|other"}

## Tools
- MCP (stdio): npx -y @profullstack/wx93-mcp
- MCP (hosted): POST ${config.siteUrl}/mcp  (JSON-RPC 2.0)
- CLI + TUI: curl -fsSL ${config.siteUrl}/install | sh   (or npm i -g @profullstack/wx93)
- OAuth 2.1 metadata: ${config.siteUrl}/.well-known/oauth-authorization-server
- Docs: ${config.siteUrl}/docs
- Pricing: Free $0 (ad page), Pro $5/mo or $50/yr, Automation $29/mo or $290/yr, paid in crypto via CoinPay.
`),
);

/* ------------------------------------------------------------- short links -- */

app.get('/qr/:file{[A-Za-z0-9][A-Za-z0-9_-]{0,63}\\.svg}', async (c) => {
  const code = c.req.param('file').slice(0, -4);
  const host = c.req.query('domain') || c.req.header('host') || config.host;
  const link = await resolve(host, code);
  if (!link || link.disabled_at) return c.text('no such link', 404);
  const asked = String(c.req.query('domain') ?? '').toLowerCase().replace(/^www\./, '');
  const text = link.hostname ? `https://${link.hostname}/${link.code}` : config.altHosts.includes(asked) ? `https://${asked}/${link.code}` : shortUrl(link);
  return c.body(qrSvg(text, { size: Number(c.req.query('size')) || 320 }), 200, {
    'content-type': 'image/svg+xml',
    'cache-control': 'public, max-age=86400',
  });
});

/**
 * THE PRODUCT. A short code in, a redirect out.
 *
 *   paid owner, x402-paid link, or any bot/unfurler/script  -> HTTP redirect
 *   a person in a browser, on a free link                   -> the interstitial
 *   code+                                                   -> where it goes, without going
 */
app.get('/:code{[A-Za-z0-9][A-Za-z0-9_-]{0,63}\\+?}', async (c) => {
  const raw = c.req.param('code');
  const preview = raw.endsWith('+');
  const code = preview ? raw.slice(0, -1) : raw;
  if (!CODE_PATH.test(code)) return c.notFound();
  const host = c.req.header('host') ?? config.host;
  let link;
  try {
    link = await resolve(host, code);
  } catch (err) {
    console.error('[redirect]', err?.message ?? err);
    return c.text('temporarily unavailable', 503, { 'retry-after': '5' });
  }
  const noindex = { 'x-robots-tag': 'noindex', 'cache-control': 'no-store' };
  if (!link) return c.html(P.Gone({ title: 'No such link', message: 'This short link does not exist. Check for a typo: codes are case-sensitive.' }), 404, noindex);
  if (link.disabled_at) return c.html(P.Gone({ title: 'This link was removed', message: `It was taken down: ${link.disabled_reason ?? 'abuse'}.`, status: 410 }), 410, noindex);
  if (link.expires_at && new Date(link.expires_at) < new Date()) return c.html(P.Gone({ title: 'This link has expired', message: 'Its owner set it to stop working.', status: 410 }), 410, noindex);
  if (preview) return c.html(P.Preview({ link, user: null }), 200, noindex);

  const ua = classify(c.req.header('user-agent'));
  const free = !adFree(link);
  const interstitial = free && ua.browserLike && c.req.method === 'GET';
  if (c.req.method === 'GET' && !isPrefetch(c.req.raw.headers)) {
    recordClick(link, {
      referrerHost: referrerHost(c.req.header('referer'), config.host),
      country: countryOf(clientIp(c.req.raw)),
      device: ua.device,
      browser: ua.browser,
      os: ua.os,
      bot: ua.bot,
    });
  }
  if (interstitial) {
    return c.html(P.Interstitial({ link, seconds: config.links.interstitialSeconds }), 200, {
      'cache-control': 'private, no-store',
      vary: 'User-Agent',
      'x-robots-tag': 'noindex',
    });
  }
  const status = free ? 302 : link.redirect_type;
  const permanent = status === 301 || status === 308;
  return new Response(null, {
    status,
    headers: {
      location: link.url,
      // A free link answers people and machines differently, so nothing may cache it.
      // A permanent redirect is cacheable for an hour; a temporary one never, so every click counts.
      'cache-control': free ? 'private, no-store' : permanent ? 'public, max-age=3600' : 'private, no-cache',
      ...(free ? { vary: 'User-Agent' } : {}),
      'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer-when-downgrade',
    },
  });
});

app.notFound((c) => c.html(P.Gone({ title: 'Not found', message: 'There is nothing here.' }), 404));
app.onError((err, c) => {
  console.error(`[web] ${c.req.method} ${c.req.path}:`, err);
  return c.req.path.startsWith('/api/') ? c.json({ error: 'something went wrong on our side' }, 500) : c.html(P.Gone({ title: 'Something broke', message: 'That was our fault. Try again in a moment.', status: 500 }), 500);
});
