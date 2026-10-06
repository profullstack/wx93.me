/** Small, pure parsers for request input. Tested in test/unit.test.js. */

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, y: 365 * 86_400_000 };
const MAX_MS = 10 * 365 * 86_400_000;

/**
 * An expiry from `expires_at` (ISO date) or `expires_in` ("90m", "12h", "7d",
 * "2w", "1y"). Null for none. Throws HttpError(400) for nonsense, the past, or
 * more than ten years out.
 */
export function parseExpiry({ expires_at, expires_in } = {}, now = Date.now()) {
  let at = null;
  if (expires_in !== undefined && expires_in !== null && expires_in !== '') {
    const m = /^(\d{1,6})\s*([mhdwy])$/i.exec(String(expires_in).trim());
    if (!m) throw new HttpError(400, 'expires_in looks like 90m, 12h, 7d, 2w or 1y');
    at = new Date(now + Number(m[1]) * UNITS[m[2].toLowerCase()]);
  } else if (expires_at !== undefined && expires_at !== null && expires_at !== '') {
    at = new Date(expires_at);
    if (Number.isNaN(at.getTime())) throw new HttpError(400, 'expires_at is an ISO 8601 date');
  } else return null;
  if (at.getTime() <= now) throw new HttpError(400, 'the expiry is in the past');
  if (at.getTime() - now > MAX_MS) throw new HttpError(400, 'links expire within ten years, or never');
  return at;
}

export const REDIRECT_TYPES = [301, 302, 307, 308];

export function parseRedirectType(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!REDIRECT_TYPES.includes(n)) throw new HttpError(400, 'redirect_type is 301, 302, 307 or 308');
  return n;
}

/** Pull a wx93 code out of whatever someone pasted: a full URL, host/code, or the bare code. */
export function codeFrom(input, siteHost) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.hostname.replace(/^www\./, '') === siteHost) {
      const seg = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\+$/, '');
      return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(seg) ? seg : null;
    }
  } catch {}
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s) ? s : null;
}

/** The hostname part of a Referer, or null. */
export function referrerHost(ref, ownHost) {
  if (!ref) return null;
  try {
    const h = new URL(ref).hostname.toLowerCase().replace(/^www\./, '');
    return h && h !== ownHost ? h : null;
  } catch {
    return null;
  }
}
