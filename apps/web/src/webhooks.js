import { createHmac, randomBytes } from 'node:crypto';
import { db } from '@wx93/db';

/**
 * Webhooks (Automation): signed JSON POSTs for link.created and link.clicked.
 *
 * Signature: `x-wx93-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`,
 * the same shape CoinPay and Stripe use, so existing verifiers drop in. Delivery
 * is in-process and best effort: three attempts with backoff, and a hook that
 * fails 50 times in a row is switched off rather than retried forever.
 */

export const EVENTS = ['link.created', 'link.clicked'];
const MAX_FAILURES = 50;

export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export function newSecret() {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

const hooksCache = new Map();
const HOOK_CACHE_MS = 60_000;
export const forgetHooks = (userId) => hooksCache.delete(userId);

async function hooksFor(userId) {
  const hit = hooksCache.get(userId);
  if (hit && Date.now() - hit.at < HOOK_CACHE_MS) return hit.rows;
  const rows = await db()`select id, url, secret, events from webhooks where user_id = ${userId} and disabled_at is null`;
  hooksCache.set(userId, { rows, at: Date.now() });
  return rows;
}

const queue = [];
let running = 0;
const CONCURRENCY = 4;

/** Fire an event at every hook the user has for it. Never throws, never waits. */
export function emit(userId, type, data) {
  void (async () => {
    try {
      for (const hook of await hooksFor(userId)) {
        if (!hook.events.includes(type)) continue;
        queue.push({ hook, body: JSON.stringify({ id: `evt_${randomBytes(9).toString('base64url')}`, type, created_at: new Date().toISOString(), data }), attempt: 0 });
      }
      pump();
    } catch (err) {
      console.warn(`[webhooks] ${type} for ${userId}: ${err?.message ?? err}`);
    }
  })();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    deliver(job).finally(() => {
      running--;
      pump();
    });
  }
}

/** One delivery attempt. Exported so the "send a test" endpoint can await it. */
export async function deliver(job, { fetchImpl = fetch } = {}) {
  const { hook, body } = job;
  let status = 0;
  let error = null;
  try {
    const res = await fetchImpl(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'wx93-webhooks/1', 'x-wx93-signature': sign(hook.secret, body) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 200);
  }
  try {
    await db()`
      update webhooks set last_status = ${status || null}, last_error = ${error}, last_delivery_at = now(),
        failures = case when ${error === null} then 0 else failures + 1 end,
        disabled_at = case when ${error !== null} and failures + 1 >= ${MAX_FAILURES} then now() else disabled_at end
      where id = ${hook.id}`;
  } catch {}
  if (error && job.attempt < 2) {
    const wait = [5_000, 60_000][job.attempt];
    setTimeout(() => {
      queue.push({ ...job, attempt: job.attempt + 1 });
      pump();
    }, wait).unref?.();
  }
  return { status, error };
}
