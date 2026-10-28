import { createHmac } from 'node:crypto';
import { postgresStore, Webhooks } from '@profullstack/webhooks';
import { db } from '@wx93/db';
import { config } from './config.js';

/**
 * Webhooks (Automation): link.created and link.clicked, sent through the house
 * hub, @profullstack/webhooks. Each delivery is a CloudEvents 1.0 JSON body with
 * Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature),
 * queued in Postgres (webhook_endpoints / webhook_deliveries) so a restart loses
 * nothing, and listed in a delivery log.
 *
 * Every delivery also carries the header wx93 has always sent, so receivers
 * built before the hub keep verifying with no change:
 *
 *   x-wx93-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The HMAC key there is the secret string's own UTF-8 bytes, `whsec_` prefix
 * and all. The package's tV1Header() decodes a `whsec_` secret as base64 first
 * (the Standard Webhooks rule), which would NOT match what wx93 receivers
 * check, so the header is built here with the old key rule.
 */

export const EVENTS = ['link.created', 'link.clicked'];

/** The x-wx93-signature value: HMAC keyed with the secret as UTF-8, over `${t}.${body}`. */
export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** The hub's extraHeaders: the legacy wx93 header next to the Standard Webhooks ones. */
export const wx93Signature = ({ body, secret }) => ({ 'x-wx93-signature': sign(secret, body) });

/**
 * Same delivery rhythm as before the hub: three attempts (now, +5 s, +60 s), and an
 * endpoint that fails 50 in a row is switched off. link.clicked fires on every
 * human click, so a dead receiver must not pile up days of retries.
 */
export const BACKOFF_MS = [5_000, 60_000];
export const DISABLE_AFTER = 50;
/** Delivery log kept this long; clicks make a lot of rows. */
export const KEEP_DAYS = 7;

/** postgres.js (tagged templates) as the pg-style `query(text, params)` the store wants. */
export const pgQuery = (sql) => ({ query: async (text, params = []) => ({ rows: await sql.unsafe(text, params) }) });

/**
 * Endpoint lists cached per owner for a minute, as the old sender did: every
 * link.clicked looks them up, and they change rarely. Any endpoint write
 * (create, edit, rotate, a failure count) clears the cache.
 */
export function cachedEndpoints(store, ms = 60_000) {
  const hits = new Map();
  const clear = () => hits.clear();
  return Object.assign(Object.create(null), store, {
    async listEndpoints(owner) {
      const hit = hits.get(owner);
      if (hit && Date.now() - hit.at < ms) return hit.rows.map((e) => ({ ...e, events: [...e.events] }));
      const rows = await store.listEndpoints(owner);
      hits.set(owner, { rows, at: Date.now() });
      return rows.map((e) => ({ ...e, events: [...e.events] }));
    },
    async insertEndpoint(e) {
      clear();
      await store.insertEndpoint(e);
      clear();
    },
    async updateEndpoint(id, patch) {
      clear();
      await store.updateEndpoint(id, patch);
      clear();
    },
    async deleteEndpoint(id) {
      clear();
      await store.deleteEndpoint(id);
      clear();
    },
  });
}

/** The hub with wx93's settings. Tests pass a memoryStore, a fake fetch and a DNS stub. */
export function createHub({ store, ...options }) {
  return new Webhooks({
    store,
    source: config.siteUrl,
    eventTypes: EVENTS,
    maxEndpoints: 10,
    backoffMs: BACKOFF_MS,
    disableAfter: DISABLE_AFTER,
    extraHeaders: wx93Signature,
    log: (m) => console.warn(`[webhooks] ${m}`),
    ...options,
  });
}

let hub = null;

/** The app's hub on the shared Postgres pool, made on first use (unit tests import this without a DB). */
export function hooks() {
  hub ??= createHub({ store: cachedEndpoints(postgresStore(pgQuery(db()))) });
  return hub;
}

/** Start draining due deliveries. Once, at server boot. */
export function startWebhooks() {
  return hooks().start({ keepDays: KEEP_DAYS });
}

/** Fire an event at every endpoint the user has for it. Never throws, never waits. */
export function emit(userId, type, data, { subject } = {}) {
  if (!userId) return;
  const warn = (err) => console.warn(`[webhooks] ${type} for ${userId}: ${err?.message ?? err}`);
  try {
    hooks().emit(String(userId), type, data, subject ? { subject } : {}).catch(warn);
  } catch (err) {
    warn(err);
  }
}
