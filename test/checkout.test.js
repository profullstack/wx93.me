import { describe, expect, test } from 'bun:test';

process.env.SITE_URL ??= 'https://wx93.me';

const { config, PLANS } = await import('../apps/web/src/config.js');
const { planCheckout, planOptions, TIERS, CHECKOUT_ASSETS } = await import('../apps/web/src/checkout.js');

const user = { id: 42, email: 'buyer@example.test' };

/** A checkout whose `start` (startCheckout in the app) only records what it was asked. */
function wired({ tier = 'pro', who = user, amounts, start } = {}) {
  const calls = [];
  const checkout = planCheckout({
    tier,
    user: who,
    email: who?.email ?? '',
    amounts,
    start:
      start ??
      (async (...args) => {
        calls.push(args);
        return { checkout_url: 'https://coinpayportal.com/checkout/cs_test1', payment_ref: 'cs_test1' };
      }),
    onError: () => {},
  });
  return { checkout, calls };
}

const post = (checkout, fields, headers = {}) =>
  checkout.POST(
    new Request(`${config.siteUrl}/billing/checkout/pro`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: config.siteUrl, referer: `${config.siteUrl}/checkout/pro`, ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
  );

describe('the checkout page options', () => {
  test('two paid tiers, each with a year and a month at the listed price', () => {
    expect(TIERS).toEqual(['pro', 'automation']);
    const table = Object.fromEntries(TIERS.map((t) => [t, planOptions(t).map((o) => [o.id, o.cents, o.months, o.popular])]));
    expect(table).toEqual({
      pro: [['year', 5000, 12, true], ['month', 500, 1, false]],
      automation: [['year', 29000, 12, true], ['month', 2900, 1, false]],
    });
    for (const t of TIERS) {
      expect(planOptions(t).find((o) => o.id === 'month').cents).toBe(PLANS[t].monthCents);
      expect(planOptions(t).find((o) => o.id === 'year').cents).toBe(PLANS[t].yearCents);
    }
  });

  test('what the package will charge is the same cents, with the year preselected', () => {
    for (const t of TIERS) {
      const { checkout } = wired({ tier: t });
      expect(checkout.config.options.map((o) => [o.id, o.chargeCents])).toEqual([['year', PLANS[t].yearCents], ['month', PLANS[t].monthCents]]);
      expect(checkout.view({}).selected).toBe('year');
      expect(checkout.view({ query: 'plan=month' }).selected).toBe('month');
      expect(checkout.config.hasDiscount).toBe(false);
      expect(checkout.config.guarantee).toBe('');
    }
  });

  test('an upgrade shows the quoted amounts to the cent, and drops a term that is already covered', () => {
    const { checkout } = wired({ tier: 'automation', amounts: { month: 2567, year: 28667 } });
    expect(checkout.config.options.map((o) => [o.id, o.chargeCents])).toEqual([['year', 28667], ['month', 2567]]);
    expect(planOptions('automation', { month: 0, year: 26100 }).map((o) => o.id)).toEqual(['year']);
    expect(planOptions('automation', { month: 49, year: 49 })).toEqual([]);
  });

  test('free is not for sale', () => {
    expect(() => planOptions('free')).toThrow();
  });

  test('the stylesheet and the script are served as files', () => {
    expect(String(CHECKOUT_ASSETS['/assets/checkout.css'].body)).toContain('.pfc');
    expect(String(CHECKOUT_ASSETS['/assets/checkout.js'].body)).not.toMatch(/^\s*import\s/m);
  });
});

describe('paying from the checkout page', () => {
  test('startCheckout gets the session user, the tier, the term and the amount shown', async () => {
    for (const [term, cents] of [['year', 5000], ['month', 500]]) {
      const { checkout, calls } = wired();
      const res = await post(checkout, { option: term });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('https://coinpayportal.com/checkout/cs_test1');
      expect(calls).toEqual([[user, { plan: 'pro', term, expectCents: cents }]]);
    }
    const { checkout, calls } = wired({ tier: 'automation', amounts: { month: 2567, year: 28667 } });
    await post(checkout, { option: 'month' });
    expect(calls).toEqual([[user, { plan: 'automation', term: 'month', expectCents: 2567 }]]);
  });

  test('who pays is the session, never the form', async () => {
    const { checkout, calls } = wired();
    await post(checkout, { option: 'month', email: 'someone-else@example.test', account: '7', quantity: '9', amount: '1' });
    expect(calls).toEqual([[user, { plan: 'pro', term: 'month', expectCents: 500 }]]);
    // There are no discount codes here, so a posted one is refused, not honoured.
    const coded = await post(checkout, { option: 'month', code: 'FREE' });
    expect(coded.headers.get('location')).toContain('error=invalid_code');
    expect(calls.length).toBe(1);
  });

  test('signed out: to sign-in and back to the same selection, and nothing is opened', async () => {
    const { checkout, calls } = wired({ who: null });
    const res = await post(checkout, { option: 'month' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/signin?next=${encodeURIComponent('/checkout/pro?option=month')}`);
    expect(calls).toEqual([]);
  });

  test('a post from another site opens nothing', async () => {
    const { checkout, calls } = wired();
    const res = await post(checkout, { option: 'year' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('error=bad_origin');
    expect(calls).toEqual([]);
  });

  test('an option that is not listed opens nothing', async () => {
    const { checkout, calls } = wired();
    const res = await post(checkout, { option: 'lifetime' });
    expect(res.headers.get('location')).toContain('error=invalid_option');
    expect(calls).toEqual([]);
  });

  test('when startCheckout refuses, the buyer goes back to the page and is not sent anywhere else', async () => {
    const { checkout } = wired({
      start: async () => {
        throw new Error('checkout amount changed');
      },
    });
    const res = await post(checkout, { option: 'year' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/checkout/pro?option=year&error=payment_unavailable');
  });
});
