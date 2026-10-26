-- Credit codes and invites (apps/web/src/credits.js).
--
-- A redeemed code or an invite bonus is days of Pro, written into plan_periods like
-- a paid month. grant_source names where the days came from ("code:<id>",
-- "invited-by:<user>", "invited:<user>") and is unique per account, so a retried
-- grant adds nothing. Granted periods are never credited as money on an upgrade.
alter table plan_periods add column if not exists grant_source text;
create unique index if not exists plan_periods_grant_key on plan_periods (user_id, grant_source) where grant_source is not null;

-- The invite a sign-in link was asked for with, so opening the email in another
-- browser still counts it. Cleared when the link is spent.
alter table login_tokens add column if not exists invite text;

-- One row per account that joined through an invite: the bonus is paid once, and
-- the inviter's monthly cap counts these. The hashed codes themselves live in the
-- @profullstack/affiliates aff_* tables (created by the package on first use).
create table if not exists invite_bonuses (
  invitee_id   uuid primary key references users(id) on delete cascade,
  inviter_id   uuid not null references users(id) on delete cascade,
  invite_id    text not null,
  days         int not null,
  inviter_paid boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists invite_bonuses_inviter_idx on invite_bonuses (inviter_id, created_at);
