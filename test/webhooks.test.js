import { describe, expect, test } from 'bun:test';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

// The package is a dependency of apps/web, so resolve it from there (not from the repo root).
const { memoryStore, tV1Header, verifySignature } = await import(Bun.resolveSync('@profullstack/webhooks', join(import.meta.dir, '../apps/web/src')));

process.env.SITE_URL = 'https://wx93.me';
const { createHub, cachedEndpoints, pgQuery, BACKOFF_MS, DISABLE_AFTER } = await import('../apps/web/src/webhooks.js');

/** The receiver wx93 documented before the hub, verbatim: HMAC keyed with the secret string, over `${t}.${body}`. */
function oldReceiverVerifies(secret, header, body) {
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')));
  const want = createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex');
  return Boolean(parts.v1) && want.length === parts.v1.length && timingSafeEqual(Buffer.from(want), Buffer.from(parts.v1));
}

/** A hub on memory, a DNS stub that says "public", and a receiver that records what it got. */
function rig({ status = 204 } = {}) {
  const got = [];
  const store = memoryStore();
  const hub = createHub({
    store,
    guard: { lookup: async () => ['93.184.216.34'] },
    fetchImpl: async (url, init) => {
      got.push({ url: String(url), headers: new Headers(init.headers), body: init.body });
      return new Response(null, { status });
    },
  });
  return { hub, store, got };
}

/** An endpoint exactly as migration 0005 copies one across: the uuid id, the old whsec_ secret, its events. */
async function migratedEndpoint(store, { owner = 'user-1', events = ['link.created', 'link.clicked'] } = {}) {
  const secret = `whsec_${randomBytes(24).toString('base64url')}`; // what the old newSecret() made
  const at = Date.now();
  const id = crypto.randomUUID();
  await store.insertEndpoint({ id, owner, url: 'https://receiver.example/hooks/wx93', secret, events, description: '', enabled: true, failures: 0, disabledReason: null, createdAt: at, updatedAt: at });
  return { id, secret };
}

describe('webhooks on @profullstack/webhooks', () => {
  test('an endpoint migrated from the old table still verifies with the old x-wx93-signature receiver', async () => {
    const { hub, store, got } = rig();
    const { secret } = await migratedEndpoint(store);
    const r = await hub.emit('user-1', 'link.clicked', { link: { code: 'abc123' } }, { subject: 'link:abc123' });
    expect(r.queued).toBe(1);
    expect(await hub.drain()).toBe(1);
    expect(got).toHaveLength(1);
    const { headers, body } = got[0];
    expect(oldReceiverVerifies(secret, headers.get('x-wx93-signature'), body)).toBe(true);
    // And the Standard Webhooks headers verify with the same secret.
    expect(verifySignature({ headers, body, secret }).ok).toBe(true);
    const event = JSON.parse(body);
    expect(event.type).toBe('link.clicked');
    expect(event.source).toBe('https://wx93.me');
    expect(event.subject).toBe('link:abc123');
    expect(event.data.link.code).toBe('abc123');
    // Why the app builds the header itself: the package's tV1Header decodes a whsec_
    // secret as base64, which an old receiver keyed on the string would reject.
    const pkgHeader = tV1Header('x-wx93-signature')({ body, secret })['x-wx93-signature'];
    expect(oldReceiverVerifies(secret, pkgHeader, body)).toBe(false);
  });

  test('a new endpoint gets the old header too, and test() sends webhook.test', async () => {
    const { hub, got } = rig();
    const { endpoint, secret } = await hub.createEndpoint('user-2', { url: 'https://receiver.example/new', events: ['link.created'] });
    expect(endpoint.events).toEqual(['link.created']);
    const t = await hub.test('user-2', endpoint.id);
    expect(t.ok).toBe(true);
    expect(JSON.parse(got[0].body).type).toBe('webhook.test');
    expect(oldReceiverVerifies(secret, got[0].headers.get('x-wx93-signature'), got[0].body)).toBe(true);
  });

  test('events filter: link.created only does not get clicks; unknown events are refused', async () => {
    const { hub, store, got } = rig();
    await migratedEndpoint(store, { owner: 'u3', events: ['link.created'] });
    expect((await hub.emit('u3', 'link.clicked', {})).queued).toBe(0);
    expect((await hub.emit('u3', 'link.created', {})).queued).toBe(1);
    await hub.drain();
    expect(got).toHaveLength(1);
    await expect(hub.createEndpoint('u3', { url: 'https://receiver.example/x', events: ['room.joined'] })).rejects.toThrow(/no event matches/);
  });

  test('the old delivery rhythm: three attempts, then failed; 50 in a row switch it off', async () => {
    expect(BACKOFF_MS).toEqual([5_000, 60_000]);
    expect(DISABLE_AFTER).toBe(50);
    let now = 1_000_000;
    const { store, got } = rig();
    const hub = createHub({
      store,
      now: () => now,
      guard: { lookup: async () => ['93.184.216.34'] },
      fetchImpl: async (url, init) => (got.push(init), new Response(null, { status: 500 })),
    });
    await migratedEndpoint(store, { owner: 'u4' });
    await hub.emit('u4', 'link.created', {});
    await hub.drain();
    now += 5_000;
    await hub.drain();
    now += 60_000;
    await hub.drain();
    now += 3600_000;
    await hub.drain();
    expect(got).toHaveLength(3);
    const [d] = await hub.deliveries('u4');
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(3);
  });

  test('plain http and private addresses are refused', async () => {
    const { hub } = rig();
    await expect(hub.createEndpoint('u5', { url: 'http://receiver.example/x' })).rejects.toThrow();
    const priv = createHub({ store: memoryStore(), guard: { lookup: async () => ['10.0.0.5'] } });
    await expect(priv.createEndpoint('u5', { url: 'https://internal.example/x' })).rejects.toThrow();
  });

  test('cachedEndpoints serves the list from memory and forgets it on any endpoint write', async () => {
    const inner = memoryStore();
    let reads = 0;
    const counting = { ...inner, listEndpoints: (o) => (reads++, inner.listEndpoints(o)) };
    const store = cachedEndpoints(counting);
    const hub = createHub({ store, guard: { lookup: async () => ['93.184.216.34'] }, fetchImpl: async () => new Response(null, { status: 204 }) });
    const { endpoint } = await hub.createEndpoint('u6', { url: 'https://receiver.example/c' });
    reads = 0;
    await hub.emit('u6', 'link.clicked', {});
    await hub.emit('u6', 'link.clicked', {});
    expect(reads).toBe(1);
    await hub.updateEndpoint('u6', endpoint.id, { enabled: false });
    expect((await hub.emit('u6', 'link.clicked', {})).queued).toBe(0);
  });

  test('pgQuery hands postgres.js the text and params and returns { rows }', async () => {
    const calls = [];
    const q = pgQuery({ unsafe: async (text, params) => (calls.push([text, params]), [{ id: 'x' }]) });
    expect(await q.query('SELECT $1', [1])).toEqual({ rows: [{ id: 'x' }] });
    expect(calls).toEqual([['SELECT $1', [1]]]);
  });
});
