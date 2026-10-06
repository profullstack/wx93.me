/**
 * The MCP tools, as one table: the stdio server (`wx93 mcp`, @profullstack/wx93-mcp)
 * and the hosted endpoint (POST https://wx93.me/mcp) both serve exactly this.
 */
import * as api from './client.js';

export const PROTOCOL_VERSION = '2025-06-18';

const link = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The long http(s) URL to shorten.' },
    alias: { type: 'string', description: 'Custom short code (Pro and up), 3-64 of A-Z a-z 0-9 - _.' },
    title: { type: 'string' },
    expires_in: { type: 'string', description: 'Lifetime like 90m, 12h, 7d, 2w, 1y. Omit for never.' },
    redirect_type: { type: 'integer', enum: [301, 302, 307, 308], description: 'Pro and up. Default 302.' },
    domain: { type: 'string', description: 'Which host the short link uses: wx93.me (default), 9xq.me, or a verified custom domain of yours (Automation). Codes resolve on both wx93.me and 9xq.me.' },
  },
  required: ['url'],
  additionalProperties: false,
};
const refOnly = {
  type: 'object',
  properties: { ref: { type: 'string', description: 'The link id, its code, or the whole short URL.' } },
  required: ['ref'],
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: 'shorten_url',
    description:
      'Shorten a URL with wx93.me and return the short link. Works without an account (free links open through a short ad page for people; bots and previews get the direct redirect). Signed-in Pro and Automation links redirect directly and can have aliases.',
    inputSchema: link,
  },
  {
    name: 'bulk_shorten',
    description: 'Shorten up to 1,000 URLs in one call (Automation plan). Returns one result per input, in order.',
    inputSchema: {
      type: 'object',
      properties: { links: { type: 'array', items: link, maxItems: 1000 } },
      required: ['links'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_links',
    description: "The account's short links, newest first, with click counts.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, q: { type: 'string', description: 'Filter by URL, code or title.' } },
      additionalProperties: false,
    },
  },
  { name: 'get_link', description: 'One of your links.', inputSchema: refOnly },
  {
    name: 'link_stats',
    description: 'Clicks for one of your links: totals (people vs bots), and on Pro+ daily counts, referrers, countries, devices, browsers.',
    inputSchema: {
      type: 'object',
      properties: { ref: refOnly.properties.ref, days: { type: 'integer', minimum: 1, maximum: 365 } },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_link',
    description: 'Change where one of your links goes, its title, expiry or redirect type.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: refOnly.properties.ref,
        url: { type: 'string' },
        title: { type: 'string' },
        expires_in: { type: 'string' },
        redirect_type: { type: 'integer', enum: [301, 302, 307, 308] },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  { name: 'delete_link', description: 'Delete one of your links. It stops resolving at once.', inputSchema: refOnly },
  {
    name: 'expand_link',
    description: 'Where a wx93.me short link goes, without following it.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  },
  { name: 'whoami', description: 'The signed-in account, its plan and this month\'s usage.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

const text = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export async function callTool(auth, name, args = {}) {
  switch (name) {
    case 'shorten_url': {
      const l = await api.shorten(auth, args);
      return text(`${l.short_url}\n\n${JSON.stringify(l, null, 2)}`);
    }
    case 'bulk_shorten':
      return text(await api.bulk(auth, args.links ?? []));
    case 'list_links':
      return text((await api.list(auth, { limit: args.limit ?? 50, q: args.q })).links);
    case 'get_link':
      return text(await api.getLink(auth, args.ref));
    case 'link_stats':
      return text(await api.stats(auth, args.ref, { days: args.days }));
    case 'update_link': {
      const { ref, ...patch } = args;
      return text(await api.updateLink(auth, ref, patch));
    }
    case 'delete_link':
      return text(await api.deleteLink(auth, args.ref));
    case 'expand_link':
      return text(await api.expand(auth, args.url));
    case 'whoami':
      return text(await api.me(auth));
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

/** One JSON-RPC request -> a result, or throws an error with a JSON-RPC code. */
export async function handle(req, { auth, serverName = 'wx93' }) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: api.VERSION },
        instructions:
          'Shorten URLs with shorten_url (or bulk_shorten). Without credentials links are free and open through a short ad page for people; set WX93_API_KEY or run `wx93 login` for Pro/Automation links, stats and aliases.',
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return await callTool(await auth(), req.params?.name, req.params?.arguments ?? {});
      } catch (err) {
        if (err.code === -32602) throw err;
        return text(String(err?.message ?? err), true);
      }
    case 'ping':
      return {};
    default:
      throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
  }
}
