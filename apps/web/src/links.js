import { db } from '@wx93/db';
import { randomCode } from './codes.js';
import { config } from './config.js';
import { emit } from './webhooks.js';

/**
 * Links: create, resolve (the hot path), count clicks, report numbers.
 *
 * The redirect is the product, so resolve() is built to stay off the database:
 * a short in-memory cache in front of one indexed lookup that also answers
 * "does the owner pay" in the same round trip. Clicks are buffered and written
 * in batches, so a visit never waits on an INSERT.
 */

const DEFAULT_DOMAIN = '00000000-0000-0000-0000-000000000000';

/* ----------------------------------------------------------------- create -- */

export class CodeTaken extends Error {}

/**
 * Insert a link. A random code is retried on collision and grows by one
 * character after three misses; an alias that is taken is the caller's error.
 */
export async function insertLink({
  url,
  host,
  alias = null,
  domainId = null,
  userId = null,
  apiKeyId = null,
  payer = null,
  adFreeUntil = null,
  redirectType = 302,
  title = null,
  shortHost = null,
  expiresAt = null,
  ip = null,
}) {
  const sql = db();
  let length = config.links.codeLength;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = alias ?? randomCode(length);
    const rows = await sql`
      insert into links (code, domain_id, short_host, url, host, title, user_id, api_key_id, payer, ad_free_until,
                         redirect_type, custom, expires_at, created_ip)
      values (${code}, ${domainId}, ${shortHost}, ${url}, ${host}, ${title}, ${userId}, ${apiKeyId}, ${payer}, ${adFreeUntil},
              ${redirectType}, ${Boolean(alias)}, ${expiresAt}, ${ip})
      on conflict do nothing
      returning *`;
    if (rows.length) {
      const link = rows[0];
      if (userId) emit(userId, 'link.created', { link: publicLink(link) });
      return link;
    }
    if (alias) throw new CodeTaken(`"${alias}" is taken`);
    if (attempt >= 2) length++;
  }
  throw new Error('could not find a free code');
}

/* ---------------------------------------------------------------- resolve -- */

const cache = new Map();
const CACHE_MS = 30_000;
const CACHE_MAX = 20_000;

export function invalidate(code) {
  for (const key of cache.keys()) if (key.endsWith(`|${code}`)) cache.delete(key);
}
export const clearCache = () => cache.clear();

/**
 * The link for `code` on `host`, with `paid` (the owner's plan skips the
 * interstitial) and `hooks` (the owner wants click webhooks) worked out in the
 * same query. Null when there is no such link; disabled and expired links are
 * returned so the caller can say which.
 */
