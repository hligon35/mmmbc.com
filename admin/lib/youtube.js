const http = require('http');
const https = require('https');

function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseVideoIdFromWatchUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const v = u.searchParams.get('v');
    return v ? String(v).trim() : '';
  } catch {
    return '';
  }
}

function httpGetFollow(urlStr, { headers = {}, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }

    const lib = url.protocol === 'http:' ? http : https;

    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers
      },
      (resp) => {
        const status = resp.statusCode || 0;
        const location = String(resp.headers.location || '').trim();

        if ([301, 302, 303, 307, 308].includes(status) && location && maxRedirects > 0) {
          const nextUrl = new URL(location, url).toString();
          resp.resume();
          httpGetFollow(nextUrl, { headers, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
          return;
        }

        let data = '';
        resp.setEncoding('utf8');
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
          resolve({ status, headers: resp.headers || {}, body: data, finalUrl: url.toString() });
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

async function detectYoutubeLiveVideo(channelId) {
  const url = `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`;
  const res = await httpGetFollow(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'MMMBC-Local/1.0'
    }
  });

  const fromUrl = parseVideoIdFromWatchUrl(res.finalUrl);
  if (fromUrl) return { isLive: true, videoId: fromUrl, source: 'redirect' };

  const html = String(res.body || '');
  const fromHtml = (html.match(/\"videoId\"\s*:\s*\"([a-zA-Z0-9_-]{11})\"/) || [])[1];
  if (fromHtml) {
    const indicatesLive = /isLiveContent\"\s*:\s*true|\"LIVE\"/i.test(html);
    if (indicatesLive) return { isLive: true, videoId: fromHtml, source: 'html' };
  }

  return { isLive: false, videoId: '', source: 'none' };
}

async function fetchYoutubeFeed(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const res = await httpGetFollow(url, {
    headers: {
      Accept: 'application/atom+xml,text/xml;q=0.9,*/*;q=0.1',
      'User-Agent': 'MMMBC-Local/1.0'
    }
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`YouTube feed fetch failed (${res.status})`);
  const xml = String(res.body || '');

  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const chunk = m[1] || '';
    const id = (chunk.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    if (!id) continue;
    const titleRaw = (chunk.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const published = (chunk.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    entries.push({
      id: String(id).trim(),
      title: decodeHtmlEntities(titleRaw).trim(),
      published: String(published).trim()
    });
    if (entries.length >= 30) break;
  }
  return entries;
}

module.exports = {
  detectYoutubeLiveVideo,
  fetchYoutubeFeed
};
