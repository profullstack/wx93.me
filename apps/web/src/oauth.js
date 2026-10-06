import { createOAuthServer, OAuthError } from '@profullstack/auth-system/oauth2';
import { postgresStore } from '@profullstack/auth-system/oauth2/postgres';
import { db } from '@wx93/db';
import { getCookie } from 'hono/cookie';
import * as auth from './auth.js';
import { config } from './config.js';
import { e, layout } from './pages.js';

/**
 * OAuth 2.1 for our own clients, from the shared house implementation
 * (@profullstack/auth-system/oauth2): `wx93 login` in the CLI, and through its
 * token file the TUI, the stdio MCP server and the desktop app. Authorization
 * code + PKCE S256, loopback redirects (RFC 8252), rotating refresh tokens.
 * Access tokens look like wx93_at_….
 */

const CLIENTS = () => ({
  'wx93-cli': {
    name: 'wx93 CLI, TUI, MCP and desktop',
    redirectUris: ['http://127.0.0.1/callback', 'http://localhost/callback', `${config.siteUrl}/oauth/cli`],
  },
});

let server = null;
export function oauth() {
  server ??= createOAuthServer({
    store: postgresStore(db()),
    clients: CLIENTS(),
    issuer: config.siteUrl,
    tokenPrefix: 'wx93',
    scopes: ['read', 'write'],
  });
  return server;
}

/** Bearer wx93_at_… -> the user row, or null. */
export async function userFromAccessToken(header) {
  if (!/^Bearer\s+wx93_at_/i.test(String(header ?? ''))) return null;
  const who = await oauth().verifyAccessToken(header);
  if (!who) return null;
  const [u] = await db()`select * from users where id::text = ${who.userId}`;
  return u ?? null;
}

const form = async (c) => {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) return c.req.json().catch(() => ({}));
  return Object.fromEntries(new URLSearchParams(await c.req.text()));
};

const errorPage = (c, err) =>
  c.html(
    layout({
      title: 'Sign-in request refused',
      noindex: true,
      body: `<section class="narrow"><p class="eyebrow">OAuth</p><h1>That sign-in request is not valid.</h1><p class="lede">${e(err.message)}</p><a class="btn" href="/">Home</a></section>`,
    }),
    400,
  );

export function mountOAuth(app) {
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(oauth().metadata()));

  app.get('/oauth/authorize', async (c) => {
    let p;
    try {
      p = oauth().validateAuthorize(c.req.query());
    } catch (err) {
      return errorPage(c, err);
    }
    const user = await auth.userFromSession(getCookie(c, config.session.cookie));
    if (!user) return c.redirect(`/signin?next=${encodeURIComponent(c.req.url.replace(/^https?:\/\/[^/]+/, ''))}`, 302);
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost)/.test(p.redirectUri);
    const hidden = Object.entries(c.req.query())
      .map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`)
      .join('');
    return c.html(
      layout({
        title: 'Allow access',
        noindex: true,
        body: `<section class="narrow"><p class="eyebrow">Sign in</p>
          <h1>Allow <em>${e(p.clientName)}</em>?</h1>
          <p class="lede">It will act as <b>${e(user.email)}</b> on wx93: ${p.scope.includes('write') ? 'create, change and delete your links, and read their stats' : 'read your links and stats'}.
          ${loopback ? 'It is waiting on this computer.' : 'You will get a code to paste back into it.'}</p>
          <form method="post" action="/oauth/authorize" class="card row">
            ${hidden}
            <button class="btn primary" name="decision" value="allow">Allow</button>
            <button class="btn" name="decision" value="deny">Deny</button>
          </form>
          <p class="muted">Revoke it any time with <code>wx93 logout</code>.</p></section>`,
      }),
    );
  });

  app.post('/oauth/authorize', async (c) => {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(config.siteUrl).origin) return c.text('cross-site request refused', 403);
    const user = await auth.userFromSession(getCookie(c, config.session.cookie));
    if (!user) return c.redirect('/signin', 302);
    const b = await form(c);
    let p;
    try {
      p = oauth().validateAuthorize(b);
    } catch (err) {
      return errorPage(c, err);
    }
    if (b.decision !== 'allow') return c.redirect(oauth().denyUrl(p), 302);
    return c.redirect(await oauth().approve({ ...p, userId: user.id }), 302);
  });

  app.post('/oauth/token', async (c) => {
    try {
      const tokens = await oauth().token(await form(c));
      return c.json(tokens, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
    } catch (err) {
      if (err instanceof OAuthError) return c.json(err.toJSON(), err.status ?? 400, { 'cache-control': 'no-store' });
      console.error('[oauth] token', err);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const b = await form(c);
    await oauth()
      .revoke(b.token)
      .catch(() => {});
    return c.json({}, 200);
  });

  // Headless sign-in (SSH): the browser lands here and shows the code to paste back.
  app.get('/oauth/cli', (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const err = c.req.query('error');
    const body = err
      ? `<h1>Sign-in ${e(err.replace(/_/g, ' '))}.</h1><p class="lede">Nothing was shared. Run <code>wx93 login</code> again if you meant to.</p>`
      : `<h1>Paste this into your terminal</h1><pre class="code" id="code">${e(code)}#${e(state)}</pre><p class="muted">It works once and expires in 5 minutes.</p>`;
    return c.html(layout({ title: 'wx93 CLI sign-in', noindex: true, body: `<section class="narrow"><p class="eyebrow">wx93 CLI</p>${body}</section>` }));
  });
}
