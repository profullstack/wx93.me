-- Sign in with CoinPay: a wx93 account bound to a CoinPay account by its OIDC
-- `sub`, never by email (CoinPay never verifies emails). One CoinPay account per
-- user and one user per CoinPay account.
--
-- created_via = 'connect': linked from /account while signed in (the account
--   keeps its own, magic-link-proven email).
-- created_via = 'signup': a first CoinPay login made the account; its users.email
--   is a random placeholder under coinpay-users.wx93.me. coinpay_email is
--   UNVERIFIED contact info and is never used to find or sign in to an account.
create table if not exists coinpay_identities (
  user_id       uuid primary key references users(id) on delete cascade,
  coinpay_sub   text not null unique,
  coinpay_email text,
  coinpay_name  text,
  created_via   text not null check (created_via in ('connect', 'signup')),
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