export async function resolve(host, code) {
  const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
  const own = isOwnHost(h);
  const key = `${own ? '' : h}|${code}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.link;

  const sql = db();
  const rows = own
    ? await sql`
        select l.id, l.code, l.url, l.redirect_type, l.expires_at, l.disabled_at, l.disabled_reason,
               l.ad_free_until, l.user_id, l.created_at, l.title, l.short_host, null::text as hostname,
               (coalesce(u.is_admin, false) or exists (
                  select 1 from plan_periods p where p.user_id = l.user_id and p.starts_at <= now() and p.ends_at > now()
               )) as paid,
               exists (select 1 from webhooks w where w.user_id = l.user_id and w.disabled_at is null
                       and 'link.clicked' = any(w.events)) as hooks
        from links l left join users u on u.id = l.user_id
        where l.domain_id is null and l.code = ${code}`
    : await sql`
        select l.id, l.code, l.url, l.redirect_type, l.expires_at, l.disabled_at, l.disabled_reason,
               l.ad_free_until, l.user_id, l.created_at, l.title, l.short_host, d.hostname,
               true as paid,
               exists (select 1 from webhooks w where w.user_id = l.user_id and w.disabled_at is null
                       and 'link.clicked' = any(w.events)) as hooks
        from links l join domains d on d.id = l.domain_id
        where lower(d.hostname) = ${h} and d.verified_at is not null and l.code = ${code}`;
  const link = rows[0] ?? null;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { link, at: Date.now() });
  return link;
}

/** Is this link ad-free right now? A paying owner, or an x402 payment still in date. */
export const adFree = (link, now = Date.now()) =>
  Boolean(link.paid) || Boolean(link.ad_free_until && new Date(link.ad_free_until).getTime() > now);

/* ----------------------------------------------------------------- clicks -- */

let buffer = [];
let flushing = null;
let timer = null;

/** Queue a click. Written within a second, in a batch, off the request path. */
export function recordClick(link, info) {
  buffer.push({
    link_id: link.id,
    at: new Date(),
    referrer_host: info.referrerHost?.slice(0, 200) ?? null,
    country: info.country ?? 'XX',
    device: info.device ?? null,
    browser: info.browser ?? null,
    os: info.os ?? null,
    bot: Boolean(info.bot),
  });
  if (link.hooks && link.user_id && !info.bot)
    emit(link.user_id, 'link.clicked', {
      link: { id: link.id, code: link.code, url: link.url },
      click: { at: new Date().toISOString(), country: info.country, device: info.device, referrer_host: info.referrerHost ?? null },
    });
  if (buffer.length >= 500) void flushClicks();
  else timer ??= setTimeout(() => void flushClicks(), 1000);
}

export async function flushClicks() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (flushing) await flushing;
  if (!buffer.length) return 0;
  const rows = buffer;
  buffer = [];
  flushing = (async () => {
    const sql = db();
    try {
      await sql`insert into clicks ${sql(rows, 'link_id', 'at', 'referrer_host', 'country', 'device', 'browser', 'os', 'bot')}`;
      const counts = new Map();
      for (const r of rows) {
        const c = counts.get(r.link_id) ?? { all: 0, human: 0 };
        c.all++;
        if (!r.bot) c.human++;
        counts.set(r.link_id, c);
      }
      for (const [id, c] of counts)
        await sql`update links set clicks = clicks + ${c.all}, human_clicks = human_clicks + ${c.human} where id = ${id}`;
    } catch (err) {
      console.error(`[clicks] dropped ${rows.length}: ${err?.message ?? err}`);
    }
  })();
  await flushing;
  flushing = null;
  return rows.length;
}

/* ------------------------------------------------------------------ reads -- */

export function shortUrl(link) {
  if (link.hostname) return `https://${link.hostname}/${link.code}`;
  if (link.short_host && link.short_host !== config.host) return `https://${link.short_host}/${link.code}`;
  return `${config.siteUrl}/${link.code}`;
}

/** wx93.me, 9xq.me (and www.), plus localhost for development. */
export function isOwnHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
  return h === 'localhost' || h === '127.0.0.1' || config.shortHosts.includes(h);
}

