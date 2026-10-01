/**
 * RSI feed relay (Google Apps Script web app)
 *
 * Returns the latest RSI Comm-Link posts and Spectrum patch notes (Live/PTU) as JSON.
 * Exists because browsers can't fetch robertsspaceindustries.com cross-origin.
 *
 * Deploy:   Deploy → New deployment → Web app (Execute as: Me, Access: Anyone).
 *           Put the /exec URL in CONFIG.feedUrl in the site HTML.
 *           GET /exec should return {"ok": true, ...}.
 * Update:   Deploy → Manage deployments → Edit → Version: New version → Deploy.
 *           A new deployment would generate a new URL.
 */

const RSS_URL  = 'https://robertsspaceindustries.com/comm-link/rss';
const HUB_URL  = 'https://robertsspaceindustries.com/api/hub/getCommlinkItems';
const PAGE_URL = 'https://robertsspaceindustries.com/comm-link';
const PATCH_FORUM_ID = '190048';   // Spectrum › Star Citizen › Patch Notes
const SPECTRUM_API = 'https://robertsspaceindustries.com/api/spectrum/forum/channel/threads';
const PATCH_FORUM_URL = 'https://robertsspaceindustries.com/spectrum/community/SC/forum/' + PATCH_FORUM_ID;
const MAX_PATCHES = 6;
const MAX_ITEMS = 15;
const CACHE_SECONDS = 90;   // at most one upstream fetch per 90s, shared across all visitors

