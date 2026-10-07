import { renderAd } from './ads.js';
import { config, PLANS } from './config.js';

/**
 * Server-rendered pages. Everything a visitor needs works with JavaScript off:
 * shortening, signing in by link, the interstitial, reports. /assets/app.js only
 * adds copy buttons and passkeys (which need the browser API by nature).
 */

export const e = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const money = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const num = (n) => Number(n ?? 0).toLocaleString('en-US');

export function layout({ title, description, path, noindex = false, body, user, head = '', bare = false }) {
  const site = config.siteUrl;
  const desc = description ?? 'Short links that work with JavaScript off. Stats, QR codes, custom aliases, and an API, CLI and MCP server for agents.';
  const canonical = path !== undefined && !noindex ? `<link rel="canonical" href="${e(site)}${e(path)}">` : '';
  const fullTitle = title ? `${title} · wx93` : 'wx93: short links for people and agents';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(fullTitle)}</title>
<meta name="description" content="${e(desc)}">
${canonical}
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<meta name="theme-color" content="#0b0d10">
<meta name="application-name" content="wx93">
<meta property="og:site_name" content="wx93">
<meta property="og:title" content="${e(fullTitle)}">
<meta property="og:description" content="${e(desc)}">
${path !== undefined ? `<meta property="og:url" content="${e(site)}${e(path)}">` : ''}
<meta property="og:image" content="${e(site)}/icons/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/assets/app.css">
${head}
</head>
<body>
${bare ? '' : nav(user)}
<main>
${body}
</main>
${bare ? '' : footer()}
${bare ? '' : '<script src="/assets/app.js" defer></script>'}
</body>
</html>`;
}

function nav(user) {
  return `<header class="nav"><a class="brand" href="/" aria-label="wx93 home"><img src="/logo.svg" alt="" width="28" height="28"><span>wx93</span></a>
<nav><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/docs#cli">CLI</a>${
    user ? `<a class="btn small" href="/account">Account</a>` : `<a href="/signin">Sign in</a><a class="btn small primary" href="/signup">Sign up</a>`
  }</nav></header>`;
}

function footer() {
  return `<footer class="foot"><div class="cols">
<div><a class="brand" href="/"><img src="/logo.svg" alt="" width="22" height="22"><span>wx93</span></a><p class="muted">Short links for people and agents. A <a href="https://profullstack.com">Profullstack</a> product.</p></div>
<div><b>Product</b><a href="/pricing">Pricing</a><a href="/docs">API</a><a href="/docs#cli">CLI and TUI</a><a href="/docs#mcp">MCP server</a><a href="/desktop">Desktop</a></div>
<div><b>For agents</b><a href="/llms.txt">llms.txt</a><a href="/docs#x402">x402 pay per call</a><a href="/.well-known/oauth-authorization-server">OAuth 2.1</a><a href="https://github.com/profullstack/wx93.me">Source (MIT)</a></div>
<div><b>Safety</b><a href="/report">Report a link</a><a href="/docs#abuse">Abuse policy</a><a href="/docs#privacy">Privacy</a></div>
</div><p class="tiny muted">Country lookups by <a href="https://db-ip.com">DB-IP</a> (CC BY 4.0). Payments in crypto by <a href="https://coinpayportal.com">CoinPay</a>.</p></footer>`;
}

/* ------------------------------------------------------------------ forms -- */

const hostPicker = (extra = []) =>
  `<label>Domain <select name="domain">${[...config.shortHosts, ...extra].map((h, i) => `<option${i ? '' : ' selected'}>${e(h)}</option>`).join('')}</select></label>`;

export function shortenForm({ guardFields = '', user, plan, value = '' } = {}) {
  const aliases = plan?.aliases;
  return `<form class="shorten" method="post" action="/shorten">
  <label class="sr" for="url">Long URL</label>
  <input id="url" name="url" type="url" inputmode="url" placeholder="Paste a long link: https://…" value="${e(value)}" required autocomplete="off" autofocus>
  <button class="btn primary big" type="submit">Shorten</button>
  ${guardFields}
  ${aliases ? '' : `<div class="row">${hostPicker()}</div>`}
  ${
    aliases
      ? `<details class="more" open><summary>Domain, alias and expiry</summary><div class="row">${hostPicker()}<label>wx93.me/<input name="alias" placeholder="my-alias" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,63}"></label><label>Expires <select name="expires_in"><option value="">never</option><option value="1d">in a day</option><option value="7d">in a week</option><option value="30d">in 30 days</option><option value="365d">in a year</option></select></label></div></details>`
      : user
        ? `<p class="hint">Free links open through a short ad page. <a href="/pricing">Pro</a> links go straight through and can have custom aliases.</p>`
        : `<p class="hint">No account needed. Free links open through a five-second ad page; <a href="/pricing">Pro</a> links do not.</p>`
  }
