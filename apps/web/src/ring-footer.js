/**
 * The shared Profullstack footer (@profullstack/footer): copyright and the
 * webring nav, from the template published on jsDelivr @latest. It sits under
 * wx93's own footer row and above the pit.world footer.
 *
 * The page templates are synchronous, so a middleware refreshes the rendered
 * string (footerHtml caches the template for an hour) and the pages read the last
 * one. Until the first render, the bundled template stands in.
 */
import { createHash } from 'node:crypto';
import { footerHtml, footerHtmlSync, subscribeForm } from '@profullstack/footer';

const OPTIONS = { site: 'https://wx93.me/' };

/**
 * The CSP source for the footer's inline newsletter script (wireSubscribe, footer 0.4.0+), as
 * 'sha256-...'. The CSP has no 'unsafe-inline' and the footer is a cached string (no per-request
 * nonce), but the renderer emits the same script bytes every time, so its hash allows exactly it.
 */
export const FOOTER_SCRIPT_SRC = (() => {
  const m = subscribeForm(OPTIONS.site).match(/<script[^>]*>([\s\S]*?)<\/script>/);
  return m?.[1] ? `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'` : '';
})();

let current = footerHtmlSync(OPTIONS);

export const ringFooter = () => current;

export async function refreshRingFooter() {
  try {
    current = await footerHtml(OPTIONS);
  } catch {
    // Keep the last good footer.
  }
}
