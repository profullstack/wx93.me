/**
 * The pit.world network footer, fetched server side from
 * https://pit.world/snippets/footer.html and rendered as the last thing in
 * <body>, under wx93's own footer.
 *
 * The page templates are synchronous, so a middleware calls refreshFooter() and
 * the pages read the last good copy. It refetches at most hourly, gives up after
 * three seconds, and on any failure keeps the last copy (or renders nothing).
 */
const URL_ = 'https://pit.world/snippets/footer.html?site=wx93.me';
const TTL = 60 * 60 * 1000;

let current = '';
let fetchedAt = 0;
let inflight = null;

export const siteFooter = () => current;

export function refreshFooter() {
  if (Date.now() - fetchedAt < TTL) return Promise.resolve();
  inflight ??= (async () => {
    try {
      const res = await fetch(URL_, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const html = await res.text();
        if (html.includes('data-pit-footer')) current = html;
      }
    } catch {
      // Keep the last good footer.
    } finally {
      fetchedAt = Date.now();
      inflight = null;
    }
  })();
  return inflight;
}
