/**
 * The one module that reads the environment. Values are GETTERS, read on every
 * access, so tests can set process.env after import and the payments package
 * (copied verbatim between brands) never sees a snapshot taken by whichever
 * module imported config first.
 *
 * Secrets live in the logicsrc vault (wx93-me--prod) and reach the container
 * through the box's app.env, merged by deploy-app.sh. Nothing here loads a .env.
 */

const env = (name, fallback = '') => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${raw}`);
  return n;
};
const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

/**
 * Plans. Prices are in cents and are what the README and /pricing say.
 *
 * Free keeps the interstitial: it is how a free link pays for itself. Pro is for
 * a person who wants clean links and numbers. Automation is for agents and
 * businesses: bulk, webhooks, custom domains, and limits sized for scripts.
 */
export const PLANS = {
  free: {
    name: 'Free',
    monthCents: 0,
    yearCents: 0,
    linksPerMonth: 100,
    interstitial: true,
    aliases: false,
    stats: false,
    apiKeys: false,
    bulk: false,
    webhooks: false,
    domains: 0,
  },
  pro: {
    name: 'Pro',
    monthCents: 500,
    yearCents: 5000,
    linksPerMonth: 5_000,
    interstitial: false,
    aliases: true,
    stats: true,
    apiKeys: true,
    bulk: false,
    webhooks: false,
    domains: 0,
  },
  automation: {
    name: 'Automation',
    monthCents: 2900,
    yearCents: 29000,
    linksPerMonth: 100_000,
    interstitial: false,
    aliases: true,
    stats: true,
    apiKeys: true,
    bulk: true,
    webhooks: true,
    domains: 5,
  },
};

export const RANK = { free: 0, pro: 1, automation: 2 };

export const config = {
  get env() {
    return env('NODE_ENV', 'development');
  },
  get isProd() {
    return this.env === 'production';
  },
  get port() {
    return num('PORT', 3000);
  },
  /** The public origin. The passkey rpID comes from it, so changing it orphans every passkey. */
  get siteUrl() {
    return env('SITE_URL', 'http://localhost:3000').replace(/\/$/, '');
  },
  get host() {
    return new URL(this.siteUrl).hostname;
  },
  /**
   * Second short domains (9xq.me). Every code resolves on each of them exactly as
   * on the primary; anything that is not a short code 301s to the primary.
   */
  get altHosts() {
    return env('ALT_HOSTS', '9xq.me')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  },
  /** Every host that serves our own codes, primary first. */
  get shortHosts() {
    return [this.host, ...this.altHosts];
  },
  get adminEmails() {
    return env('ADMIN_EMAILS', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  },
  session: {
    get cookie() {
      return env('SESSION_COOKIE', 'wx93_session');
    },
    get ttlDays() {
      return num('SESSION_TTL_DAYS', 30);
    },
  },
  mail: {
    get enabled() {
      return Boolean(process.env.RESEND_API_KEY);
    },
    get resendKey() {
      return env('RESEND_API_KEY');
    },
    get from() {
      return env('MAIL_FROM', 'wx93 <noreply@wx93.me>');
    },
  },
  /** Pepper for hashing reporter addresses and signing form-guard tokens. Same on every instance. */
  get secret() {
    return env('APP_SECRET', env('COINPAY_WEBHOOK_SECRET', 'dev-only-secret'));
  },
  links: {
    /** Seconds the free interstitial waits before it follows the link. */
    get interstitialSeconds() {
      return num('INTERSTITIAL_SECONDS', 5);
    },
    get codeLength() {
      return num('CODE_LENGTH', 6);
    },
    /** Anonymous creates per address per hour. */
    get anonPerHour() {
      return num('ANON_LINKS_PER_HOUR', 20);
    },
    /** Distinct reporters before a link is pulled pending review. */
    get reportThreshold() {
      return num('REPORT_THRESHOLD', 3);
    },
  },
  /** Where the interstitial's ad comes from: `crawlproof` (default), `house` or `none`. */
  ads: {
    get provider() {
      return env('AD_PROVIDER', 'crawlproof');
    },
    get crawlproofSlot() {
      return env('CRAWLPROOF_SLOT', '');
    },
    get crawlproofSite() {
      return env('CRAWLPROOF_SITE', '');
    },
    get crawlproofFormat() {
      return env('CRAWLPROOF_FORMAT', 'text_link');
    },
  },
  abuse: {
    /** Google Safe Browsing v4 key. Optional: the open feeds run without one. */
    get safeBrowsingKey() {
      return env('SAFE_BROWSING_API_KEY');
    },
    get feeds() {
      return bool('THREAT_FEEDS', true);
    },
    get feedRefreshMinutes() {
      return num('THREAT_FEED_MINUTES', 360);
    },
  },
  /** DB-IP Lite country database (CC BY 4.0), baked into the image. */
  get geoipPath() {
    return env('GEOIP_DB', '/app/data/dbip-country-lite.mmdb');
  },
  coinpay: {
    get enabled() {
      return Boolean(process.env.COINPAY_API_KEY && process.env.COINPAY_BUSINESS_ID);
    },
    get baseUrl() {
      return env('COINPAY_API_URL', 'https://coinpayportal.com').replace(/\/$/, '');
    },
    get apiKey() {
      return env('COINPAY_API_KEY');
    },
    get businessId() {
      return env('COINPAY_BUSINESS_ID');
    },
    get webhookSecret() {
      return env('COINPAY_WEBHOOK_SECRET');
    },
    /** Chains the business holds wallets for (CoinPay refuses the rest at checkout). */
    get chains() {
      return env('COINPAY_CHAINS', 'USDC_POL,USDC_SOL,USDC_ETH,SOL,POL,ETH,BTC')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    },
    get defaultChain() {
      const chosen = env('COINPAY_CHAIN', 'USDC_POL').toUpperCase();
      return this.chains.includes(chosen) ? chosen : this.chains[0];
    },
  },
  /**
   * x402: an agent with no account pays per call. A pass costs priceCents and,
   * for passMinutes, lets its holder create up to passLinks ad-free links.
   */
  x402: {
    get scopedKey() {
      return env('COINPAY_X402_KEY');
    },
    get payTo() {
      return env('X402_PAY_TO');
    },
    get enabled() {
      return bool('X402_ENABLED', false) && Boolean(this.payTo && this.scopedKey);
    },
    get priceCents() {
      return num('X402_PRICE_CENTS', 25);
    },
    get passMinutes() {
      return num('X402_PASS_MINUTES', 60);
    },
    get passLinks() {
      return num('X402_PASS_LINKS', 100);
    },
    /** How long an x402-paid link stays ad-free. */
    get adFreeDays() {
      return num('X402_AD_FREE_DAYS', 365);
    },
  },
  throttle: {
    get limit() {
      return num('THROTTLE_LIMIT', 120);
    },
    get off() {
      return env('THROTTLE') === 'off';
    },
  },
};

/** Refuse to boot with a CoinPay key that cannot take money (a scoped cp_/cps_ key). */
export function assertCoinpayMerchantKey() {
  if (!config.coinpay.enabled) return;
  if (!/^cp_(live|test)_/.test(config.coinpay.apiKey)) {
    throw new Error(
      `COINPAY_API_KEY is not a merchant key: payments need cp_live_ or cp_test_, got ${config.coinpay.apiKey.slice(0, 8)}…`,
    );
  }
}
