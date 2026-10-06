import { close, configured, db, healthcheck } from '@wx93/db';
import { migrate } from '@wx93/db/migrate';
import { configurePayments } from '@wx93/payments';
import { watchDependencies } from '@profullstack/watchdog';
import { isKnownBad, refreshFeeds } from './abuse.js';
import { app } from './app.js';
import { assertCoinpayMerchantKey, config } from './config.js';
import { geoReady } from './geo.js';
import { flushClicks, setDisabled } from './links.js';

// Production never runs without its database: the deploy health check then fails
// loudly instead of serving links that cannot resolve.
if (!configured()) throw new Error('DATABASE_URL is not set (it comes from the vault via deploy-app.sh)');
assertCoinpayMerchantKey();

// Migrations run on every boot, before the server listens, so no deploy skips one.
await migrate();
// The coinpay object goes in whole: its getters read the environment on each access.
configurePayments({ sql: db(), coinpay: config.coinpay, siteUrl: config.siteUrl });

// A wedged pool looks healthy from outside; the watchdog probes the SAME pool the
// requests use and exits after consecutive failures, so Docker restarts us.
const watchdogs = watchDependencies({ postgres: () => healthcheck() });

/*
 * Threat feeds: load now, refresh every few hours, and sweep links made in the
 * last 90 days against them, so a destination that turns bad after it was
 * shortened is pulled too. Never fatal.
 */
async function feeds() {
  if (!config.abuse.feeds) return;
  try {
    const r = await refreshFeeds();
    console.log(`[abuse] feeds: ${r.hosts} hosts, ${r.urls} urls ${JSON.stringify(r.sources)}`);
    const recent = await db()`
      select id, url, host from links where disabled_at is null and created_at > now() - interval '90 days'`;
    let pulled = 0;
    for (const l of recent)
      if (isKnownBad(l.url, l.host)) {
        await setDisabled(l.id, 'destination listed in a malware or phishing feed');
        pulled++;
      }
    if (pulled) console.log(`[abuse] sweep disabled ${pulled} link(s)`);
  } catch (err) {
    console.warn(`[abuse] feeds failed: ${err?.message ?? err}`);
  }
}
void feeds();
const feedTimer = setInterval(feeds, config.abuse.feedRefreshMinutes * 60_000);

// Tidy expired sign-in material. Idempotent and indexed.
async function tidy() {
  try {
    const sql = db();
    await sql`delete from login_tokens where expires_at < now() - interval '1 day'`;
    await sql`delete from sessions where expires_at < now()`;
    await sql`delete from webauthn_challenges where expires_at < now()`;
    await sql`delete from oauth2_codes where expires_at < now() - interval '1 day'`;
  } catch (err) {
    console.warn(`[tidy] ${err?.message ?? err}`);
  }
}
void tidy();
const tidyTimer = setInterval(tidy, 3600_000);

const server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 30 });
console.log(
  `[web] wx93 listening on :${server.port} · site ${config.siteUrl} · mail ${config.mail.enabled ? 'on' : 'off'} · payments ${config.coinpay.enabled ? 'on' : 'off'} · x402 ${config.x402.enabled ? 'on' : 'off'} · geoip ${geoReady() ? 'on' : 'off'} · ads ${config.ads.provider}`,
);

async function shutdown(signal) {
  console.log(`[main] ${signal}, draining`);
  watchdogs.stop(); // first, or a clean drain looks like a wedge
  clearInterval(feedTimer);
  clearInterval(tidyTimer);
  await server.stop();
  await flushClicks().catch(() => {});
  await close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
