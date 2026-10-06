import { handle } from '@profullstack/wx93/tools';
import { config } from './config.js';
import { clientIp } from './geo.js';

/**
 * Hosted MCP: POST /mcp, JSON-RPC 2.0 over the streamable HTTP transport, the
 * same tools as the stdio server (@profullstack/wx93-mcp). Answers are plain JSON,
 * which the transport allows. Auth is the caller's own Authorization header (an
 * API key or OAuth token), passed through; with none, free links still work.
 *
 * The tools call the REST API in-process through app.fetch, so a hosted tool
 * call is exactly an API call: same quotas, same abuse checks, same throttle.
 */
export function mountMcp(app) {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, x-crawl-pass',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  app.options('/mcp', (c) => c.body(null, 204, cors));
  app.get('/mcp', (c) =>
    c.json({ name: 'wx93', transport: 'streamable-http', endpoint: `${config.siteUrl}/mcp`, method: 'POST', docs: `${config.siteUrl}/docs#mcp` }, 200, cors),
  );
  app.post('/mcp', async (c) => {
    let msg;
    try {
      msg = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400, cors);
    }
    const authz = c.req.header('authorization') ?? '';
    const ip = clientIp(c.req.raw);
    const auth = async () => ({
      server: config.siteUrl,
      key: authz.replace(/^Bearer\s+/i, ''),
      pass: c.req.header('x-crawl-pass') ?? undefined,
      headers: ip ? { 'x-real-ip': ip } : {},
      fetch: (url, init) => app.fetch(new Request(url, init)),
    });
    const one = async (req) => {
      if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return { jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32600, message: 'invalid request' } };
      if (req.id === undefined || req.id === null) return null; // a notification
      try {
        return { jsonrpc: '2.0', id: req.id, result: await handle(req, { auth }) };
      } catch (err) {
        return { jsonrpc: '2.0', id: req.id, error: { code: err.code ?? -32603, message: String(err.message) } };
      }
    };
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(one))).filter(Boolean);
      return out.length ? c.json(out, 200, cors) : c.body(null, 202, cors);
    }
    const out = await one(msg);
    return out ? c.json(out, 200, cors) : c.body(null, 202, cors);
  });
}
