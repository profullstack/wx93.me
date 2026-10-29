import { db } from '@wx93/db';
import { Affiliates, postgresStore as affiliateStore } from '@profullstack/affiliates';
import { Credits, postgresStore as creditStore } from '@profullstack/redeem-credits';
import disposable from 'disposable-email-domains' with { type: 'json' };
import { isPlaceholderEmail } from './coinpay.js';

/**
 * Credit codes and invites.
 *
 * A credit code (@profullstack/redeem-credits) grants `pro_days`: days of the Pro
 * plan. It does not keep a balance of its own: on redeem the days go straight into
 * plan_periods, the same table a paid month lands in, as one period keyed on
 * (user, source) so a retried grant never adds the days twice. The package's
 * credit_* tables hold only the hashed codes, who redeemed them, and an audit row.
 *
 * Invites (@profullstack/affiliates) are scarce: three per account, single use,
 * one accepted invite per account. A new account that signs up through one gets
 * INVITE_DAYS of Pro, and so does the person who invited them, once, if the new
 * account passes the abuse gates below.
 */

export const UNIT = 'pro_days';
export const INVITES_PER_ACCOUNT = 3;
export const INVITE_DAYS = 7;
/** Inviter bonuses per calendar month (UTC), whatever their quota says. */
export const INVITER_BONUSES_PER_MONTH = 3;
/** A link spent more than this long after the account row was made is not a sign-up. */
const NEW_ACCOUNT_MS = 15 * 60_000;
/** The invite cookie set on /i/<code>, read back when the emailed link is spent. */
export const INVITE_COOKIE = 'wx93_invite';
export const MAX_GRANT_DAYS = 3650;

/** postgres.js as the node-postgres `query(text, params) -> { rows }` both packages take. */
const pool = {
  async query(text, params) {
    const rows = params?.length ? await db().unsafe(text, params) : await db().unsafe(text);
    return { rows };
  },
};

let credits = null;
let affiliates = null;
export const getCredits = () => (credits ??= new Credits(creditStore(pool)));
export const getAffiliates = () => (affiliates ??= new Affiliates(affiliateStore(pool), { defaultQuota: INVITES_PER_ACCOUNT }));
/** Tests swap the clock-free singletons out between runs. */
export const resetCredits = () => {
  credits = null;
  affiliates = null;
};

/**
 * Days of Pro, as one plan period queued after whatever the account already has
 * (paid or granted), so a grant never shortens time somebody paid for.
 * Idempotent on (user, source): the second call returns null and adds nothing.
 */
export async function grantProDays(userId, days, source, sql = db()) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1 || n > MAX_GRANT_DAYS) throw new Error(`pro_days must be 1 to ${MAX_GRANT_DAYS}`);
  return sql.begin(async (tx) => {
    // The same lock applyPurchase takes, so a payment landing at the same moment queues behind us.
    await tx`select pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))`;
    const [{ last }] = await tx`
      select greatest(now(), coalesce(max(ends_at), now())) as last from plan_periods where user_id = ${userId}`;
    const [p] = await tx`
      insert into plan_periods (user_id, plan, term, starts_at, ends_at, grant_source)
      values (${userId}, 'pro', 'month', ${last}, ${last}::timestamptz + ${`${n} days`}::interval, ${source})
      on conflict (user_id, grant_source) where grant_source is not null do nothing
      returning plan, starts_at, ends_at`;
    return p ?? null;
  });
}

const REDEEM_WHY = {
  invalid: 'That code is not valid.',
  expired: 'That code has expired.',
  used_up: 'That code has already been used.',
  already_redeemed: 'You already redeemed that code.',
  revoked: 'That code was withdrawn.',
};

export class CodeError extends Error {
  constructor(reason) {
    super(REDEEM_WHY[reason] ?? 'That code did not work.');
    this.reason = reason;
  }
}

/** Redeem a credit code for a signed-in account. Returns the period it added. */
export async function redeemCode(user, code) {
  const input = String(code ?? '').trim();
  if (!input || input.length > 64) throw new CodeError('invalid');
  const r = await getCredits().redeem(input, user.id);
  if (!r.ok) throw new CodeError(r.reason);
  if (r.grant.unit !== UNIT) throw new Error(`code grants ${r.grant.unit}, not ${UNIT}`);
  const source = `code:${r.codeId}`;
  const period = await grantProDays(user.id, r.grant.amount, source);
  return { days: r.grant.amount, code_id: r.codeId, period };
}

/** Staff: mint a code worth `days` of Pro. The plaintext is returned once and never stored. */
export async function mintCode({ days, label = '', maxRedemptions = 1, expiresAt = null, createdBy = '' }) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1 || n > MAX_GRANT_DAYS) throw new Error(`days is 1 to ${MAX_GRANT_DAYS}`);
  const max = Math.floor(Number(maxRedemptions) || 1);
  if (max < 1 || max > 10_000) throw new Error('max redemptions is 1 to 10000');
  return getCredits().mint({ grant: { unit: UNIT, amount: n }, label: String(label).slice(0, 120), maxRedemptions: max, expiresAt, createdBy });
}

