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
const qrStyle = {
  type: 'object',
  description: 'How the code looks. Colours are hex. Too little contrast between fg and bg is refused.',
  properties: {
    fg: { type: 'string', description: 'Module colour, e.g. #0b0d10.' },
    bg: { type: 'string', description: 'Background colour.' },
    eye: { type: 'string', description: 'Colour of the three corner eyes; defaults to fg.' },
    transparent: { type: 'boolean' },
    dots: { type: 'string', enum: ['square', 'rounded', 'dots'] },
    eye_frame: { type: 'string', enum: ['square', 'rounded', 'circle'] },
    eye_ball: { type: 'string', enum: ['square', 'rounded', 'circle'] },
    ecc: { type: 'string', enum: ['L', 'M', 'Q', 'H'], description: 'Error correction. A logo forces H.' },
    margin: { type: 'integer', minimum: 0, maximum: 10 },
  },
  additionalProperties: false,
};
const QR_TYPE_LIST = ['url', 'vcard', 'event', 'links', 'text', 'wifi', 'email', 'phone', 'sms', 'whatsapp', 'geo', 'crypto'];
const qrId = { type: 'string', description: 'The QR code id (a UUID from create_qr_code or list_qr_codes).' };

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
    description:
      'Clicks for one of your links: totals (people, QR scans, unique visitors, bots), and on Pro+ daily counts, referrers, countries, cities, devices, OS, browsers, a weekday-by-hour heatmap, week over week and the latest visits.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: refOnly.properties.ref,
        days: { type: 'integer', minimum: 1, maximum: 365 },
        tz: { type: 'string', description: 'IANA time zone for the heatmap, e.g. America/New_York. Default UTC.' },
        source: { type: 'string', enum: ['qr', 'link'], description: 'Only QR scans, or only plain clicks.' },
      },
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
  {
    name: 'create_qr_code',
    description:
      'Save a styled QR code to the account and return it with a PNG preview. Dynamic types (url, vcard, event, links) encode a wx93 short link: scans are counted and the content can change after printing (vcard, event and links get a hosted page). Static types (text, wifi, email, phone, sms, whatsapp, geo, crypto) carry their content directly. Data keys per type: url {url}; vcard {first, last?, org?, title?, phone?, email?, url?, address?, note?}; event {title, start, end?, tz?, location?, description?, url?}; links {title, description?, links: "Label | https://… per line"}; text {text}; wifi {ssid, password?, encryption? WPA|WEP|nopass, hidden?}; email {to, subject?, body?}; phone {number}; sms {number, message?}; whatsapp {number, message?}; geo {lat, lng, label?}; crypto {coin, address, amount?, label?}.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: QR_TYPE_LIST },
        data: { type: 'object', description: "The type's fields (see the description)." },
        name: { type: 'string' },
        style: qrStyle,
        domain: { type: 'string', description: 'Dynamic codes: wx93.me (default), 9xq.me, or a verified custom domain.' },
        alias: { type: 'string', description: 'Dynamic codes, Pro and up: a custom short code.' },
      },
      required: ['type', 'data'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_qr_codes',
    description: "The account's saved QR codes, newest first, with what each encodes and its scan count.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, q: { type: 'string', description: 'Filter by name or content.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_qr_code',
    description: 'One saved QR code, with the image as PNG and links to SVG and print-ready PDF.',
    inputSchema: { type: 'object', properties: { id: qrId, size: { type: 'integer', minimum: 64, maximum: 2048 } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'update_qr_code',
    description: "Change a saved code's name, content (merged into its data) or style. A dynamic code keeps working after printing; a static one changes its picture.",
    inputSchema: {
      type: 'object',
      properties: { id: qrId, name: { type: 'string' }, data: { type: 'object' }, style: qrStyle },
      required: ['id'],
      additionalProperties: false,
    },
  },
  { name: 'delete_qr_code', description: 'Delete a saved QR code (and, for a dynamic one, its short link).', inputSchema: { type: 'object', properties: { id: qrId }, required: ['id'], additionalProperties: false } },
  {
    name: 'qr_code_stats',
    description:
      'Scans of a dynamic QR code: people, unique visitors, bots; on Pro+ daily series, countries, cities, devices, OS, browsers, a weekday-by-hour heatmap, week over week, the last hour and the latest scans.',
    inputSchema: {
      type: 'object',
      properties: {
        id: qrId,
        days: { type: 'integer', minimum: 1, maximum: 365 },
        tz: { type: 'string', description: 'IANA time zone for the heatmap.' },
        source: { type: 'string', enum: ['qr', 'link'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  { name: 'whoami', description: 'The signed-in account, its plan and this month\'s usage.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

/** A QR code as JSON plus its picture, so a client that shows images shows it. */
async function withImage(auth, q, size = 512) {
  const png = await api.qrImage(auth, q.id, 'png', { size }).catch(() => null);
  return {
    content: [
      { type: 'text', text: `${q.short_url ?? q.encodes}\n\n${JSON.stringify(q, null, 2)}` },
      ...(png ? [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] : []),
    ],
  };
}

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
      return text(await api.stats(auth, args.ref, { days: args.days, tz: args.tz, source: args.source }));
    case 'create_qr_code':
      return withImage(auth, await api.createQr(auth, args));
    case 'list_qr_codes':
      return text((await api.listQr(auth, { limit: args.limit ?? 50, q: args.q })).qr_codes);
    case 'get_qr_code':
      return withImage(auth, await api.getQr(auth, args.id), args.size);
    case 'update_qr_code': {
      const { id, ...patch } = args;
      return withImage(auth, await api.updateQr(auth, id, patch));
    }
    case 'delete_qr_code':
      return text(await api.deleteQr(auth, args.id));
    case 'qr_code_stats':
      return text(await api.qrStats(auth, args.id, { days: args.days, tz: args.tz, source: args.source }));
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
          'Shorten URLs with shorten_url (or bulk_shorten). Make styled, trackable QR codes with create_qr_code and read their scans with qr_code_stats. Without credentials links are free and open through a short ad page for people; set WX93_API_KEY or run `wx93 login` for Pro/Automation links, stats and aliases.',
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
