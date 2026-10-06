-- wx93.me initial schema: accounts and sign-in (magic link + passkey, no
-- passwords), API keys, OAuth 2.1 for our own CLI/TUI/MCP/desktop, money in
-- (CoinPay), plans as paid periods, and the shortener itself.

create extension if not exists pgcrypto;

-- --------------------------------------------------------------- accounts --

create table users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);
create unique index users_email_key on users (lower(email));

-- Only the hash of a magic link is stored, so a database read cannot mint a session.
create table login_tokens (
  token_hash  bytea primary key,
  email       text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index login_tokens_expires_idx on login_tokens (expires_at);

create table sessions (
  id          text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  user_agent  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

create table passkeys (
  credential_id text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_user_idx on passkeys (user_id);

create table webauthn_challenges (
  id          text primary key,
  challenge   text not null,
  user_id     uuid references users(id) on delete cascade,
  expires_at  timestamptz not null
);

-- God Mode API keys: one key does everything the account can. Hash only; the
-- plaintext is shown once.
create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null default 'default',
  key_hash     bytea not null unique,
  prefix       text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_keys_user_idx on api_keys (user_id);

-- OAuth 2.1 (@profullstack/auth-system/oauth2/postgres's OAUTH2_SCHEMA).
create table oauth2_codes (
  code_hash       text primary key,
  user_id         text not null,
  client_id       text not null,
  redirect_uri    text not null,
  code_challenge  text not null,
  scope           text not null,
  expires_at      timestamptz not null,
  used_at         timestamptz
);
create table oauth2_tokens (
  token_hash  text primary key,
  kind        text not null check (kind in ('access', 'refresh')),
  user_id     text not null,
  client_id   text not null,
  scope       text not null,
  family_id   text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index oauth2_tokens_family on oauth2_tokens (family_id);
create index oauth2_tokens_user on oauth2_tokens (user_id);

-- ------------------------------------------------------------------ money --

create table payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  provider     text not null,
  provider_ref text not null,
  amount_cents int not null,
  currency     text not null default 'USD',
  status       text not null,
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, provider_ref)
);
create index payments_user_idx on payments (user_id);

-- Plans as paid periods. Payment is prepaid crypto, so nothing renews on its
-- own: the plan in force is whichever paid period covers now. One row per
-- payment (payment_id unique), so a redelivered webhook adds nothing.
create table plan_periods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  plan        text not null check (plan in ('pro', 'automation')),
  term        text not null check (term in ('month', 'year')),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null check (ends_at > starts_at),
  payment_id  uuid unique references payments(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index plan_periods_user_idx on plan_periods (user_id, ends_at);

-- -------------------------------------------------------------- shortener --

-- Custom domains (Automation). Proven by a TXT record at _wx93.<hostname>.
create table domains (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  hostname     text not null,
  verify_token text not null,
  verified_at  timestamptz,
  created_at   timestamptz not null default now()
);
create unique index domains_hostname_key on domains (lower(hostname));
create index domains_user_idx on domains (user_id);

create table links (
  id             uuid primary key default gen_random_uuid(),
  -- Case-sensitive, like every other shortener: base62 codes need both cases.
  code           text not null,
  domain_id      uuid references domains(id) on delete cascade,
  url            text not null,
  -- The destination's hostname, lower-cased, so abuse feeds can sweep by host.
  host           text not null,
  title          text,
  -- Which of our own short hosts this link is shown on (null = the primary,
  -- wx93.me). Codes are one namespace: a code resolves on every own host.
  short_host     text,
  -- Null for an anonymous link and for an agent that paid per call over x402.
  user_id        uuid references users(id) on delete cascade,
  api_key_id     uuid,
  -- An x402 payer, by pass fingerprint (never the pass itself).
  payer          text,
  -- Set for links paid for over x402: no interstitial until this date.
  ad_free_until  timestamptz,
  redirect_type  smallint not null default 302 check (redirect_type in (301, 302, 307, 308)),
  custom         boolean not null default false,
  clicks         bigint not null default 0,
  human_clicks   bigint not null default 0,
  created_ip     text,
  expires_at     timestamptz,
  disabled_at    timestamptz,
  disabled_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- A code is unique per domain; the null domain is wx93.me itself.
create unique index links_code_key
  on links (coalesce(domain_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
create index links_user_idx on links (user_id, created_at desc);
create index links_host_idx on links (host);
create index links_created_idx on links (created_at, id);

-- One row per visit. No IP address is kept: country is resolved at the edge of
-- the request and only the two-letter code is stored.
create table clicks (
  id            bigserial primary key,
  link_id       uuid not null references links(id) on delete cascade,
  at            timestamptz not null default now(),
  referrer_host text,
  country       text,
  device        text,
  browser       text,
  os            text,
  bot           boolean not null default false
);
create index clicks_link_at_idx on clicks (link_id, at);

create table reports (
  id          uuid primary key default gen_random_uuid(),
  link_id     uuid references links(id) on delete cascade,
  reported    text not null,
  reason      text not null check (reason in ('phishing', 'malware', 'spam', 'illegal', 'other')),
  details     text,
  email       text,
  -- sha256 of the reporter's address with a server pepper: enough to count
  -- distinct reporters, not enough to find them.
  reporter    text not null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolution  text
);
create index reports_link_idx on reports (link_id);
create unique index reports_one_per_reporter on reports (link_id, reporter) where link_id is not null;

-- Destinations we refuse, by registrable host or any suffix of it.
create table blocklist (
  domain      text primary key,
  reason      text not null default 'abuse',
  created_at  timestamptz not null default now()
);

-- Automation: a URL we POST signed events to.
create table webhooks (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  url              text not null,
  secret           text not null,
  events           text[] not null default '{link.created,link.clicked}',
  created_at       timestamptz not null default now(),
  last_status      int,
  last_error       text,
  last_delivery_at timestamptz,
  failures         int not null default 0,
  disabled_at      timestamptz
);
create index webhooks_user_idx on webhooks (user_id);
