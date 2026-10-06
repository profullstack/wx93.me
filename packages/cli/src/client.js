/**
 * The wx93 API as function calls. Shared by the CLI, the TUI, the stdio MCP
 * server, the hosted /mcp endpoint and the desktop app, so they all behave the
 * same. Plain fetch; runs on Node 20+, Bun, and Electron's Node.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTokenStore, getAccessToken } from '@profullstack/auth-system/cli';

export const VERSION = '0.1.0';
export const DEFAULT_SERVER = 'https://wx93.me';
export const CONFIG_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'wx93', 'config.json');

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveConfig(patch) {
  const next = { ...(await loadConfig()), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return CONFIG_FILE;
}

/** The OAuth 2.1 sign-in `wx93 login` saves; the CLI, TUI, MCP and desktop share it. */
export const tokenStore = () => createTokenStore('wx93');

/**
 * Server and credential, first match wins: --key / WX93_API_KEY / a saved API
 * key, then the OAuth sign-in (refreshed when close to expiry). Anonymous when
 * there is neither: free links still work.
 */
export async function resolveAuth({ server, key } = {}) {
  const saved = await loadConfig();
  const srv = (server || process.env.WX93_URL || saved.server || DEFAULT_SERVER).replace(/\/+$/, '');
  let k = key || process.env.WX93_API_KEY || saved.key || '';
  let via = k ? 'api-key' : 'anonymous';
  if (!k) {
    try {
      const store = tokenStore();
      const t = await store.load();
      if (t?.issuer && t.issuer.replace(/\/+$/, '') === srv) {
        k = (await getAccessToken({ store })) || '';
        if (k) via = 'oauth';
      }
    } catch {
      // An unreadable or revoked sign-in is the same as none: anonymous still works.
    }
  }
  return { server: srv, key: k, via };
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ? `${body.error} (HTTP ${status})` : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** auth.fetch lets the hosted MCP endpoint call the app in-process instead of over the network. */
export async function call(auth, path, init = {}) {
  const doFetch = auth.fetch ?? fetch;
  const res = await doFetch(`${auth.server}${path.startsWith('/qr/') ? '' : '/api/v1'}${path}`, {
    ...init,
    headers: {
      'user-agent': `wx93-cli/${VERSION}`,
      accept: 'application/json',
      ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}),
      ...(auth.pass ? { 'x-crawl-pass': auth.pass } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(auth.headers ?? {}),
      ...(init.headers ?? {}),
    },
  });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new ApiError(res.status, typeof body === 'string' ? { error: body.slice(0, 300) } : body);
  return body;
}

const post = (body, method = 'POST') => ({ method, body: JSON.stringify(body ?? {}) });
const qs = (o) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
const ref = (r) => encodeURIComponent(String(r).replace(/^https?:\/\/[^/]+\//, '').replace(/\+$/, ''));

export const health = (auth) => call(auth, '/health');
export const me = (auth) => call(auth, '/me');
export const shorten = (auth, input) => call(auth, '/links', post(typeof input === 'string' ? { url: input } : input));
export const bulk = (auth, links) => call(auth, '/links/bulk', post({ links }));
export const list = (auth, { limit, before, q } = {}) => call(auth, `/links?${qs({ limit, before, q })}`);
export const getLink = (auth, r) => call(auth, `/links/${ref(r)}`);
export const updateLink = (auth, r, patch) => call(auth, `/links/${ref(r)}`, post(patch, 'PATCH'));
export const deleteLink = (auth, r) => call(auth, `/links/${ref(r)}`, { method: 'DELETE' });
export const stats = (auth, r, { days } = {}) => call(auth, `/links/${ref(r)}/stats?${qs({ days })}`);
export const expand = (auth, url) => call(auth, `/expand?${qs({ url })}`);
export const keys = (auth) => call(auth, '/keys');
export const createKey = (auth, name) => call(auth, '/keys', post({ name }));
export const revokeKey = (auth, id) => call(auth, `/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const checkout = (auth, plan, term, chain) => call(auth, '/billing/checkout', post({ plan, term, chain }));
export const report = (auth, body) => call(auth, '/reports', post(body));
