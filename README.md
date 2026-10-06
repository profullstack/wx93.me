# wx93.me

**Short links for people and agents.** A URL shortener whose links are plain HTTP
redirects, so they work with JavaScript off, in every chat app's preview and in
every terminal. Stats, QR codes, custom aliases, expiry, webhooks and custom
domains, with every surface the fleet ships: web + PWA, REST API, CLI with an
hqtui TUI, MCP server (stdio and hosted), Electron desktop, and `/llms.txt`.

Live at **https://wx93.me**. `9xq.me` is a second short domain on the same
links: every code works on both (`wx93.me/abc123` and `9xq.me/abc123` are one
link with one set of stats), and anything on 9xq.me that is not a short code
301s to wx93.me.

## Pricing

Paid plans are prepaid in crypto through [CoinPay](https://coinpayportal.com)
(USDC on Polygon by default; Solana, Ethereum, BTC and more). Nothing renews by
itself: pay for a month or a year, extend whenever. No card checkout.

| Plan | Price | What you get |
| --- | --- | --- |
| **Free** | $0 | Random short codes, QR codes, expiry, total clicks. People who open a free link see a 5 second ad page first (bots, link previews and scripts get the direct redirect). 100 links/month with an account, 20/hour/address without. |
| **Pro** | **$5/month** or **$50/year** | No ad page. Custom aliases, 301/302/307/308, full stats (daily, referrers, countries, devices, browsers), God Mode API keys. 5,000 links/month. |
| **Automation** | **$29/month** or **$290/year** | Everything in Pro, plus bulk create (1,000 per request), signed webhooks on every create and click, up to 5 custom domains, 100,000 links/month. For agents and businesses on the API, CLI, MCP, PWA and desktop. |
| **x402** (agents, no account) | **$0.25 per pass** | Pay per call over [x402](https://x402.org): a pass lasts 60 minutes and covers 100 links, each ad-free for a year. Past the free allowance the API answers `402` with the offer; or buy one at `/x402`. |

Upgrading Pro to Automation credits unused Pro time.

## Use it

```sh
# no account needed
curl -s https://wx93.me/api/v1/links -H 'content-type: application/json' -d '{"url":"https://example.com/long"}'

# CLI + TUI (installs under ~/.local, never sudo; brings the desktop app on a desktop)
curl -fsSL https://wx93.me/install | sh        # --cli-only | --desktop
wx93 https://example.com/long --alias launch --domain 9xq.me
wx93 login        # OAuth 2.1 + PKCE in the browser (--manual over SSH)
wx93 ls | wx93 stats launch | wx93 qr launch | wx93 tui

# MCP
npx -y @profullstack/wx93-mcp                  # stdio, or: wx93 mcp
curl -s https://wx93.me/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -H 'content-type: application/json'
```

Full API: https://wx93.me/docs · machine summary: https://wx93.me/llms.txt

## How a short link answers

- **Pro / Automation / x402-paid links:** the redirect type the owner chose (302 by
  default). 301/308 are `Cache-Control: public, max-age=3600`; 302/307 are
  `private, no-cache` so every click counts.
- **Free links, a person in a browser:** a server-rendered page with an ad slot, a
  `<meta http-equiv="refresh">` countdown (a CSS bar, no script) and a plain
  Continue link. Ads are pluggable (`AD_PROVIDER=crawlproof|house|none`;
  CrawlProof house ads by default, rendered server-side in a frame).
- **Free links, a crawler, unfurler, curl or script:** the plain 302, `Vary: User-Agent`,
  so previews keep working.
- `wx93.me/<code>+` shows where a link goes without going there.

## Abuse

Every destination is checked when it is shortened: http(s) only, no credentials
in the URL, no private/loopback addresses, no other shorteners (chains hide the
end), not us, the `blocklist` table (suffix match), the URLhaus and OpenPhish
feeds (refreshed every 6 hours and swept over the last 90 days of links), and
Google Safe Browsing when `SAFE_BROWSING_API_KEY` is set. Anonymous links that
look like credential phishing need an account. Rate limits are
`@profullstack/throttle` (with the x402 gateway as the over-limit answer), the
public forms use `@profullstack/form-guard`, and `POST /api/v1/reports` (or
`/report`) pulls a link after 3 independent reports.

## Run it

Bun + Hono, Postgres, no build step.

```sh
docker compose up                      # self-host: database + app on :3000
./bin/install.sh                       # or OpenInstall on a box (systemd + nginx + TLS)
DATABASE_URL=postgres://… bun test     # tests (the DB ones skip without DATABASE_URL)
```

Production runs on dev2 (`/home/anthony/www/wx93.me`, deployed by
`.github/workflows/deploy-dev2.yml` on every merge to `main`). Secrets come from
the logicsrc vault `wx93-me--prod`, never a committed `.env`. Settings:

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres |
| `SITE_URL` | `https://wx93.me` (passkey rpID comes from it) |
| `ALT_HOSTS` | second short domains, default `9xq.me` |
| `RESEND_API_KEY`, `MAIL_FROM` | sign-in mail |
| `COINPAY_API_KEY`, `COINPAY_BUSINESS_ID`, `COINPAY_WEBHOOK_SECRET` | plans |
| `COINPAY_X402_KEY`, `X402_PAY_TO`, `X402_ENABLED=1` | x402 |
| `CRAWLPROOF_SLOT`, `AD_PROVIDER` | interstitial ad |
| `SAFE_BROWSING_API_KEY` | optional extra lookup |
| `ADMIN_EMAILS`, `APP_SECRET` | staff, form-guard/report pepper |

Releases: bump `version` in `packages/cli` and `packages/mcp` together and merge;
`release.yml` publishes both to npm and attaches desktop builds to the GitHub release.

Country lookups by [DB-IP](https://db-ip.com) (CC BY 4.0). MIT licensed.
