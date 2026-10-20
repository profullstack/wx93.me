import { adNetworkMeta, homeAd, renderAd } from './ads.js';
import { siteFooter } from './footer.js';
import { ringFooter } from './ring-footer.js';
import { config, PLANS } from './config.js';
import { DEFAULT_STYLE, DOTS, ECC, EYES, layoutQr, parseStyle, renderSvg } from './qr.js';
import { QR_TYPES } from './qr-types.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Asset URLs carry a content hash so a deploy never pairs new markup with a
// cached (HTTP or service worker) stylesheet.
const assetVersion = (file) =>
  createHash('sha256').update(readFileSync(new URL(`../public/${file}`, import.meta.url))).digest('hex').slice(0, 10);
const CSS_V = assetVersion('app.css');
const JS_V = assetVersion('app.js');

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

/**
 * CrawlProof stats, on the regular site pages only. A bare page (the free link's
 * interstitial) ships no JavaScript at all, so it never gets this tag.
 */
export const CRAWLPROOF_TAG =
  '<script data-site="1db8465f-dde9-47b1-b898-942367b075ad" src="https://crawlproof.com/stats.js" async></script>';

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
<link rel="stylesheet" href="/assets/app.css?v=${CSS_V}">
${head}
${bare ? '' : CRAWLPROOF_TAG}
</head>
<body>
${bare ? '' : nav(user)}
<main>
${body}
</main>
${bare ? '' : footer()}
${bare ? '' : '<script src="/assets/app.js?v=${JS_V}" defer></script>'}
</body>
</html>`;
}

function nav(user) {
  return `<header class="nav"><a class="brand" href="/" aria-label="wx93 home"><img src="/logo.svg" alt="" width="28" height="28"><span>wx93</span></a>
<nav><a href="/qr">QR codes</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/docs#cli">CLI</a>${
    user ? `<a class="btn small" href="/account">Account</a>` : `<a href="/signin">Sign in</a><a class="btn small primary" href="/signup">Sign up</a>`
  }</nav></header>`;
}

function footer() {
  return `<footer class="foot">
<p><a class="brand" href="/"><img src="/logo.svg" alt="" width="18" height="18"><span>wx93</span></a></p>
<nav><a href="/qr">QR code generator</a><a href="/pricing">Pricing</a><a href="/docs">Docs and API</a><a href="/llms.txt">llms.txt</a><a href="/report">Report a link</a><a href="/docs#abuse">Abuse</a><a href="/docs#privacy">Privacy</a><a href="https://github.com/profullstack/wx93.me">Source</a></nav>
<p class="tiny muted">Country and city lookups by <a href="https://db-ip.com">DB-IP</a> (CC BY 4.0).</p>
</footer>
${ringFooter()}
${siteFooter()}`;
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
    head: adNetworkMeta(),
    body: `<section class="hero">