/** What the API returns for a link. */
export function publicLink(l) {
  return {
    id: l.id,
    code: l.code,
    short_url: shortUrl(l),
    url: l.url,
    title: l.title ?? null,
    domain: l.hostname ?? l.short_host ?? config.host,
    custom: Boolean(l.custom),
    redirect_type: l.redirect_type,
    clicks: Number(l.clicks ?? 0),
    human_clicks: Number(l.human_clicks ?? 0),
    expires_at: l.expires_at ?? null,
    disabled: Boolean(l.disabled_at),
    disabled_reason: l.disabled_reason ?? null,
    ad_free: adFree(l),
    qr_svg: `${config.siteUrl}/qr/${l.code}.svg${l.hostname || l.short_host ? `?domain=${encodeURIComponent(l.hostname ?? l.short_host)}` : ''}`,
    stats_url: `${config.siteUrl}/api/v1/links/${l.id}/stats`,
    created_at: l.created_at,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A link the user owns, by id or by code on wx93.me. */
export async function ownedLink(userId, ref) {
  const sql = db();
  const rows = UUID.test(ref)
    ? await sql`
        select l.*, d.hostname, exists (select 1 from plan_periods p where p.user_id = l.user_id
               and p.starts_at <= now() and p.ends_at > now()) as paid
        from links l left join domains d on d.id = l.domain_id where l.id = ${ref} and l.user_id = ${userId}`
    : await sql`
        select l.*, null::text as hostname, exists (select 1 from plan_periods p where p.user_id = l.user_id
               and p.starts_at <= now() and p.ends_at > now()) as paid
        from links l where l.code = ${ref} and l.domain_id is null and l.user_id = ${userId}`;
  return rows[0] ?? null;
}

export async function listLinks(userId, { limit = 50, before = null, q = null } = {}) {
  const sql = db();
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return sql`
    select l.*, d.hostname, exists (select 1 from plan_periods p where p.user_id = l.user_id
           and p.starts_at <= now() and p.ends_at > now()) as paid
    from links l left join domains d on d.id = l.domain_id
    where l.user_id = ${userId}
      ${before ? sql`and l.created_at < ${new Date(before)}` : sql``}
      ${q ? sql`and (l.url ilike ${`%${q}%`} or l.code ilike ${`%${q}%`} or l.title ilike ${`%${q}%`})` : sql``}
    order by l.created_at desc limit ${lim}`;
}

export async function linksThisMonth(userId) {
  const [{ n }] = await db()`
    select count(*)::int as n from links where user_id = ${userId} and created_at >= date_trunc('month', now())`;
  return n;
}

export async function updateLink(link, patch) {
  const sql = db();
  const [row] = await sql`
    update links set
      url = ${patch.url ?? link.url},
      host = ${patch.host ?? link.host},
      title = ${patch.title === undefined ? link.title : patch.title},
      expires_at = ${patch.expiresAt === undefined ? link.expires_at : patch.expiresAt},
      redirect_type = ${patch.redirectType ?? link.redirect_type},
      updated_at = now()
    where id = ${link.id} returning *`;
  invalidate(link.code);
  return { ...row, hostname: link.hostname, paid: link.paid };
}

export async function deleteLink(link) {
  await db()`delete from links where id = ${link.id}`;
  invalidate(link.code);
}

export async function setDisabled(linkId, reason) {
  const [row] = await db()`
    update links set disabled_at = ${reason ? new Date() : null}, disabled_reason = ${reason}, updated_at = now()
    where id = ${linkId} returning code`;
  if (row) invalidate(row.code);
  return row ?? null;
}

/** Totals, daily series and top lists for one link over `days`. */
export async function linkStats(linkId, { days = 30, full = true } = {}) {
  const sql = db();
  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  const since = new Date(Date.now() - d * 86400_000);
  const [totals] = await sql`
    select count(*)::int as clicks, count(*) filter (where not bot)::int as humans,
           count(*) filter (where bot)::int as bots
    from clicks where link_id = ${linkId} and at >= ${since}`;
  if (!full) return { days: d, ...totals };
  const top = (col) => sql`
    select coalesce(${sql(col)}, 'unknown') as key, count(*)::int as clicks
    from clicks where link_id = ${linkId} and at >= ${since} and not bot
    group by 1 order by 2 desc limit 20`;
  const [daily, referrers, countries, devices, browsers, oses] = await Promise.all([
    sql`select to_char(date_trunc('day', at), 'YYYY-MM-DD') as day, count(*)::int as clicks,
               count(*) filter (where not bot)::int as humans
        from clicks where link_id = ${linkId} and at >= ${since} group by 1 order by 1`,
    sql`select coalesce(referrer_host, 'direct') as key, count(*)::int as clicks
        from clicks where link_id = ${linkId} and at >= ${since} and not bot group by 1 order by 2 desc limit 20`,
    top('country'),
    top('device'),
    top('browser'),
    top('os'),
  ]);
  return { days: d, ...totals, daily, referrers, countries, devices, browsers, os: oses };
}