function doGet() {
  const cache = CacheService.getScriptCache();
  let body = cache.get('rsi-feed-v2');

  if (!body) {
    // Comm-Link news
    let newsSource = 'rss';
    let news = fromRss();
    if (!news) { newsSource = 'hub';  news = fromHub(); }
    if (!news) { newsSource = 'page'; news = fromPage(); }

    // Spectrum patch notes (Live + PTU)
    let patchSource = 'spectrum-api';
    let patches = fromSpectrumApi();
    if (!patches) { patchSource = 'spectrum-page'; patches = fromSpectrumPage(); }

    const seen = {};
    const items = (patches || []).concat(news || [])
      .filter(function (i) { if (seen[i.url]) return false; seen[i.url] = true; return true; })
      .sort(function (a, b) { return sortTime(b) - sortTime(a); })
      .slice(0, MAX_ITEMS);

    body = JSON.stringify({
      ok: items.length > 0,
      sources: { news: news ? newsSource : 'failed', patches: patches ? patchSource : 'failed' },
      checked: new Date().toISOString(),
      items: items
    });
    if (items.length) cache.put('rsi-feed-v2', body, CACHE_SECONDS);
  }

  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Spectrum patch notes ---------- */

/* Spectrum forum API (same endpoint the Spectrum web client uses) */
function fromSpectrumApi() {
  try {
    const res = UrlFetchApp.fetch(SPECTRUM_API, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Rsi-Token': '' },
      payload: JSON.stringify({ channel_id: PATCH_FORUM_ID, page: 1, sort: 'newest', label_id: null }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    const json = JSON.parse(res.getContentText());
    const threads = (json && json.data && (json.data.threads || json.data)) || [];
    if (!threads.length) return null;

    const items = threads
      .filter(function (t) { return t && t.subject && t.slug && !t.is_sticky; })
      .map(function (t) {
        const created = Number(t.time_created || t.time_modified || 0);
        return patchItem(clean(t.subject), PATCH_FORUM_URL + '/thread/' + t.slug,
                         created ? new Date(created < 1e12 ? created * 1000 : created).toISOString() : null);
      })
      .sort(function (a, b) { return sortTime(b) - sortTime(a); })
      .slice(0, MAX_PATCHES);
    return items.length ? items : null;
  } catch (e) {
    return null;
  }
}

/* Fallback: parse thread links from the forum page */
function fromSpectrumPage() {
  try {
    const res = UrlFetchApp.fetch(PATCH_FORUM_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const html = res.getContentText();
    const re = new RegExp('href="((?:https://robertsspaceindustries\\.com)?/spectrum/community/SC/forum/' + PATCH_FORUM_ID + '/thread/[^"#?]+)"[^>]*>([\\s\\S]*?)</a>', 'gi');
    const items = [], seen = {};
    let m;
    while ((m = re.exec(html)) && items.length < MAX_PATCHES) {
      const url = m[1].indexOf('http') === 0 ? m[1] : 'https://robertsspaceindustries.com' + m[1];
      const title = clean(m[2]);
      if (!title || seen[url]) continue;
      seen[url] = true;
      items.push(patchItem(title, url, null));
    }
    return items.length ? items : null;
  } catch (e) {
    return null;
  }
}

function patchItem(title, url, isoDate) {
  const env = /\bPTU\b/i.test(title) ? 'PTU' : /evocati/i.test(title) ? 'Evocati' : /hotfix/i.test(title) ? 'Hotfix' : 'Live';
  const wave = (title.match(/\[(wave\s*\d+)\]/i) || [])[1];
  const ver = (title.match(/\b(\d+\.\d+(?:\.\d+)?)\b/) || [])[1];
  const bits = [env + ' patch notes'];
  if (ver) bits.push('Alpha ' + ver);
  if (wave) bits.push(wave.replace(/\s+/, ' '));
  return {
    title: title,
    url: url,
    date: isoDate,
    label: isoDate ? null : 'Recent',
    type: 'patch',
    excerpt: bits.join(' · ') + '. Posted by CIG on Spectrum.'
  };
}

/* Sorting helpers: real dates first, "3 days ago" style labels approximated */
function sortTime(item) {
  if (item.date) { const t = Date.parse(item.date); if (!isNaN(t)) return t; }
  return agoToTime(item.label);
}
function agoToTime(label) {
  const m = String(label || '').match(/(\d+|an?|one)\s+(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return 0;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2].toLowerCase()];
  return Date.now() - n * unit;
}

/* 1) Official RSS feed */
function fromRss() {
  try {
    const res = UrlFetchApp.fetch(RSS_URL, {
      muteHttpExceptions: true,
      headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.1' }
    });
    if (res.getResponseCode() !== 200) return null;
    const text = res.getContentText();
    if (!/<rss[\s>]/i.test(text.slice(0, 1000))) return null;   // got a web page, not RSS

    const channel = XmlService.parse(text).getRootElement().getChild('channel');
    if (!channel) return null;

    const items = channel.getChildren('item').slice(0, MAX_ITEMS).map(function (i) {
      return {
        title: clean(i.getChildText('title')),
        url: i.getChildText('link'),
        date: i.getChildText('pubDate'),
        excerpt: trim(clean(i.getChildText('description')), 180)
      };
    }).filter(function (i) { return i.title && i.url; });
    return items.length ? items : null;
  } catch (e) {
    return null;
  }
}

/* 2) Comm-Link hub endpoint (used by the Comm-Link page) */
function fromHub() {
  try {
    const res = UrlFetchApp.fetch(HUB_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ channel: '', series: '', type: '', text: '', sort: 'publish_new', page: 1 }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    const json = JSON.parse(res.getContentText());
    return parseListing(json && json.data);
  } catch (e) {
    return null;
  }
}

/* 3) The Comm-Link web page itself */
function fromPage() {
  try {
    const res = UrlFetchApp.fetch(PAGE_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    return parseListing(res.getContentText());
  } catch (e) {
    return null;
  }
}

/* Pulls post links, titles and "posted" times out of RSI listing HTML */
function parseListing(html) {
  if (!html || typeof html !== 'string') return null;
  const items = [];
  const seen = {};
  const re = /<a[^>]+href="((?:https:\/\/robertsspaceindustries\.com)?\/(?:en\/)?comm-link\/[a-z-]+\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && items.length < MAX_ITEMS) {
    const href = m[1].indexOf('http') === 0 ? m[1] : 'https://robertsspaceindustries.com' + m[1];
    if (seen[href]) continue;
    const block = m[2];
    const title = clean(pick(block, 'title'));
    if (!title) continue;
    seen[href] = true;
    items.push({
      title: title,
      url: href,
      date: null,
      label: clean(pick(block, 'time_ago')).replace(/^posted:\s*/i, ''),
      excerpt: trim(clean(pick(block, 'body') || pick(block, 'description')), 180)
    });
  }
  return items.length ? items : null;
}

function pick(html, cls) {
  const re = new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)</', 'i');
  const m = html.match(re);
  return m ? m[1] : '';
}

function clean(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(n); })
    .replace(/\s+/g, ' ').trim();
}

function trim(s, n) {
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s;
}
