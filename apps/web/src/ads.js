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

/**
 * Our ad.network publisher unit on the home page. ad.network verifies the site by
 * finding the claim code in the raw HTML (the unit's attribute and the head meta).
 * The ad itself is a crawlproof frame, so it needs no script and passes the CSP.
 */
export const AD_NETWORK = { claim: '1Y56GiKE8eHj0t06', slot: 'fb195e7b-6641-49cc-8b7c-000647059aa9' };

export const adNetworkMeta = () => `<meta name="ad.network" content="${e(AD_NETWORK.claim)}">`;

export function homeAd() {
  const src = `https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(AD_NETWORK.slot)}&format=banner_300x250`;
  return `<aside class="home-ad" data-ad-network="${e(AD_NETWORK.claim)}" data-cp-ad data-slot="${e(AD_NETWORK.slot)}" data-format="banner_300x250" aria-label="Advertisement"><iframe src="${e(src)}" width="300" height="250" loading="lazy" style="border:0" title="Advertisement"></iframe></aside>`;
}

/**
 * The frame origins the CSP must allow. Site pages (`site`) always frame the
 * home page unit; the interstitial only needs the configured provider.
 */
export function adFrameOrigins({ site = false } = {}) {
  return site || (config.ads.provider === 'crawlproof' && config.ads.crawlproofSlot) ? ['https://crawlproof.com'] : [];
}
