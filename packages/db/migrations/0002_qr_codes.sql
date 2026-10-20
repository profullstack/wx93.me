-- QR codes as saved, styled objects, and richer scan analytics.

-- A saved code. Dynamic ones (url, vcard, event, links) own a short link and
-- encode it, so scans are counted and the content can change after printing;
-- static ones (wifi, phone, …) encode their data directly and have no link.
create table qr_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  link_id     uuid references links(id) on delete cascade,
  name        text not null,
  type        text not null,
  data        jsonb not null default '{}',
  style       jsonb not null default '{}',
  -- PNG or JPEG, checked by magic bytes, at most 256 KB.
  logo        bytea,
  logo_type   text check (logo_type in ('image/png', 'image/jpeg')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index qr_codes_user_idx on qr_codes (user_id, created_at desc);
create unique index qr_codes_link_key on qr_codes (link_id) where link_id is not null;

-- How the visit arrived: 'qr' when the short link was opened from one of our
-- QR codes (they encode ?qr), else 'link'.
alter table clicks add column source text not null default 'link';
-- sha256(server secret, UTC day, address, user agent), cut to 16 hex: counts
-- unique visitors per day, and cannot be turned back into an address. The salt
-- changes daily, so one person is not linkable across days.
alter table clicks add column visitor text;
-- City from DB-IP Lite, when the city database is installed.
alter table clicks add column city text;
create index clicks_link_source_at_idx on clicks (link_id, source, at);
