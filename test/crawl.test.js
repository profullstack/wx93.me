import { beforeAll, expect, test } from 'bun:test';

/** The crawl door: charged on wx93's own pages, never on a short link. No network. */
let app;
beforeAll(async () => {
  Object.assign(process.env, {
    SITE_URL: 'https://wx93.me',
    COINPAY_X402_KEY: 'cp_live_test_crawl_key',
    CRAWL_PAY_TO: '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5',
  });
  const { crawlGuard } = await import('../apps/web/src/throttle.js');
  // The guard only reads c.req.path and c.req.raw, so a bare context drives it
  // (hono is a workspace dependency of apps/web, not resolvable from test/).
  const guard = crawlGuard();
  app = {
    request: async (url, init) => {
      const raw = new Request(url, init);
      const c = { req: { path: new URL(raw.url).pathname, raw } };
      return guard(c, async () => new Response('page', { status: 200 }));
    },
  };
});

const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';

test('GPTBot pays for the home page, with a PAYMENT-REQUIRED header', async () => {
  const res = await app.request('https://wx93.me/', { headers: { 'user-agent': GPTBOT } });
  expect(res.status).toBe(402);
  expect(res.headers.get('payment-required')).toBeTruthy();
});

test('GPTBot follows a short link free', async () => {
  const res = await app.request('https://wx93.me/abc123', { headers: { 'user-agent': GPTBOT } });
  expect(res.status).toBe(200);
});

test('/crawl sells the day pass', async () => {
  const res = await app.request('https://wx93.me/crawl', { headers: { 'user-agent': 'curl/8', accept: 'application/json' } });
  expect(res.status).toBe(402);
  expect((await res.json()).accepts.length).toBeGreaterThan(0);
});

test('a browser reads the home page', async () => {
  const res = await app.request('https://wx93.me/', {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-dest': 'document',
    },
  });
  expect(res.status).toBe(200);
});
