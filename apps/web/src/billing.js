import { db } from '@wx93/db';
import { PLANS, RANK } from './config.js';

/**
 * Plans as paid periods. Payment is prepaid crypto (CoinPay), so nothing is ever
 * charged by itself: an account is on whatever plan a paid period covers right
 * now, and renewing is paying for the next one.
 *
 *   new / renew  the period starts when the last paid one ends (or now)
 *   upgrade      Pro -> Automation: starts now; unused Pro time is credited
 *   downgrade    Automation -> Pro: queued after the last paid period
 */

export const TERM_MS = { month: 30 * 86400_000, year: 365 * 86400_000 };
const priceOf = (plan, term) => PLANS[plan]?.[`${term}Cents`];

const periodsFor = (sql, userId) =>
  sql`select id, plan, term, starts_at, ends_at from plan_periods
      where user_id = ${userId} and ends_at > now() order by starts_at`;

/** The plan in force right now. Staff are Automation and never billed. */
export async function currentPlan(user, sql = db()) {
  if (user?.is_admin) return { key: 'automation', ...PLANS.automation, staff: true, paid_through: null };
  if (!user) return { key: 'free', ...PLANS.free, staff: false, paid_through: null };
  const [p] = await sql`
    select plan, ends_at from plan_periods
    where user_id = ${user.id} and starts_at <= now() and ends_at > now()
    order by case plan when 'automation' then 2 else 1 end desc, ends_at desc limit 1`;
  const key = p?.plan ?? 'free';
  return { key, ...PLANS[key], staff: false, paid_through: p?.ends_at ?? null };
}

/** What buying `target` for a `term` costs and does, right now. Pure apart from the read. */
export async function quote(user, target, term, sql = db()) {
  if (!PLANS[target] || target === 'free') throw new Error('plan is pro or automation');
  if (!TERM_MS[term]) throw new Error('term is month or year');
  const plan = await currentPlan(user, sql);
  const periods = plan.staff ? [] : await periodsFor(sql, user.id);
  return priceQuote({ now: Date.now(), current: plan.key, staff: plan.staff, periods, target, term });
}

/**
 * The arithmetic, separated so it can be tested without a database.
 * `periods` are the account's unexpired paid periods, oldest first.
 */
export function priceQuote({ now, current, staff, periods, target, term }) {
  const price = priceOf(target, term);
  if (staff) return { kind: 'staff', amount_cents: 0, credit_cents: 0, starts_at: null, ends_at: null };
  if (current === 'pro' && target === 'automation') {
    // Credit every unused Pro day, current and queued, at what was paid for it.
    let credit = 0;
    for (const p of periods.filter((x) => x.plan === 'pro')) {
      const start = Math.max(now, new Date(p.starts_at).getTime());
      const end = new Date(p.ends_at).getTime();
      if (end > start) credit += ((end - start) / TERM_MS[p.term]) * priceOf('pro', p.term);
    }
    credit = Math.min(price, Math.round(credit));
    return {
      kind: 'upgrade',
      amount_cents: Math.max(0, price - credit),
      credit_cents: credit,
      starts_at: new Date(now),
      ends_at: new Date(now + TERM_MS[term]),
    };
  }
  const last = periods.length ? new Date(periods[periods.length - 1].ends_at).getTime() : now;
  const start = Math.max(now, last);
  const kind = !periods.length && current === 'free' ? 'new' : RANK[target] < RANK[current] ? 'downgrade' : 'renew';
  return { kind, amount_cents: price, credit_cents: 0, starts_at: new Date(start), ends_at: new Date(start + TERM_MS[term]) };
}

/**
 * Turn one settled payment into a period, inside the webhook's transaction.
 * The timing is decided here, from the periods as they are when the money
 * lands, so a quote that sat in a tab for a day still lands right.
 */
export async function applyPurchase(tx, { userId, plan, term, kind, paymentId }) {
  if (!PLANS[plan] || plan === 'free' || !TERM_MS[term]) throw new Error('bad plan purchase');
  await tx`select pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))`;
  const already = await tx`select id from plan_periods where payment_id = ${paymentId}`;
  if (already.length) return null;
  const ms = TERM_MS[term];
  if (kind === 'upgrade') {
    await tx`delete from plan_periods where user_id = ${userId} and plan = 'pro' and starts_at > now()`;
    await tx`update plan_periods set ends_at = greatest(starts_at + interval '1 second', now())
             where user_id = ${userId} and plan = 'pro' and starts_at <= now() and ends_at > now()`;
    const [p] = await tx`
      insert into plan_periods (user_id, plan, term, starts_at, ends_at, payment_id)
      values (${userId}, ${plan}, ${term}, now(), now() + ${`${ms / 1000} seconds`}::interval, ${paymentId})
      returning plan, term, starts_at, ends_at`;
    return p;
  }
  const [{ last }] = await tx`
    select greatest(now(), coalesce(max(ends_at), now())) as last from plan_periods where user_id = ${userId}`;
  const [p] = await tx`
    insert into plan_periods (user_id, plan, term, starts_at, ends_at, payment_id)
    values (${userId}, ${plan}, ${term}, ${last}, ${last}::timestamptz + ${`${ms / 1000} seconds`}::interval, ${paymentId})
    returning plan, term, starts_at, ends_at`;
  return p;
}

export async function billingState(user, sql = db()) {
  const plan = await currentPlan(user, sql);
  const periods = plan.staff ? [] : await periodsFor(sql, user.id);
  return {
    plan: { key: plan.key, name: plan.name, staff: plan.staff, paid_through: plan.paid_through },
    periods: periods.map((p) => ({ plan: p.plan, term: p.term, starts_at: p.starts_at, ends_at: p.ends_at })),
    coverage_end: periods.length ? periods[periods.length - 1].ends_at : null,
  };
}