</form>`;
}

/* ------------------------------------------------------------------ pages -- */

export function Landing({ user, plan, guardFields, value = '' }) {
  return layout({
    path: '/',
    user,
    body: `<section class="hero">
<p class="eyebrow">Short links · no JavaScript required</p>
<h1>Shorten it. <span class="accent">Share it.</span> See who clicked.</h1>
<p class="lede">wx93.me turns long URLs into short ones that open with a plain HTTP redirect, so they work in every browser, every chat app and every terminal. Stats, QR codes, custom aliases, expiry, and an API, CLI and MCP server for your agents.</p>
${shortenForm({ guardFields, user, plan, value })}
</section>
<section class="grid3">
<div class="card"><h3>Works with JavaScript off</h3><p>A short link is a 301 or 302. Previews in Slack, iMessage, X and Discord unfurl the real page, because crawlers always get the direct redirect.</p></div>
<div class="card"><h3>Numbers you can use</h3><p>Clicks by day, referrer, country, device and browser, with people and bots counted apart. No IP address is ever stored.</p></div>
<div class="card"><h3>Built for agents</h3><p>REST API with one God Mode key, a CLI with a TUI, an MCP server, OAuth 2.1 sign-in from the terminal, and x402 so an agent with no account can pay per call.</p></div>
</section>
<section class="split">
<div><p class="eyebrow">Terminal</p><h2>One line to install</h2><p>The CLI and TUI install under <code>~/.local</code>, never with sudo. On a desktop it brings the desktop app too.</p>
<pre class="code copyable">curl -fsSL ${e(config.siteUrl)}/install | sh</pre>
<pre class="code">wx93 https://example.com/a/very/long/path
${e(config.siteUrl.replace(/^https?:\/\//, ''))}/k3X9aQ</pre></div>
<div><p class="eyebrow">MCP</p><h2>Give your agent a shortener</h2><pre class="code">{
  "mcpServers": {
    "wx93": { "command": "npx", "args": ["-y", "@profullstack/wx93-mcp"] }
  }
}</pre><p class="muted">Or point any MCP client at <code>${e(config.siteUrl)}/mcp</code>.</p></div>
</section>
<section class="plans">${planCards({ compact: true })}</section>`,
  });
}

export function ShortenResult({ link, user, guardFields, plan, notice }) {
  const short = link.short_url;
  return layout({
    title: 'Your short link',
    noindex: true,
    user,
    body: `<section class="narrow">
<p class="eyebrow">Done</p>
<h1 class="shorturl"><a href="${e(short)}">${e(short.replace(/^https?:\/\//, ''))}</a></h1>
<div class="row"><input class="copyfield" readonly value="${e(short)}" aria-label="Short link"><button class="btn copy" data-copy="${e(short)}" type="button">Copy</button></div>
<p class="muted">Points to <span class="dest">${e(link.url)}</span></p>
${notice ? `<p class="hint">${notice}</p>` : ''}
<div class="qr"><img src="${e(link.qr_svg)}" alt="QR code for ${e(short)}" width="220" height="220"><a class="btn small" href="${e(link.qr_svg)}" download="${e(link.code)}.svg">Download QR (SVG)</a></div>
<h2>Another one</h2>
${shortenForm({ guardFields, user, plan })}
</section>`,
  });
}

export function planCards({ compact = false, user, plan, chains = [], defaultChain } = {}) {
  const card = (key, blurb, features) => {
    const p = PLANS[key];
    const current = plan?.key === key;
    const buy =
      key === 'free'
        ? user
          ? ''
          : `<a class="btn" href="/signup">Sign up free</a>`
        : user
          ? `<form method="post" action="/billing/checkout" class="buy">
              <input type="hidden" name="plan" value="${key}">
              <select name="term" aria-label="Term"><option value="month">${money(p.monthCents)} for a month</option><option value="year">${money(p.yearCents)} for a year</option></select>
              ${chains.length ? `<select name="chain" aria-label="Pay with">${chains.map((ch) => `<option value="${e(ch)}"${ch === defaultChain ? ' selected' : ''}>${e(ch.replace('_', ' on '))}</option>`).join('')}</select>` : ''}
              <button class="btn primary">${current ? 'Extend' : `Get ${p.name}`}</button></form>`
          : `<a class="btn primary" href="/signup?next=/pricing">Get ${p.name}</a>`;
    return `<div class="card plan${key === 'pro' ? ' featured' : ''}${current ? ' current' : ''}">
<h3>${p.name}${current ? ' <span class="pill">your plan</span>' : ''}</h3>
<p class="price">${key === 'free' ? '$0' : `${money(p.monthCents)}<small>/month</small>`}</p>
${key === 'free' ? '<p class="muted">forever</p>' : `<p class="muted">or ${money(p.yearCents)} a year</p>`}
<p>${blurb}</p>
${compact ? '' : `<ul>${features.map((f) => `<li>${f}</li>`).join('')}</ul>`}
${buy}</div>`;
  };
  return `<div class="grid3">
${card('free', 'Short links for anyone, no account needed.', [
  'Random short codes, QR codes, expiry',
  'Opens through a 5 second ad page (people only; bots and previews go straight through)',
  `${num(PLANS.free.linksPerMonth)} links a month with an account, ${config.links.anonPerHour} an hour without`,
  'Total click count',
  'CLI, TUI and MCP for creating links',
])}
${card('pro', 'Clean links and real numbers, for a person or a small team.', [
  'No ad page: every click goes straight through',
  'Custom aliases (wx93.me/your-name) and 301, 302, 307 or 308',
  'Full stats: daily clicks, referrers, countries, devices, browsers',
  'API keys (God Mode) and the full REST API',
  `${num(PLANS.pro.linksPerMonth)} links a month`,
])}
${card('automation', 'For agents and businesses running links at volume.', [
  'Everything in Pro',
  'Bulk create: up to 1,000 links per request',
  'Signed webhooks on every create and click',
  `Up to ${PLANS.automation.domains} custom domains`,
  `${num(PLANS.automation.linksPerMonth)} links a month and higher rate limits`,
  'Built for the API, CLI, MCP, PWA and desktop together',
])}
</div>`;
}

export function Pricing({ user, plan, chains, defaultChain, paymentsOn }) {
  return layout({
    title: 'Pricing',
    path: '/pricing',
    description: 'wx93 pricing: Free with an ad page, Pro $5/month, Automation $29/month, or x402 pay per call for agents. Paid in crypto.',
    user,
    body: `<section class="narrow wide"><p class="eyebrow">Pricing</p><h1>Pay for clean links, not for links.</h1>
<p class="lede">Every plan shortens without limits on clicks. Paid plans are prepaid in crypto through CoinPay (USDC on Polygon by default) and never renew by themselves: pay for a month or a year, extend whenever you like.${paymentsOn ? '' : ' <b>Checkout is being switched on; it will be here shortly.</b>'}</p>
${planCards({ user, plan, chains, defaultChain })}
<div class="card" id="x402"><h3>Agents with no account: x402</h3>
<p>An agent can pay per call over <a href="https://x402.org">x402</a>, with no signup and no key. ${money(config.x402.priceCents)} buys a pass good for ${config.x402.passMinutes} minutes and up to ${config.x402.passLinks} links, and every link made with it is ad-free for a year. Over the free allowance the API answers <code>402</code> with the offer; or buy one up front at <a href="/x402">/x402</a>.</p></div>
</section>`,
  });
}

export function Docs({ user }) {
  const s = config.siteUrl;
  return layout({
    title: 'Docs: API, CLI, MCP',
    path: '/docs',
    description: 'wx93 REST API, CLI and TUI, MCP server, OAuth 2.1 and x402: everything an agent needs to shorten links.',
    user,
    body: `<section class="narrow wide docs">
<p class="eyebrow">Docs</p><h1>Shorten from anywhere</h1>
<p class="lede">One REST API under <code>/api/v1</code>, and four ways to call it: curl, the CLI, the MCP server and the desktop app. Machine-readable summary at <a href="/llms.txt">/llms.txt</a>.</p>

<h2 id="api">REST API</h2>
<p>Authenticate with <code>Authorization: Bearer &lt;key&gt;</code>. Keys (<code>wx93_live_…</code>) are God Mode: one key can do anything its account can. Make one on your <a href="/account#keys">account page</a> (Pro and up). OAuth access tokens from <code>wx93 login</code> (<code>wx93_at_…</code>) work the same way. With no key you can still create free links.</p>
<pre class="code">curl -s ${e(s)}/api/v1/links \\
  -H 'authorization: Bearer wx93_live_…' -H 'content-type: application/json' \\
  -d '{"url":"https://example.com/long","alias":"launch","expires_in":"30d"}'</pre>
<table class="tbl">
<tr><td><code>POST /api/v1/links</code></td><td><code>{url, alias?, title?, expires_at? | expires_in? ("7d", "12h"), redirect_type? (301|302|307|308), domain? ("wx93.me" default, "9xq.me", or your verified domain)}</code> → 201 link</td></tr>
<tr><td><code>POST /api/v1/links/bulk</code></td><td><code>{links: [{url, alias?, …}]}</code>, up to 1,000 (Automation) → per-item results</td></tr>
<tr><td><code>GET /api/v1/links</code></td><td>your links, newest first; <code>?limit=&amp;before=&amp;q=</code></td></tr>
<tr><td><code>GET /api/v1/links/{id|code}</code></td><td>one link</td></tr>
<tr><td><code>PATCH /api/v1/links/{id|code}</code></td><td><code>{url?, title?, expires_at?, redirect_type?}</code></td></tr>
<tr><td><code>DELETE /api/v1/links/{id|code}</code></td><td>delete it; the code stops resolving at once</td></tr>
<tr><td><code>GET /api/v1/links/{id|code}/stats</code></td><td><code>?days=30</code>: totals, daily, referrers, countries, devices, browsers, os (Pro and up; Free gets totals)</td></tr>
<tr><td><code>GET /qr/{code}.svg</code></td><td>QR code, SVG</td></tr>
<tr><td><code>GET /api/v1/expand?url=</code></td><td>where a wx93 link goes, without visiting it</td></tr>
<tr><td><code>GET /api/v1/me</code></td><td>account, plan, usage and limits</td></tr>
<tr><td><code>GET|POST|DELETE /api/v1/keys</code></td><td>API keys</td></tr>
<tr><td><code>GET|POST|DELETE /api/v1/webhooks</code></td><td>Automation: <code>{url, events?}</code>; <code>POST /api/v1/webhooks/{id}/test</code></td></tr>
<tr><td><code>GET|POST|DELETE /api/v1/domains</code></td><td>Automation: <code>{hostname}</code>, then TXT <code>_wx93.&lt;hostname&gt;</code> and <code>POST /api/v1/domains/{id}/verify</code></td></tr>
<tr><td><code>POST /api/v1/billing/checkout</code></td><td><code>{plan: "pro"|"automation", term: "month"|"year", chain?}</code> → <code>{checkout_url}</code></td></tr>
<tr><td><code>POST /api/v1/reports</code></td><td><code>{url, reason: phishing|malware|spam|illegal|other, details?}</code></td></tr>
<tr><td><code>GET /api/v1/health</code></td><td>liveness, with a database round trip</td></tr>
</table>

<h3 id="redirects">How a short link answers</h3>
<ul>
<li>Pro and Automation links: the HTTP redirect you chose (302 by default). 301 and 308 are cacheable for an hour, so repeat visits from one browser may not be counted.</li>
<li>Free links, opened by a person in a browser: a page with an ad and a ${config.links.interstitialSeconds} second <code>&lt;meta http-equiv="refresh"&gt;</code>, plus a Continue link. No JavaScript involved.</li>
<li>Free links, fetched by a crawler, a link unfurler, curl or any script: the plain 302, so previews and tools keep working.</li>
<li>Every code works on both of our short domains: <code>wx93.me/abc123</code> and <code>9xq.me/abc123</code> are the same link, with the same stats. Pick which one a link is shown with by <code>domain</code>.</li>
<li>Add <code>+</code> to any link (<code>wx93.me/abc123+</code>) to see where it goes without going there.</li>
</ul>

<h2 id="cli">CLI and TUI</h2>
<pre class="code copyable">curl -fsSL ${e(s)}/install | sh</pre>
<p>Installs <code>wx93</code> under <code>~/.local</code> without sudo; adds the desktop app when there is a desktop session (<code>--desktop</code> / <code>--cli-only</code> to choose). Or <code>npm i -g @profullstack/wx93</code>.</p>
<pre class="code">wx93 https://example.com/long --alias launch --expires 30d
wx93 login              # OAuth 2.1 in your browser (--manual over SSH)
wx93 ls                 # your links
wx93 stats launch       # referrers, countries, devices
wx93 qr launch          # a QR code in the terminal
wx93 bulk urls.txt      # one URL per line (Automation)
wx93 tui                # all of it, as a screen
wx93 mcp                # stdio MCP server
wx93 upgrade | uninstall</pre>

<h2 id="mcp">MCP server</h2>
<p>Stdio: <code>npx -y @profullstack/wx93-mcp</code> (or <code>wx93 mcp</code>). It uses your <code>wx93 login</code> sign-in or <code>WX93_API_KEY</code>. Hosted: <code>POST ${e(s)}/mcp</code> (JSON-RPC 2.0, streamable HTTP, Bearer key optional). Tools: <code>shorten_url</code>, <code>bulk_shorten</code>, <code>list_links</code>, <code>get_link</code>, <code>link_stats</code>, <code>update_link</code>, <code>delete_link</code>, <code>expand_link</code>, <code>whoami</code>.</p>

<h2 id="oauth">OAuth 2.1</h2>
<p>Authorization code with PKCE (S256), loopback redirects, rotating refresh tokens. Metadata at <a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a>. Public client id <code>wx93-cli</code>.</p>

<h2 id="x402">x402: pay per call</h2>
<p>No account, no key. Past the free allowance (${config.links.anonPerHour} links an hour per address) <code>POST /api/v1/links</code> answers <code>402</code> with an x402 offer. Pay it (USDC on Base, Polygon or Ethereum) and send the pass back as <code>x-crawl-pass</code>. A pass costs $${(config.x402.priceCents / 100).toFixed(2)}, lasts ${config.x402.passMinutes} minutes, covers ${config.x402.passLinks} links, and every link made with it skips the ad page for a year.</p>
<pre class="code">npm i -g @profullstack/coinpay
coinpay x402 pay ${e(s)}/x402 --output pass.json
curl -s ${e(s)}/api/v1/links -H "x-crawl-pass: $(node -p "require('./pass.json').pass")" \\
  -H 'content-type: application/json' -d '{"url":"https://example.com"}'</pre>

<h2 id="abuse">Abuse policy</h2>
<p>Every destination is checked when it is shortened: http and https only, no credentials in the URL, no private addresses, no other shorteners, our blocklist, the URLhaus and OpenPhish feeds (refreshed every few hours and swept over existing links), and Google Safe Browsing where configured. Anonymous links that look like credential phishing need an account. Anyone can <a href="/report">report a link</a>; after ${config.links.reportThreshold} independent reports it is pulled pending review.</p>

<h2 id="privacy">Privacy</h2>
<p>A click records the time, the referring site's hostname, a country code, and the device, browser and OS family. The visitor's IP address is used once to look up the country and is never stored.</p>
</section>`,
  });
}

export function SignIn({ signup = false, error, next = '', guardFields = '', user }) {
  return layout({
    title: signup ? 'Sign up' : 'Sign in',
    path: signup ? '/signup' : '/signin',
    user,
    body: `<section class="narrow">
<p class="eyebrow">${signup ? 'Sign up' : 'Sign in'}</p>
<h1>${signup ? 'Make an account with your email.' : 'Welcome back.'}</h1>
<p class="lede">${signup ? 'No password. We email you a link; opening it makes the account. Add a passkey afterwards for one-tap sign-in.' : 'We email you a sign-in link. No password, nothing to forget.'}</p>
${error ? `<p class="error">${e(error)}</p>` : ''}
<form method="post" action="/auth/link" class="card stack">
<label for="email">Email</label>
<input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
<input type="hidden" name="next" value="${e(next)}">
${guardFields}
<button class="btn primary">${signup ? 'Email me a sign-up link' : 'Email me a sign-in link'}</button>
</form>
<div class="card stack js-only" hidden><p class="muted">Have a passkey on this device?</p><button class="btn" data-passkey-login type="button">Sign in with a passkey</button><p class="error" data-passkey-error hidden></p></div>
<p class="muted">${signup ? 'Already have an account? <a href="/signin">Sign in</a>.' : 'New here? <a href="/signup">Sign up</a>: it is the same link.'}</p>
</section>`,
  });
}

export function Sent({ email, user }) {
  return layout({
    title: 'Check your email',
    noindex: true,
    user,
    body: `<section class="narrow"><p class="eyebrow">Sent</p><h1>Check your email.</h1>
<p class="lede">If <b>${e(email)}</b> can receive mail, a sign-in link is on its way. It works once and expires in 20 minutes.</p></section>`,
  });
}

export function Account({ user, plan, links, usage, keys, passkeys, hooks, domains, billing, created, flash }) {
  const rows = links
    .map(
      (l) => `<tr><td><a href="${e(l.short_url)}" class="mono">${e(l.short_url.replace(/^https?:\/\//, ''))}</a>${l.disabled ? ' <span class="pill bad">disabled</span>' : ''}</td>
<td class="dest" title="${e(l.url)}">${e(l.url)}</td><td class="num">${num(l.human_clicks)}</td>
<td><a href="/account/links/${e(l.id)}">stats</a></td></tr>`,
    )
    .join('');
  return layout({
    title: 'Account',
    noindex: true,
    user,
    body: `<section class="narrow wide">
<p class="eyebrow">Account</p>
<h1>${e(user.email)}</h1>
${flash ? `<p class="hint">${flash}</p>` : ''}
<div class="grid3">
<div class="card"><h3>Plan</h3><p class="price small">${e(plan.name)}${plan.staff ? ' (staff)' : ''}</p>
<p class="muted">${plan.paid_through ? `Paid through ${day(plan.paid_through)}${billing.coverage_end && day(billing.coverage_end) !== day(plan.paid_through) ? `, more queued to ${day(billing.coverage_end)}` : ''}.` : plan.key === 'free' ? 'Free links open through an ad page.' : ''}</p>
<a class="btn small" href="/pricing">${plan.key === 'free' ? 'Upgrade' : 'Extend or change'}</a></div>
<div class="card"><h3>This month</h3><p class="price small">${num(usage.links)} <small>of ${num(plan.linksPerMonth)} links</small></p></div>
<div class="card"><h3>Sign-in</h3><p class="muted">${passkeys} passkey${passkeys === 1 ? '' : 's'} on this account.</p>
<button class="btn small js-only" hidden data-passkey-register type="button">Add a passkey</button><p class="muted" data-passkey-status></p>
<form method="post" action="/auth/signout"><button class="btn small">Sign out</button></form></div>
</div>

<h2>New link</h2>
<form class="shorten" method="post" action="/shorten">
<input name="url" type="url" placeholder="https://…" required>
<button class="btn primary">Shorten</button>
${plan.aliases ? `<div class="row"><label>${e(config.host)}/<input name="alias" placeholder="alias (optional)" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,63}"></label><label>Expires <select name="expires_in"><option value="">never</option><option value="1d">in a day</option><option value="7d">in a week</option><option value="30d">in 30 days</option><option value="365d">in a year</option></select></label>${hostPicker(domains.filter((d) => d.verified_at).map((d) => d.hostname))}</div>` : ''}
</form>

<h2>Your links</h2>
${links.length ? `<table class="tbl links"><tr><th>Short</th><th>Destination</th><th>People</th><th></th></tr>${rows}</table>` : '<p class="muted">None yet.</p>'}

<h2 id="keys">API keys</h2>
${
  plan.apiKeys
    ? `${created ? `<div class="card"><p>Your new key. It is shown once; store it now.</p><div class="row"><input class="copyfield mono" readonly value="${e(created)}"><button class="btn copy" data-copy="${e(created)}" type="button">Copy</button></div></div>` : ''}
<table class="tbl">${keys.map((k) => `<tr><td class="mono">${e(k.prefix)}…</td><td>${e(k.name)}</td><td>${k.last_used_at ? `used ${day(k.last_used_at)}` : 'never used'}</td><td><form method="post" action="/account/keys/${e(k.id)}/revoke"><button class="btn small">Revoke</button></form></td></tr>`).join('')}</table>
<form method="post" action="/account/keys" class="row"><input name="name" placeholder="key name (e.g. my-agent)" maxlength="60"><button class="btn">Create a God Mode key</button></form>`
    : `<p class="muted">API keys come with <a href="/pricing">Pro</a>. On Free, sign the CLI in with <code>wx93 login</code> instead.</p>`
}

<h2 id="webhooks">Webhooks</h2>
${
  plan.webhooks
    ? `<table class="tbl">${hooks.map((h) => `<tr><td class="mono">${e(h.url)}</td><td>${e(h.events.join(', '))}</td><td>${h.disabled_at ? 'disabled' : h.last_status ? `last ${h.last_status}` : 'no deliveries yet'}</td><td><form method="post" action="/account/webhooks/${e(h.id)}/delete"><button class="btn small">Delete</button></form></td></tr>`).join('')}</table>
<form method="post" action="/account/webhooks" class="row"><input name="url" type="url" placeholder="https://your-app.example/hooks/wx93" required><button class="btn">Add webhook</button></form>
<p class="muted">Signed with <code>x-wx93-signature: t=…,v1=…</code> (HMAC-SHA256 of <code>t.body</code>). The secret is shown once when you add it via the API.</p>`
    : `<p class="muted">Webhooks come with <a href="/pricing">Automation</a>.</p>`
}

<h2 id="domains">Custom domains</h2>
${
  plan.domains
    ? `<table class="tbl">${domains.map((d) => `<tr><td class="mono">${e(d.hostname)}</td><td>${d.verified_at ? 'verified' : `TXT <code>_wx93.${e(d.hostname)}</code> = <code>${e(d.verify_token)}</code>`}</td><td>${d.verified_at ? '' : `<form method="post" action="/account/domains/${e(d.id)}/verify"><button class="btn small">Check</button></form>`}</td></tr>`).join('')}</table>
<form method="post" action="/account/domains" class="row"><input name="hostname" placeholder="go.example.com" required><button class="btn">Add domain</button></form>
<p class="muted">Point the hostname at ${e(config.host)} with a CNAME (or an A record to our address), add the TXT record above, then press Check. HTTPS for a new domain is issued after it verifies.</p>`
    : `<p class="muted">Custom domains come with <a href="/pricing">Automation</a>.</p>`
}
</section>`,
  });
}

const bars = (rows, total) =>
  rows.length
    ? `<table class="tbl bars">${rows
        .map((r) => `<tr><td>${e(r.key)}</td><td class="num">${num(r.clicks)}</td><td class="barcell"><span style="width:${Math.max(2, Math.round((100 * r.clicks) / Math.max(1, total)))}%"></span></td></tr>`)
        .join('')}</table>`
    : '<p class="muted">Nothing yet.</p>';

export function LinkStatsPage({ user, link, stats, full }) {
  const peak = Math.max(1, ...(stats.daily ?? []).map((d) => d.clicks));
  return layout({
    title: `Stats for ${link.code}`,
    noindex: true,
    user,
    body: `<section class="narrow wide">
<p class="eyebrow">Link</p>
<h1 class="shorturl"><a href="${e(link.short_url)}">${e(link.short_url.replace(/^https?:\/\//, ''))}</a></h1>
<p class="muted">→ <span class="dest">${e(link.url)}</span> · created ${day(link.created_at)}${link.expires_at ? ` · expires ${day(link.expires_at)}` : ''}</p>
<div class="grid3">
<div class="card"><h3>People</h3><p class="price small">${num(stats.humans)}</p><p class="muted">last ${stats.days} days</p></div>
<div class="card"><h3>Bots and previews</h3><p class="price small">${num(stats.bots)}</p></div>
<div class="card qr"><img src="${e(link.qr_svg)}" alt="QR code" width="120" height="120"><a class="btn small" href="${e(link.qr_svg)}" download="${e(link.code)}.svg">QR (SVG)</a></div>
</div>
${
  full
    ? `<h2>Daily</h2><div class="spark">${(stats.daily ?? []).map((d) => `<span title="${e(d.day)}: ${d.clicks}" style="height:${Math.max(2, Math.round((100 * d.clicks) / peak))}%"></span>`).join('') || '<p class="muted">No clicks yet.</p>'}</div>
<div class="grid2"><div><h2>Referrers</h2>${bars(stats.referrers, stats.humans)}</div><div><h2>Countries</h2>${bars(stats.countries, stats.humans)}</div>
<div><h2>Devices</h2>${bars(stats.devices, stats.humans)}</div><div><h2>Browsers</h2>${bars(stats.browsers, stats.humans)}</div></div>`
    : '<p class="hint">Referrers, countries, devices and daily numbers come with <a href="/pricing">Pro</a>.</p>'
}
<form method="post" action="/account/links/${e(link.id)}/delete" class="row"><button class="btn small danger">Delete this link</button></form>
</section>`,
  });
}

/* ------------------------------------------------- the visitor's side -- */

const host = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * The free link's interstitial. No JavaScript anywhere: the refresh is a meta
 * tag, the countdown is a CSS animation, the ad is a server-rendered frame, and
 * the way out is a plain link.
 */
export function Interstitial({ link, seconds }) {
  const dest = link.url;
  return layout({
    title: `Continuing to ${host(dest)}`,
    noindex: true,
    bare: true,
    head: `<meta http-equiv="refresh" content="${seconds};url=${e(dest)}"><meta name="referrer" content="origin">`,
    body: `<section class="interstitial">
<a class="brand" href="/"><img src="/logo.svg" alt="" width="26" height="26"><span>wx93</span></a>
<p class="eyebrow">You are going to</p>
<h1 class="desthost">${e(host(dest))}</h1>
<p class="dest full">${e(dest)}</p>
<div class="countdown" style="--secs:${seconds}s" aria-hidden="true"><span></span></div>
<p class="muted">Continuing in ${seconds} seconds.</p>
<a class="btn primary big" href="${e(dest)}" rel="nofollow noopener noreferrer">Continue to ${e(host(dest))}</a>
${renderAd({ placement: 'interstitial' })}
<p class="tiny muted">This page keeps free wx93 links free. <a href="/pricing">Pro links skip it.</a> · <a href="/report?code=${e(link.code)}">Report this link</a></p>
</section>`,
  });
}

export function Preview({ link, user }) {
  return layout({
    title: `Where ${link.code} goes`,
    noindex: true,
    user,
    body: `<section class="narrow"><p class="eyebrow">Link preview</p>
<h1 class="shorturl">${e(config.host)}/${e(link.code)}</h1>
<p class="lede">goes to <b>${e(host(link.url))}</b></p>
<p class="dest full">${e(link.url)}</p>
<p class="muted">Created ${day(link.created_at)}${link.expires_at ? ` · expires ${day(link.expires_at)}` : ''}</p>
<div class="row"><a class="btn primary" href="${e(link.url)}" rel="nofollow noopener noreferrer">Go there</a><a class="btn" href="/report?code=${e(link.code)}">Report it</a></div>
<div class="qr"><img src="/qr/${e(link.code)}.svg" alt="QR code" width="160" height="160"></div></section>`,
  });
}

export function Gone({ title, message, user, status = 404 }) {
  return layout({
    title,
    noindex: true,
    user,
    body: `<section class="narrow"><p class="eyebrow">${status}</p><h1>${e(title)}</h1><p class="lede">${e(message)}</p><a class="btn" href="/">Make a short link</a></section>`,
  });
}

export function ReportPage({ guardFields, code = '', done = false, error, user }) {
  return layout({
    title: 'Report a link',
    path: '/report',
    user,
    body: `<section class="narrow"><p class="eyebrow">Safety</p><h1>Report a wx93 link</h1>
${
  done
    ? '<p class="lede">Thank you. We look at every report, and a link reported by several people is pulled straight away pending review.</p>'
    : `<p class="lede">Phishing, malware, spam or something illegal behind a wx93 link? Tell us.</p>
${error ? `<p class="error">${e(error)}</p>` : ''}
<form method="post" action="/report" class="card stack">
<label for="r-url">The wx93 link</label><input id="r-url" name="url" required value="${code ? `${e(config.siteUrl)}/${e(code)}` : ''}" placeholder="${e(config.siteUrl)}/abc123">
<label for="r-reason">What is wrong</label><select id="r-reason" name="reason"><option value="phishing">Phishing (steals logins or money)</option><option value="malware">Malware</option><option value="spam">Spam</option><option value="illegal">Illegal content</option><option value="other">Something else</option></select>
<label for="r-details">Details (optional)</label><textarea id="r-details" name="details" rows="3" maxlength="2000"></textarea>
<label for="r-email">Your email (optional, if you want to hear back)</label><input id="r-email" name="email" type="email">
${guardFields}
<button class="btn primary">Send report</button></form>`
}
</section>`,
  });
}

export function Admin({ user, reports, feed }) {
  return layout({
    title: 'Admin',
    noindex: true,
    user,
    body: `<section class="narrow wide"><p class="eyebrow">Admin</p><h1>Reports</h1>
<p class="muted">Threat feeds: ${num(feed.hosts)} hosts, ${num(feed.urls)} URLs, loaded ${e(String(feed.loaded_at ?? 'never'))}.</p>
<table class="tbl">${reports
      .map(
        (r) => `<tr><td class="mono">${e(r.code ?? r.reported)}</td><td class="dest">${e(r.url ?? '')}</td><td>${e(r.reason)} ×${r.reporters}</td><td>${r.disabled_at ? 'disabled' : 'live'}</td>
<td>${r.link_id ? `<form method="post" action="/admin/links/${e(r.link_id)}/${r.disabled_at ? 'enable' : 'disable'}"><button class="btn small">${r.disabled_at ? 'Restore' : 'Disable'}</button></form>` : ''}</td></tr>`,
      )
      .join('')}</table>
<h2>Block a destination</h2>
<form method="post" action="/admin/blocklist" class="row"><input name="domain" placeholder="bad.example" required><input name="reason" placeholder="reason"><button class="btn">Block</button></form></section>`,
  });
}

export function Desktop({ user }) {
  return layout({
    title: 'Desktop app',
    path: '/desktop',
    user,
    body: `<section class="narrow"><p class="eyebrow">Desktop</p><h1>wx93 for macOS, Windows and Linux</h1>
<p class="lede">The desktop app is wx93 in its own window, with a menu command to shorten whatever is on your clipboard. It carries the CLI inside it, so installing it also gives you <code>wx93</code> in the terminal with no Node needed.</p>
<pre class="code copyable">curl -fsSL ${e(config.siteUrl)}/install | sh -s -- --desktop</pre>
<p><a class="btn primary" href="https://github.com/profullstack/wx93.me/releases/latest">Download installers (AppImage, deb, dmg, exe)</a></p>
<p class="muted">Builds are unsigned for now; macOS may ask you to open it from Finder the first time.</p></section>`,
  });
}

export const Offline = () =>
  layout({
    title: 'Offline',
    noindex: true,
    body: '<section class="narrow"><p class="eyebrow">Offline</p><h1>No connection.</h1><p class="lede">wx93 needs the network to shorten and to follow links. Try again when you are back online.</p></section>',
  });
