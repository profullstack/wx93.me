import { readFileSync } from 'node:fs';
import { Reader } from 'mmdb-lib';
import { config } from './config.js';

/**
 * Country from the visitor's address, with DB-IP's free Lite database (CC BY 4.0,
 * attribution in the footer), baked into the image at build time. Only the
 * two-letter code is kept; the address itself is never stored.
 *
 * No database (a dev box, a self-host that skipped the download): every visit is
 * country "XX" and nothing else breaks.
 */
let reader;
let loaded = false;

function load() {
  if (loaded) return reader;
  loaded = true;
  try {
    reader = new Reader(readFileSync(config.geoipPath));
  } catch {
    reader = null;
  }
  return reader;
}

export function countryOf(ip) {
  if (!ip) return 'XX';
  const r = load();
  if (!r) return 'XX';
  try {
    const hit = r.get(String(ip).replace(/^::ffff:/, ''));
    const code = hit?.country?.iso_code;
    return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? code : 'XX';
  } catch {
    return 'XX';
  }
}

export const geoReady = () => Boolean(load());

/**
 * The caller's address. nginx on dev2 sets X-Real-IP to the TCP peer; that is
 * the only header trusted here. CF-Connecting-IP and X-Forwarded-For are client
 * writable behind our edge, so reading them would let a caller pick its country
 * and its rate-limit bucket.
 */
export function clientIp(request) {
  return request.headers.get('x-real-ip')?.trim() || null;
}
