import { db } from '@wx93/db';
import { config } from './config.js';
import { publicLink, scanUrl, shortUrl } from './links.js';
import { DEFAULT_STYLE } from './qr.js';
import { QR_TYPES, encodeStatic, summary } from './qr-types.js';

/**
 * Saved QR codes. A row holds what the code says (type + data), how it looks
 * (style + logo) and, for a dynamic code, the short link it encodes. The link is
 * an ordinary link: same redirect, same stats, same plan rules.
 */

// The logo's bytes only when an image is being drawn; lists carry has_logo.
const SELECT = (sql, { logo = false } = {}) => sql`
  select q.id, q.user_id, q.link_id, q.name, q.type, q.data, q.style, q.logo_type, q.created_at, q.updated_at,
         (q.logo is not null) as has_logo, ${logo ? sql`q.logo` : sql`null::bytea as logo`},
         to_jsonb(l.*) as link_row, d.hostname as link_hostname
  from qr_codes q left join links l on l.id = q.link_id left join domains d on d.id = l.domain_id`;

const withLink = (row, paid) =>
  row && {
    ...row,
    link: row.link_row ? { ...row.link_row, hostname: row.link_hostname, paid } : null,
  };

export async function listQr(userId, { limit = 100, paid = false, q = null } = {}) {
  const sql = db();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = await sql`
    ${SELECT(sql)} where q.user_id = ${userId}
    ${q ? sql`and (q.name ilike ${`%${q}%`} or q.data::text ilike ${`%${q}%`})` : sql``}
    order by q.created_at desc limit ${lim}`;
  return rows.map((r) => withLink(r, paid));
}

export async function getQr(userId, id, { paid = false, logo = false } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const sql = db();
  const [row] = await sql`${SELECT(sql, { logo })} where q.id = ${id} and q.user_id = ${userId}`;
  return withLink(row ?? null, paid);
}

/** The code behind a short link, for serving its image with its own style. */
export async function qrForLink(linkId) {
  const [row] = await db()`select style, logo, logo_type from qr_codes where link_id = ${linkId}`;
  return row ?? null;
}

/** A hosted page's code, by id alone: the landing page is public by design. */
export async function landingQr(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const [row] = await db()`select id, type, data, user_id from qr_codes where id = ${id} and type in ('vcard', 'event', 'links')`;
  return row ?? null;
}

export async function countQr(userId) {
  const [{ n }] = await db()`select count(*)::int as n from qr_codes where user_id = ${userId}`;
  return n;
}

export async function insertQr({ id, userId, linkId, name, type, data, style }) {
  const [row] = await db()`
    insert into qr_codes (id, user_id, link_id, name, type, data, style)
    values (${id}, ${userId}, ${linkId}, ${name}, ${type}, ${db().json(data)}, ${db().json(style)})
    returning id`;
  return row;
}

export async function patchQr(id, { name, data, style }) {
  const sql = db();
  const [row] = await sql`
    update qr_codes set
      name = coalesce(${name ?? null}, name),
      data = coalesce(${data ? sql.json(data) : null}, data),
      style = coalesce(${style ? sql.json(style) : null}, style),
      updated_at = now()
    where id = ${id} returning id`;
  return row;
}

export async function setLogo(id, logo) {
  await db()`update qr_codes set logo = ${logo?.data ?? null}, logo_type = ${logo?.type ?? null}, updated_at = now() where id = ${id}`;
}

export async function removeQr(row) {
  // The link goes too, and takes the row with it (on delete cascade).
  if (row.link_id) await db()`delete from links where id = ${row.link_id}`;
  else await db()`delete from qr_codes where id = ${row.id}`;
}

/** What the code encodes: the short link (marked as a scan) for a dynamic code, the content itself otherwise. */
export function qrText(row) {
  if (row.link) return scanUrl(shortUrl(row.link));
  return encodeStatic(row.type, row.data);
}

export const logoOf = (row) => (row?.logo ? { data: row.logo, type: row.logo_type } : null);

export function landingUrl(id) {
  return `${config.siteUrl}/p/${id}`;
}

/** What the API returns for a code. Owner-only, so static data (a Wi-Fi password) is included. */
export function publicQr(row) {
  const api = `${config.siteUrl}/api/v1/qr/${row.id}`;
  const link = row.link ? publicLink(row.link) : null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    dynamic: Boolean(row.link_id),
    summary: summary(row.type, row.data),
    data: row.data,
    style: { ...DEFAULT_STYLE, ...row.style },
    logo: Boolean(row.has_logo),
    encodes: qrText(row),
    short_url: link?.short_url ?? null,
    landing_url: ['vcard', 'event', 'links'].includes(row.type) && row.link_id ? landingUrl(row.id) : null,
    scans: link ? link.human_clicks : null,
    link,
    image: { svg: `${api}/image.svg`, png: `${api}/image.png`, pdf: `${api}/image.pdf` },
    stats_url: row.link_id ? `${api}/stats` : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const isDynamic = (type) => Boolean(QR_TYPES[type]?.dynamic);