/* ------------------------------------------------------------------ abuse -- */

const DISPOSABLE = new Set(disposable.map((d) => d.toLowerCase()));
const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/** The mailbox an address delivers to: no +tag, and Gmail ignores dots. */
export function mailbox(email) {
  const [local = '', domain = ''] = String(email).trim().toLowerCase().split('@');
  let l = local.split('+')[0];
  let d = domain;
  if (GMAIL.has(d)) {
    l = l.replace(/\./g, '');
    d = 'gmail.com';
  }
  return `${l}@${d}`;
}

export function isDisposable(email) {
  const domain = String(email).trim().toLowerCase().split('@')[1] ?? '';
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  return false;
}

/**
 * Why a just-made account may not take an invite bonus, or null. The invite itself
 * is only spent when this is null, so a refused invite stays usable by somebody else.
 */
export async function inviteProblem(user, { created }, sql = db()) {
  if (!created || Date.now() - new Date(user.created_at).getTime() > NEW_ACCOUNT_MS) return 'invites are for new accounts';
  if (user.is_admin) return 'staff accounts do not take invites';
  if (isDisposable(user.email)) return 'throwaway email addresses cannot take an invite';
  // A CoinPay-only account has no verified email (its address is our placeholder).
  if (isPlaceholderEmail(user.email)) return 'invites need an account made with a verified email';
  // Another account on the same mailbox (a +tag or Gmail dot alias) is the same person.
  const box = mailbox(user.email);
  const others = await sql`select email from users where id <> ${user.id} and split_part(lower(email), '@', 2) = ${user.email.toLowerCase().split('@')[1]}`;
  if (others.some((o) => mailbox(o.email) === box)) return 'this mailbox already has an account';
  if (GMAIL.has(box.split('@')[1])) {
    const gm = await sql`select email from users where id <> ${user.id} and split_part(lower(email), '@', 2) in ('gmail.com', 'googlemail.com')`;
    if (gm.some((o) => mailbox(o.email) === box)) return 'this mailbox already has an account';
  }
  return null;
}

/**
 * A new account signed in through an invite. The invite is spent, and the bonus
 * goes to both sides: always to the new account, and to the inviter while they
 * are under the monthly cap and are not the same mailbox.
 * Returns { ok, reason?, days?, inviterDays? }. Never throws for a bad invite.
 */
export async function acceptInvite(user, code, { created }, sql = db()) {
  const problem = await inviteProblem(user, { created }, sql);
  if (problem) return { ok: false, reason: problem };
  const r = await getAffiliates().redeemInvite(String(code ?? '').slice(0, 64), user.id);
  if (!r.ok) return { ok: false, reason: r.reason };
  const [inviter] = await sql`select id, email from users where id = ${r.inviterId}`;
  // Exactly once per invitee: the row is the record, and the primary key the guard.
  const [row] = await sql`
    insert into invite_bonuses (invitee_id, inviter_id, invite_id, days)
    values (${user.id}, ${r.inviterId}, ${r.inviteId}, ${INVITE_DAYS})
    on conflict (invitee_id) do nothing returning invitee_id`;
  if (!row) return { ok: false, reason: 'already_invited' };
  await grantProDays(user.id, INVITE_DAYS, `invited-by:${r.inviterId}`, sql);
  let inviterDays = 0;
  if (inviter && mailbox(inviter.email) !== mailbox(user.email)) {
    const [{ n }] = await sql`
      select count(*)::int as n from invite_bonuses
      where inviter_id = ${r.inviterId} and inviter_paid and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`;
    if (n < INVITER_BONUSES_PER_MONTH) {
      await grantProDays(r.inviterId, INVITE_DAYS, `invited:${user.id}`, sql);
      await sql`update invite_bonuses set inviter_paid = true where invitee_id = ${user.id}`;
      inviterDays = INVITE_DAYS;
    }
  }
  return { ok: true, days: INVITE_DAYS, inviterDays, inviterId: r.inviterId };
}

/** The account's invites, newest first, with how many it has left. */
export async function inviteState(userId) {
  const aff = getAffiliates();
  const [quota, invites, bonuses] = await Promise.all([
    aff.quota(userId),
    aff.invites(userId),
    db()`select count(*)::int as n from invite_bonuses where inviter_id = ${userId}`,
  ]);
  return { quota, invites, accepted: bonuses[0].n };
}

/** A plain inviter-facing view of one invite (never the hash, never the invitee's email). */
export const publicInvite = (i) => ({
  id: i.id,
  note: i.note,
  created_at: new Date(i.createdAt).toISOString(),
  expires_at: i.expiresAt ? new Date(i.expiresAt).toISOString() : null,
  used: Boolean(i.usedBy),
  used_at: i.usedAt ? new Date(i.usedAt).toISOString() : null,
  revoked: Boolean(i.revokedAt),
});

/** Codes typed into a URL: the invite alphabet plus dashes, nothing else. */
export const INVITE_PATH = /^[A-Za-z0-9-]{4,40}$/;
