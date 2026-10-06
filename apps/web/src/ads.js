import { config } from './config.js';

/**
 * The ad on a free link's interstitial. Pluggable, server-rendered, no script:
 * the interstitial has to work with JavaScript off, so the ad must too.
 *
 *   crawlproof  (default) CrawlProof house ads. The frame is plain HTML that
 *               crawlproof.com renders server-side, so it shows with JS off.
 *   house       our own static card, no third party at all.
 *   none        an empty slot (self-hosts that want the delay without an ad).
 *
 * A provider is a function returning an HTML fragment. Add one here and select
 * it with AD_PROVIDER.
 */

const e = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export const PROVIDERS = {
  crawlproof({ placement = 'interstitial' } = {}) {
    const slot = config.ads.crawlproofSlot;
    if (!slot) return PROVIDERS.house({ placement });
    const src = `https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(slot)}&format=${encodeURIComponent(config.ads.crawlproofFormat)}`;
    return `<div class="ad ad-${e(placement)}"><span class="ad-label">Sponsored</span><iframe src="${e(src)}" title="Sponsored" loading="eager" referrerpolicy="strict-origin-when-cross-origin" scrolling="no" sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe></div>`;
  },
  house({ placement = 'interstitial' } = {}) {
    return `<div class="ad ad-${e(placement)} ad-house"><span class="ad-label">From wx93</span><a href="${e(config.siteUrl)}/pricing" rel="sponsored"><strong>Links without this page.</strong> Pro is $5 a month, paid in crypto. Your links go straight through.</a></div>`;
  },
  none() {
    return '';
  },
};

export function renderAd(ctx = {}) {
  const provider = PROVIDERS[config.ads.provider] ?? PROVIDERS.crawlproof;
  return provider(ctx);
}

/** The frame origins the CSP must allow for the configured provider. */
export function adFrameOrigins() {
  return config.ads.provider === 'crawlproof' && config.ads.crawlproofSlot ? ['https://crawlproof.com'] : [];
}
