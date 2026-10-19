/**
 * The shared Profullstack footer (@profullstack/footer): copyright and the
 * webring nav, from the template published on jsDelivr @latest. It sits under
 * wx93's own footer row.
 *
 * The page templates are synchronous, so a middleware refreshes the rendered
 * string (footerHtml caches the template for an hour) and the pages read the last
 * one. Until the first render, the bundled template stands in.
 */
import { footerHtml, footerHtmlSync } from '@profullstack/footer';

const OPTIONS = { site: 'https://wx93.me/' };

let current = footerHtmlSync(OPTIONS);

export const ringFooter = () => current;

export async function refreshRingFooter() {
  try {
    current = await footerHtml(OPTIONS);
  } catch {
    // Keep the last good footer.
  }
}
