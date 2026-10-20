import { existsSync, readFileSync } from 'node:fs';
import { Reader } from 'mmdb-lib';
import { config } from './config.js';

/**
 * Country, and city when the city database is there, from the visitor's address,
 * with DB-IP's free Lite databases (CC BY 4.0, attributed in the footer), baked
 * into the image at build time. Only the names are kept; the address itself is
 * never stored.
 *
 * The city file is ~130 MB, so under Bun it is memory-mapped: the pages live in
 * the shared, evictable page cache rather than the process heap.
 *
 * No database (a dev box, a self-host that skipped the download): every visit is
 * country "XX" with no city, and nothing else breaks.
 */
let reader;
let loaded = false;

/**
 * Bun.mmap needs write permission on the file (it opens it read-write even for a
 * private mapping). `heap: false` refuses to fall back to reading the whole file
 * into memory: the city database is skipped rather than costing 130 MB of heap.
 */
function open(path, { heap }) {
  if (!existsSync(path)) return null;
  try {
    let bytes;
    try {
      if (typeof Bun === 'undefined' || !Bun.mmap) throw new Error('no mmap here');
      bytes = Bun.mmap(path, { shared: false });
    } catch (err) {
      if (!heap) throw err;
      bytes = readFileSync(path);
    }
    return new Reader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (err) {
    console.error(`[geo] could not open ${path}: ${err?.message ?? err}`);
    return null;
  }
}

function load() {
  if (loaded) return reader;
  loaded = true;
  reader = open(config.geoipCityPath, { heap: false }) ?? open(config.geoipPath, { heap: true });
  return reader;
}

/** { country: 'US', city: 'Austin' | null }. */
export function placeOf(ip) {
  if (!ip) return { country: 'XX', city: null };
  const r = load();
  if (!r) return { country: 'XX', city: null };
  try {
    const hit = r.get(String(ip).replace(/^::ffff:/, ''));
    const code = hit?.country?.iso_code;
    const city = hit?.city?.names?.en;
    return {
      country: typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? code : 'XX',
      city: typeof city === 'string' && city ? city.slice(0, 80) : null,
    };
  } catch {
    return { country: 'XX', city: null };
  }
}

export const countryOf = (ip) => placeOf(ip).country;

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