<p class="eyebrow">Short links · no JavaScript required</p>
<h1>Shorten it. <span class="accent">Share it.</span> See who clicked.</h1>
<p class="lede">wx93.me turns long URLs into short ones that open with a plain HTTP redirect, so they work in every browser, every chat app and every terminal. Stats, QR codes, custom aliases, expiry, and an API, CLI and MCP server for your agents.</p>
${shortenForm({ guardFields, user, plan, value })}
</section>
${homeAd()}
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
<div class="qr"><img src="${e(link.qr_svg)}" alt="QR code for ${e(short)}" width="220" height="220"><div class="stack">${qrDownloads(link)}${user ? '<a class="tiny" href="/account/qr">Colours, a logo and scan stats: save it as a QR code</a>' : ''}</div></div>
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
  'Total clicks, QR scans and unique visitors',
  `${num(PLANS.free.qrCodes)} saved QR codes: colours, dot and eye shapes, logos, PNG, SVG and PDF`,
  'CLI, TUI and MCP for creating links',
])}
${card('pro', 'Clean links and real numbers, for a person or a small team.', [
  'No ad page: every click goes straight through',
  'Custom aliases (wx93.me/your-name) and 301, 302, 307 or 308',
  'Full stats: daily, referrers, countries, cities, devices, OS, browsers',
  'QR scan analytics: weekday-by-hour heatmap, week over week, live scans',
  `${num(PLANS.pro.qrCodes)} saved QR codes`,
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

<h2 id="qr">QR codes</h2>
<p>Every link has a QR code at <code>/qr/{code}.svg</code>, <code>.png</code> or <code>.pdf</code> (<code>?size=</code> in pixels, points for PDF; <code>?download</code> for an attachment). It encodes the short link with <code>?qr</code> on the end, so a scan is counted apart from a click. Make one-off codes with no account at <a href="/qr">/qr</a>.</p>
<p>Saved codes live on your account (${num(PLANS.free.qrCodes)} on Free, ${num(PLANS.pro.qrCodes)} on Pro). <b>Dynamic</b> types (<code>url</code>, <code>vcard</code>, <code>event</code>, <code>links</code>) are short links underneath: they count scans and can change after printing; contact cards, events and link lists get a hosted page. <b>Static</b> types (<code>text</code>, <code>wifi</code>, <code>email</code>, <code>phone</code>, <code>sms</code>, <code>whatsapp</code>, <code>geo</code>, <code>crypto</code>) put the content in the code itself.</p>
<pre class="code">curl -s ${e(s)}/api/v1/qr -H 'authorization: Bearer wx93_live_…' -H 'content-type: application/json' \\
  -d '{"type":"url","data":{"url":"https://example.com/menu"},"name":"Table menu",
       "style":{"fg":"#1d4ed8","dots":"dots","eye_frame":"circle","eye_ball":"circle"}}'
curl -s -X PUT ${e(s)}/api/v1/qr/{id}/logo -H 'authorization: Bearer …' -H 'content-type: image/png' --data-binary @logo.png
curl -s ${e(s)}/api/v1/qr/{id}/image.pdf -H 'authorization: Bearer …' -o menu.pdf</pre>
<table class="tbl">
<tr><td><code>GET /api/v1/qr/types</code></td><td>every type's fields, and the style options</td></tr>
<tr><td><code>POST /api/v1/qr</code></td><td><code>{type, data: {…}, name?, style?, domain?, alias?}</code> → 201 code</td></tr>
<tr><td><code>GET /api/v1/qr</code></td><td>your codes; <code>?q=&amp;limit=</code></td></tr>
<tr><td><code>GET|PATCH|DELETE /api/v1/qr/{id}</code></td><td><code>{name?, data?, style?}</code>; deleting a dynamic code deletes its short link</td></tr>
<tr><td><code>PUT|DELETE /api/v1/qr/{id}/logo</code></td><td>PNG or JPEG body (or multipart <code>logo</code>), up to 256 KB</td></tr>
<tr><td><code>GET /api/v1/qr/{id}/image.svg|png|pdf</code></td><td>the code in its design; <code>?size=</code></td></tr>
<tr><td><code>GET /api/v1/qr/{id}/stats</code></td><td><code>?days=30&amp;tz=Europe/Berlin&amp;source=qr|link</code></td></tr>
<tr><td><code>GET|POST /qr/make.svg|png|pdf</code></td><td>a one-off static code, no account: <code>?type=wifi&amp;ssid=…&amp;password=…&amp;fg=…</code></td></tr>
</table>
<p>Style: <code>fg</code>, <code>bg</code>, <code>eye</code> (hex colours), <code>transparent</code>, <code>dots</code> (square, rounded, dots), <code>eye_frame</code> and <code>eye_ball</code> (square, rounded, circle), <code>ecc</code> (L, M, Q, H), <code>margin</code> (0 to 10). Colours with too little contrast to scan are refused.</p>
<p>Stats, for links and dynamic codes alike: people, QR scans, unique visitors (per day), bots; on Pro and up, daily series, countries, cities, devices, operating systems, browsers, referrers, a weekday-by-hour heatmap in your time zone, this week against last, the last hour and the latest twenty visits.</p>

<h2 id="cli">CLI and TUI</h2>
<pre class="code copyable">curl -fsSL ${e(s)}/install | sh</pre>
<p>Installs <code>wx93</code> under <code>~/.local</code> without sudo; adds the desktop app when there is a desktop session (<code>--desktop</code> / <code>--cli-only</code> to choose). Or <code>npm i -g @profullstack/wx93</code>.</p>
<pre class="code">wx93 https://example.com/long --alias launch --expires 30d
wx93 login              # OAuth 2.1 in your browser (--manual over SSH)
wx93 ls                 # your links
wx93 stats launch       # referrers, countries, devices
wx93 qr launch          # a QR code in the terminal
wx93 qr new wifi ssid=Cafe password=latte --png wifi.png
wx93 qr new url url=https://example.com/menu --name Menu --dots dots --fg '#1d4ed8'
wx93 qr ls | qr stats ID | qr get ID --pdf menu.pdf | qr rm ID
wx93 bulk urls.txt      # one URL per line (Automation)
wx93 tui                # all of it, as a screen
wx93 mcp                # stdio MCP server
wx93 upgrade | uninstall</pre>

<h2 id="mcp">MCP server</h2>
<p>Stdio: <code>npx -y @profullstack/wx93-mcp</code> (or <code>wx93 mcp</code>). It uses your <code>wx93 login</code> sign-in or <code>WX93_API_KEY</code>. Hosted: <code>POST ${e(s)}/mcp</code> (JSON-RPC 2.0, streamable HTTP, Bearer key optional). Tools: <code>shorten_url</code>, <code>bulk_shorten</code>, <code>list_links</code>, <code>get_link</code>, <code>link_stats</code>, <code>update_link</code>, <code>delete_link</code>, <code>expand_link</code>, <code>whoami</code>, <code>create_qr_code</code>, <code>list_qr_codes</code>, <code>update_qr_code</code>, <code>delete_qr_code</code>, <code>qr_code_stats</code>.</p>

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
<p>A click or scan records the time, the referring site's hostname, a country code and city, the device, browser and OS family, whether it came from a QR code, and a visitor key: a hash of the address and browser with a server secret and the day, so unique visitors can be counted without storing who they are or following anyone from one day to the next. The IP address itself is never stored.</p>
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

<h2 id="qr">QR codes</h2>
<p><a class="btn" href="/account/qr">Your QR codes</a> <span class="muted">dynamic codes with colours, logos and scan stats; ${num(plan.qrCodes)} on ${e(plan.name)}</span></p>

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

/** PNG, SVG and PDF of a link's QR code. */
const qrDownloads = (link) =>
  `<div class="row"><a class="btn small" href="${e(link.qr_png)}${link.qr_png.includes('?') ? '&' : '?'}download">QR (PNG)</a><a class="btn small" href="${e(link.qr_svg)}" download="${e(link.code)}.svg">SVG</a><a class="btn small" href="${e(link.qr_pdf)}">PDF</a></div>`;

export function LinkStatsPage({ user, link, stats, full, query = {} }) {
  return layout({
    title: `Stats for ${link.code}`,
    noindex: true,
    user,
    body: `<section class="narrow wide">
<p class="eyebrow">Link</p>
<h1 class="shorturl"><a href="${e(link.short_url)}">${e(link.short_url.replace(/^https?:\/\//, ''))}</a></h1>
<p class="muted">→ <span class="dest">${e(link.url)}</span> · created ${day(link.created_at)}${link.expires_at ? ` · expires ${day(link.expires_at)}` : ''}</p>
<div class="qr"><img src="${e(link.qr_svg)}" alt="QR code" width="120" height="120">${qrDownloads(link)}</div>
${analytics(stats, { full, query })}
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
/* ------------------------------------------------------------- analytics -- */

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function heatmapTable(heatmap) {
  const peak = Math.max(1, ...heatmap.flat());
  const head = `<tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h % 3 ? '' : h}</th>`).join('')}</tr>`;
  const rows = heatmap
    .map(
      (row, d) =>
        `<tr><th>${DOW[d]}</th>${row
          .map((n, h) => `<td title="${DOW[d]} ${String(h).padStart(2, '0')}:00 · ${n}" style="background:rgba(198,255,61,${n ? (0.15 + (0.85 * n) / peak).toFixed(2) : 0})"></td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<table class="heat" aria-label="Visits by weekday and hour">${head}${rows}</table>`;
}

const change = (pct) => (pct === null ? 'new this week' : `${pct > 0 ? '+' : ''}${pct}% on the week before`);

/**
 * The numbers for one link or one dynamic QR code. `full` is the Pro view; the
 * filter form re-reads the page with ?days, ?tz and ?source.
 */
export function analytics(stats, { full, query = {}, scansLabel = 'People' } = {}) {
  const totals = `<div class="grid4">
<div class="card"><h3>${e(scansLabel)}</h3><p class="price small">${num(stats.humans)}</p><p class="muted">last ${stats.days} days${stats.source ? `, ${stats.source === 'qr' ? 'scans' : 'clicks'} only` : ''}</p></div>
<div class="card"><h3>QR scans</h3><p class="price small">${num(stats.scans)}</p><p class="muted">opened from a wx93 QR code</p></div>
<div class="card"><h3>Unique visitors</h3><p class="price small">${num(stats.visitors)}</p><p class="muted">${stats.unique_rate}% of visits, counted per day</p></div>
<div class="card"><h3>Bots and previews</h3><p class="price small">${num(stats.bots)}</p></div>
</div>`;
  if (!full) return `${totals}<p class="hint">Cities, devices, the weekday-by-hour heatmap, live scans and week-over-week come with <a href="/pricing">Pro</a>.</p>`;
  const peak = Math.max(1, ...(stats.daily ?? []).map((d) => d.humans));
  const filter = `<form method="get" class="row filters"><label>Days <select name="days">${[7, 30, 90, 365].map((d) => `<option${Number(query.days || stats.days) === d ? ' selected' : ''}>${d}</option>`).join('')}</select></label>
<label>Show <select name="source"><option value="">everything</option><option value="qr"${query.source === 'qr' ? ' selected' : ''}>QR scans</option><option value="link"${query.source === 'link' ? ' selected' : ''}>link clicks</option></select></label>
<label>Time zone <input name="tz" value="${e(query.tz || stats.tz)}" placeholder="America/New_York" size="18"></label><button class="btn small">Apply</button></form>`;
  const recent = stats.live.recent.length
    ? `<div class="scrollx"><table class="tbl"><tr><th>When (UTC)</th><th>How</th><th>Where</th><th>Device</th><th>From</th></tr>${stats.live.recent
        .map(
          (r) =>
            `<tr><td class="mono">${e(new Date(r.at).toISOString().slice(0, 16).replace('T', ' '))}</td><td>${r.source === 'qr' ? 'scan' : 'click'}</td><td>${e([r.city, r.country].filter(Boolean).join(', '))}</td><td>${e([r.device, r.os, r.browser].filter(Boolean).join(' · '))}</td><td>${e(r.referrer_host ?? 'direct')}</td></tr>`,
        )
        .join('')}</table></div>`
    : '<p class="muted">Nobody yet.</p>';
  return `${filter}${totals}
<div class="grid3">
<div class="card"><h3>This week</h3><p class="price small">${num(stats.week.this_week)}</p><p class="muted">${change(stats.week.change_pct)} (${num(stats.week.last_week)})</p></div>
<div class="card"><h3>Last hour</h3><p class="price small">${num(stats.live.last_hour)}</p><p class="muted">live: reload to refresh</p></div>
<div class="card"><h3>How they came</h3>${bars(stats.sources.map((s) => ({ ...s, key: s.key === 'qr' ? 'QR scan' : 'link click' })), stats.humans)}</div>
</div>
<h2>Daily</h2><div class="spark">${(stats.daily ?? []).map((d) => `<span title="${e(d.day)}: ${d.humans} (${d.scans} scans)" style="height:${Math.max(2, Math.round((100 * d.humans) / peak))}%"></span>`).join('') || '<p class="muted">No visits yet.</p>'}</div>
<h2>When (${e(stats.tz)})</h2>${heatmapTable(stats.heatmap)}
<div class="grid2"><div><h2>Countries</h2>${bars(stats.countries, stats.humans)}</div><div><h2>Cities</h2>${bars(stats.cities, stats.humans)}</div>
<div><h2>Devices</h2>${bars(stats.devices, stats.humans)}</div><div><h2>Operating systems</h2>${bars(stats.os, stats.humans)}</div>
<div><h2>Browsers</h2>${bars(stats.browsers, stats.humans)}</div><div><h2>Referrers</h2>${bars(stats.referrers, stats.humans)}</div></div>
<h2>Latest</h2>${recent}`;
}

/* ---------------------------------------------------------------- QR codes -- */

const STYLE_FIELDS = ['fg', 'bg', 'eye', 'transparent', 'dots', 'eye_frame', 'eye_ball', 'ecc', 'margin'];

function fieldInput(type, [name, label, kind, required], values = {}) {
  const v = values[name] ?? '';
  const id = `f-${type}-${name}`;
  const req = required ? ' required' : '';
  if (kind === 'check') return `<label class="check"><input type="checkbox" name="${name}" value="1"${v === true || v === '1' || v === 'on' ? ' checked' : ''}> ${e(label)}</label>`;
  if (Array.isArray(kind))
    return `<label for="${id}">${e(label)}</label><select id="${id}" name="${name}"${req}>${kind.map((o) => `<option${String(v) === o ? ' selected' : ''}>${e(o)}</option>`).join('')}</select>`;
  if (kind === 'long') return `<label for="${id}">${e(label)}</label><textarea id="${id}" name="${name}" rows="${name === 'links' ? 6 : 3}" maxlength="2000"${req}${name === 'links' ? ' placeholder="Website | https://example.com&#10;Shop | https://shop.example.com"' : ''}>${e(v)}</textarea>`;
  const html = { url: 'url', email: 'email', tel: 'tel', number: 'text', datetime: 'datetime-local', tz: 'text', text: 'text' }[kind] ?? 'text';
  return `<label for="${id}">${e(label)}${required ? '' : ' <span class="muted">(optional)</span>'}</label><input id="${id}" name="${name}" type="${html}" value="${e(v)}"${req}${kind === 'number' ? ' inputmode="decimal"' : ''} autocomplete="off">`;
}

const qrFields = (type, values) => QR_TYPES[type].fields.map((f) => fieldInput(type, f, values)).join('\n');

function styleFields(style = {}) {
  const s = { ...DEFAULT_STYLE, ...style };
  const sel = (name, list) => `<select name="${name}">${list.map((o) => `<option${s[name] === o ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
  return `<div class="row">
<label>Colour <input type="color" name="fg" value="${e(s.fg)}"></label>
<label>Background <input type="color" name="bg" value="${e(s.bg)}"></label>
<label>Eyes <input type="color" name="eye" value="${e(s.eye ?? s.fg)}"></label>
<label class="check"><input type="checkbox" name="transparent" value="1"${s.transparent ? ' checked' : ''}> transparent</label>
</div><div class="row">
<label>Dots ${sel('dots', DOTS)}</label><label>Eye frame ${sel('eye_frame', EYES)}</label><label>Eye centre ${sel('eye_ball', EYES)}</label>
<label>Error correction ${sel('ecc', ECC)}</label><label>Margin <input name="margin" type="number" min="0" max="10" value="${e(s.margin)}" style="width:5em"></label>
</div>`;
}

function typeTabs(base, current, { only } = {}) {
  const group = (dynamic) =>
    Object.entries(QR_TYPES)
      .filter(([, t]) => t.dynamic === dynamic && (!only || only(t)))
      .map(([k, t]) => `<a class="tab${k === current ? ' on' : ''}" href="${base}?type=${k}">${e(t.label)}</a>`)
      .join(' ');
  const dyn = group(true);
  const stat = group(false);
  return `<nav class="tabs" aria-label="Kind of code">${dyn ? `<div class="tabrow"><span class="tabgroup">Dynamic</span> ${dyn}</div>` : ''}${stat ? `<div class="tabrow"><span class="tabgroup">Static</span> ${stat}</div>` : ''}</nav>`;
}

/** Hidden copies of a one-off code's fields, so a download button re-sends exactly what was previewed. */
function hiddenValues(type, values) {
  const keys = ['type', ...QR_TYPES[type].fields.map((f) => f[0]), ...STYLE_FIELDS];
  return keys
    .filter((k) => values[k] !== undefined && values[k] !== '')
    .map((k) => `<input type="hidden" name="${k}" value="${e(values[k])}">`)
    .join('');
}

export function QrGenerator({ user, type, values = {}, preview, error }) {
  const t = QR_TYPES[type];
  const downloads = preview
    ? `<div class="row">${['png', 'svg', 'pdf']
        .map((f) => `<form method="post" action="/qr/make.${f}?download">${hiddenValues(type, { ...values, type })}<button class="btn small${f === 'png' ? ' primary' : ''}">Download ${f.toUpperCase()}</button></form>`)
        .join('')}</div>`
    : '';
  return layout({
    title: 'QR code generator',
    path: '/qr',
    description: 'Free QR code generator: websites, Wi-Fi, contact cards, events, SMS, WhatsApp, email, locations and crypto. Colours, dot and eye styles, PNG, SVG and PDF. Dynamic codes count every scan.',
    user,
    body: `<section class="narrow wide"><p class="eyebrow">QR codes</p>
<h1>Make a QR code. <span class="accent">Count every scan.</span></h1>
<p class="lede">Twelve kinds of code, your colours and shapes, PNG, SVG or print-ready PDF. Nothing to sign up for here. <a href="${user ? '/account/qr' : '/signup?next=/account/qr'}">Save it to an account</a> to get a <b>dynamic</b> code: change where it goes after it is printed, add a logo, and see scans by day, hour, country, city and device.</p>
${typeTabs('/qr', type)}
<div class="qrmake">
<form method="post" action="/qr" class="card stack">
<input type="hidden" name="type" value="${e(type)}">
<p class="hint">${e(t.hint)}${t.dynamic ? ' Made here, it holds the content itself; save it to an account to make it dynamic and counted.' : ''}</p>
${qrFields(type, values)}
<details class="more"${values.fg ? ' open' : ''}><summary>Colours and shapes</summary>${styleFields(values.fg ? parseStyleSafe(values) : {})}</details>
<button class="btn primary">Make QR code</button>
${error ? `<p class="error">${e(error)}</p>` : ''}
</form>
<div class="card qrpreview">${preview ? `<div class="qrimg">${preview.replace(/^<\?xml[^>]*>\s*/, '')}</div>${downloads}<p class="muted tiny">Test it with your phone's camera before you print a thousand.</p>` : '<p class="muted">Your code appears here.</p>'}</div>
</div>
</section>`,
  });
}

function parseStyleSafe(values) {
  try {
    return parseStyle(values);
  } catch {
    return {};
  }
}

/**
 * A list thumbnail. A dynamic code's comes from its public, cached /qr/<code>.svg;
 * a static one is drawn inline (no logo), so a long list costs no API calls.
 */
function thumb(qr, size = 48) {
  if (qr.link) return `<img class="qrthumb" src="${e(qr.link.qr_svg)}${qr.link.qr_svg.includes('?') ? '&' : '?'}size=${size}" alt="" width="${size}" height="${size}" loading="lazy">`;
  try {
    return `<span class="qrthumb">${renderSvg(layoutQr(qr.encodes, qr.style), { size: Math.max(size, 64) }).replace(/^<\?xml[^>]*>\s*/, '').replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</span>`;
  } catch {
    return '';
  }
}

export function QrList({ user, plan, codes, type = 'url', domains = [], values = {}, flash }) {
  const t = QR_TYPES[type];
  const rows = codes
    .map(
      (q) => `<tr><td><a href="/account/qr/${e(q.id)}">${thumb(q, 48)}</a></td><td><a href="/account/qr/${e(q.id)}">${e(q.name)}</a><br><span class="muted tiny">${e(QR_TYPES[q.type]?.label ?? q.type)}${q.dynamic ? ' · dynamic' : ' · static'}${q.logo ? ' · logo' : ''}</span></td>
<td class="dest">${e(q.short_url ?? q.summary)}</td><td class="num">${q.dynamic ? num(q.scans) : '–'}</td></tr>`,
    )
    .join('');
  return layout({
    title: 'QR codes',
    noindex: true,
    user,
    body: `<section class="narrow wide">
<p class="eyebrow">Account</p><h1>QR codes</h1>
<p class="muted">${num(codes.length)} of ${num(plan.qrCodes)} on ${e(plan.name)}. Dynamic codes are short links underneath: they count scans and you can change them after printing.${plan.interstitial ? ' On Free, people who scan one see the short ad page first; <a href="/pricing">Pro</a> codes go straight through.' : ''}</p>
${flash ? `<p class="hint error">${flash}</p>` : ''}
<h2>New code</h2>
${typeTabs('/account/qr', type)}
<form method="post" action="/account/qr" class="card stack">
<input type="hidden" name="type" value="${e(type)}">
<p class="hint">${e(t.hint)}</p>
<label for="qr-name">Name <span class="muted">(for your list)</span></label><input id="qr-name" name="name" maxlength="120" value="${e(values.name ?? '')}">
${qrFields(type, values)}
${
  t.dynamic
    ? `<div class="row"><label>Domain <select name="domain">${[...config.shortHosts, ...domains].map((h) => `<option${values.domain === h ? ' selected' : ''}>${e(h)}</option>`).join('')}</select></label>${plan.aliases ? `<label>Alias <input name="alias" placeholder="optional" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,63}" value="${e(values.alias ?? '')}"></label>` : ''}</div>`
    : ''
}
<details class="more"><summary>Colours and shapes (you can change these later, and add a logo)</summary>${styleFields(values.fg ? parseStyleSafe(values) : {})}</details>
<button class="btn primary">Create QR code</button>
</form>
<h2>Your codes</h2>
${codes.length ? `<table class="tbl links"><tr><th></th><th>Name</th><th>Encodes</th><th>Scans</th></tr>${rows}</table>` : '<p class="muted">None yet.</p>'}
</section>`,
  });
}

export function QrDetail({ user, plan, qr, stats, query = {}, flash }) {
  const t = QR_TYPES[qr.type];
  const dl = (f, label, extra = '') => `<a class="btn small${f === 'png' ? ' primary' : ''}" href="${e(qr.image[f])}?download${extra}">${label}</a>`;
  return layout({
    title: qr.name,
    noindex: true,
    user,
    body: `<section class="narrow wide">
<p class="eyebrow"><a href="/account/qr">QR codes</a> · ${e(t?.label ?? qr.type)} · ${qr.dynamic ? 'dynamic' : 'static'}</p>
<h1>${e(qr.name)}</h1>
${flash ? `<p class="hint error">${flash}</p>` : ''}
<div class="qrmake">
<div class="card qrpreview"><div class="qrimg"><img src="${e(qr.image.svg)}?v=${e(new Date(qr.updated_at).getTime())}" alt="The QR code" width="260" height="260"></div>
<div class="row">${dl('png', 'PNG')}${dl('png', 'PNG 2048', '&size=2048')}${dl('svg', 'SVG')}${dl('pdf', 'PDF (print)')}</div></div>
<div class="card stack">
${qr.short_url ? `<p>Scans go through <a class="mono" href="${e(qr.short_url)}+">${e(qr.short_url.replace(/^https?:\/\//, ''))}</a>${qr.landing_url ? `, which opens <a href="${e(qr.landing_url)}">its page</a>` : ` to <span class="dest">${e(qr.data.url)}</span>`}.</p>` : `<p class="muted">Static: the phone reads this code itself, so it cannot be counted or changed after printing.</p>`}
<p class="muted tiny">Encodes <code>${e(qr.encodes.length > 160 ? `${qr.encodes.slice(0, 160)}…` : qr.encodes)}</code></p>
${qr.dynamic ? `<p class="price small">${num(qr.scans)} <small>people all time</small></p>` : ''}
</div>
</div>

<h2 id="content">Content</h2>
<form method="post" action="/account/qr/${e(qr.id)}/content" class="card stack">
<label for="qr-name">Name</label><input id="qr-name" name="name" maxlength="120" value="${e(qr.name)}">
${qrFields(qr.type, qr.data)}
<button class="btn primary">Save</button>${qr.dynamic ? '<p class="hint">The printed code keeps working: it points at the same short link.</p>' : '<p class="hint">Changing a static code changes the picture: print the new one.</p>'}
</form>

<h2 id="design">Design</h2>
<form method="post" action="/account/qr/${e(qr.id)}/style" class="card stack">${styleFields(qr.style)}<button class="btn primary">Save design</button></form>
<div class="card stack"><h3>Logo</h3>
<form method="post" action="/account/qr/${e(qr.id)}/logo" enctype="multipart/form-data" class="row"><input type="file" name="logo" accept="image/png,image/jpeg" required><button class="btn">Upload</button></form>
${qr.logo ? `<form method="post" action="/account/qr/${e(qr.id)}/unlogo"><button class="btn small">Remove the logo</button></form>` : ''}
<p class="hint">PNG or JPEG, up to 256 KB, placed in the middle. A logo switches the code to the highest error correction so it still scans.</p></div>

${qr.dynamic ? `<h2 id="stats">Scans</h2>${stats ? analytics(stats, { full: plan.stats, query, scansLabel: 'People' }) : ''}` : ''}
<form method="post" action="/account/qr/${e(qr.id)}/delete" class="row"><button class="btn small danger">Delete this code${qr.dynamic ? ' and its short link' : ''}</button></form>
</section>`,
  });
}

/* ------------------------------------------- the pages behind dynamic codes -- */

const when = (v, tz) => `${String(v).slice(0, 16).replace('T', ' ')} ${tz ? `(${tz})` : /(Z|[+-]\d{2}:?\d{2})$/.test(String(v)) ? '' : 'UTC'}`;

export function HostedPage({ row, links = [] }) {
  const d = row.data;
  let title;
  let body;
  if (row.type === 'vcard') {
    title = [d.first, d.last].filter(Boolean).join(' ');
    body = `<h1>${e(title)}</h1>
${d.title || d.org ? `<p class="lede">${e([d.title, d.org].filter(Boolean).join(', '))}</p>` : ''}
<div class="stack hosted-links">
<a class="btn primary big" href="/p/${e(row.id)}.vcf">Save contact</a>
${d.phone ? `<a class="btn" href="tel:${e(d.phone.replace(/[^\d+]/g, ''))}">Call ${e(d.phone)}</a>` : ''}
${d.email ? `<a class="btn" href="mailto:${e(d.email)}">${e(d.email)}</a>` : ''}
${d.url ? `<a class="btn" href="${e(d.url)}" rel="nofollow noopener">${e(host(d.url))}</a>` : ''}
</div>
${d.address ? `<p class="muted">${e(d.address)}</p>` : ''}${d.note ? `<p>${e(d.note)}</p>` : ''}`;
  } else if (row.type === 'event') {
    title = d.title;
    body = `<p class="eyebrow">Event</p><h1>${e(d.title)}</h1>
<p class="lede">${e(when(d.start, d.tz))}${d.end ? ` to ${e(when(d.end, d.tz))}` : ''}</p>
${d.location ? `<p>${e(d.location)}</p>` : ''}${d.description ? `<p class="muted">${e(d.description)}</p>` : ''}
<div class="stack hosted-links"><a class="btn primary big" href="/p/${e(row.id)}.ics">Add to calendar</a>${d.url ? `<a class="btn" href="${e(d.url)}" rel="nofollow noopener">More about it</a>` : ''}</div>`;
  } else {
    title = d.title;
    body = `<h1>${e(d.title)}</h1>${d.description ? `<p class="lede">${e(d.description)}</p>` : ''}
<div class="stack hosted-links">${links.map((l) => `<a class="btn big" href="${e(l.url)}" rel="nofollow noopener">${e(l.label)}</a>`).join('')}</div>`;
  }
  return layout({
    title,
    noindex: true,
    bare: true,
    body: `<section class="narrow hosted">${body}
<p class="tiny muted made">Made with <a href="${e(config.siteUrl)}/qr">wx93 QR codes</a> · <a href="/report">Report</a></p></section>`,
  });
}
