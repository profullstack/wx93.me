-- Webhooks move onto @profullstack/webhooks: its two tables (schemaSql('pg')),
-- a durable outbox instead of in-process retries, and a delivery log.
--
-- Every existing endpoint is copied across with the SAME id and the SAME secret,
-- so receivers keep verifying x-wx93-signature with no change on their side, and
-- an id a customer saved still works with DELETE /api/v1/webhooks/<id>. The old
-- table is kept (renamed) rather than dropped, so nothing is lost.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_owner ON webhook_endpoints(owner);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_at);

CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at);

CREATE INDEX IF NOT EXISTS webhook_deliveries_owner ON webhook_deliveries(owner, created_at);

insert into webhook_endpoints (id, owner, url, secret, events, description, enabled, failures, disabled_reason, created_at, updated_at)
select
  w.id::text,
  w.user_id::text,
  w.url,
  w.secret,
  coalesce(array_to_json(w.events)::text, '["link.created","link.clicked"]'),
  '',
  case when w.disabled_at is null then 1 else 0 end,
  w.failures,
  case when w.disabled_at is null then null
   else 'switched off after ' || w.failures || ' failed deliveries in a row' || coalesce('; last: ' || w.last_error, '') end,
  (extract(epoch from w.created_at) * 1000)::bigint,
  (extract(epoch from coalesce(w.last_delivery_at, w.created_at)) * 1000)::bigint
from webhooks w
on conflict (id) do nothing;

alter table webhooks rename to webhooks_legacy;
