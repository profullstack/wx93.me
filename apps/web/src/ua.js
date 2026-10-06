/**
 * What is asking for a short link, from its User-Agent alone.
 *
 * Two decisions hang off this. A free link shows its interstitial only to a
 * person in a browser: a crawler, a link unfurler (Slack, iMessage, X, Discord…)
 * or a script gets the plain redirect, so previews keep working and nobody's
 * curl breaks. And stats separate people from machines.
 *
 * Erring matters asymmetrically. Calling a bot a browser shows a machine an ad
 * page, and a preview card breaks. Calling a browser a bot just skips one ad. So
 * anything that does not look like a mainstream browser is treated as a bot.
 */

// Unfurlers and crawlers that announce themselves. Checked before the browser
// test, because most of them also send "Mozilla/5.0 (compatible; ...)".
const BOTS =
  /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-external|embedly|quora link preview|outbrain|pinterest|vkshare|w3c_validator|whatsapp|telegrambot|discordbot|slackbot|slack-imgproxy|twitterbot|linkedinbot|skypeuripreview|redditbot|applebot|iframely|mastodon|pleroma|misskey|akkoma|bluesky|cardyb|snapchat|line\/|kakaotalk|viber|google-inspectiontool|googleother|feedfetcher|mediapartners|adsbot|bingpreview|yandex|baidu|duckduck|petalbot|ahrefs|semrush|mj12|dotbot|headlesschrome|phantomjs|lighthouse|preview|validator|monitor|uptime|pingdom|statuscake|python|curl|wget|httpie|go-http|java\/|okhttp|axios|node-fetch|undici|got\b|libwww|aiohttp|httpx|scrapy|postman|insomnia|deno|bun\//i;

// Link-preview fetchers specifically, for stats and for the HEAD/GET answer.
const UNFURLERS =
  /facebookexternalhit|twitterbot|slackbot|slack-imgproxy|discordbot|linkedinbot|telegrambot|whatsapp|skypeuripreview|applebot|iframely|embedly|redditbot|mastodon|pleroma|misskey|cardyb|bluesky|vkshare|pinterest|snapchat|google-inspectiontool|quora link preview/i;

export function classify(userAgent) {
  const ua = String(userAgent ?? '');
  const bot = !ua || BOTS.test(ua);
  const unfurler = UNFURLERS.test(ua);
  // A browser says Mozilla/5.0 and names an engine. Bots that pass for one are
  // caught above by name; the rest are people as far as we can tell.
  const browserLike = !bot && /^Mozilla\/5\.0 /.test(ua) && /(AppleWebKit|Gecko\/|Trident|Edg\/|Chrome\/|Firefox\/)/.test(ua);
  return {
    bot: bot || !browserLike,
    unfurler,
    browserLike,
    device: device(ua, bot || !browserLike),
    browser: browser(ua),
    os: os(ua),
  };
}

function device(ua, bot) {
  if (bot) return 'bot';
  if (/iPad|Tablet|Nexus (7|9|10)|SM-T|Kindle|Silk/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return 'mobile';
  if (/Android/i.test(ua)) return 'tablet';
  return 'desktop';
}

function browser(ua) {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  const m = /^([A-Za-z][\w.-]{1,30})\//.exec(ua);
  return m ? m[1].slice(0, 30) : 'Other';
}

function os(ua) {
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}

/** A browser prefetch or prerender is not a visit. */
export function isPrefetch(headers) {
  const purpose = `${headers.get('sec-purpose') ?? ''} ${headers.get('purpose') ?? ''} ${headers.get('x-moz') ?? ''}`;
  return /prefetch|prerender|preview/i.test(purpose);
}
