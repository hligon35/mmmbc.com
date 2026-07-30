#!/usr/bin/env node

/**
 * Dry-run audit for gallery records imported from resized WordPress variants
 * (e.g. IMG_1234-2880x1800.jpg). This script never writes to production.
 *
 * Optional env for WP lookup:
 * - WP_BASE_URL
 * - WP_USERNAME
 * - WP_APP_PASSWORD
 *
 * Optional env:
 * - PUBLIC_GALLERY_URL (default: https://mmmbc.alphazonelabs.com/public/gallery.json)
 * - LIMIT (default: 200)
 */

const PUBLIC_GALLERY_URL = process.env.PUBLIC_GALLERY_URL || 'https://mmmbc.alphazonelabs.com/public/gallery.json';
const LIMIT = Number(process.env.LIMIT || 200);
const WP_BASE_URL = String(process.env.WP_BASE_URL || '').trim();
const WP_USERNAME = String(process.env.WP_USERNAME || '').trim();
const WP_APP_PASSWORD = String(process.env.WP_APP_PASSWORD || '').trim();

const resizeSuffixRegex = /^(.*)-([0-9]{2,5})x([0-9]{2,5})(\.[A-Za-z0-9]+)$/;

function toBasicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

function stripResizeSuffix(fileName) {
  const m = String(fileName || '').match(resizeSuffixRegex);
  if (!m) return null;
  return {
    baseName: m[1],
    width: Number(m[2]),
    height: Number(m[3]),
    extension: m[4]
  };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}\n${body.slice(0, 400)}`);
  }
  return res.json();
}

async function lookupWpOriginal(baseName) {
  if (!WP_BASE_URL || !WP_USERNAME || !WP_APP_PASSWORD) return null;

  const q = encodeURIComponent(baseName);
  const url = `${WP_BASE_URL.replace(/\/$/, '')}/wp-json/wp/v2/media?search=${q}&per_page=20`;
  const auth = toBasicAuth(WP_USERNAME, WP_APP_PASSWORD);

  const media = await fetchJson(url, {
    headers: {
      Authorization: auth,
      'User-Agent': 'mmmbc-gallery-audit/1.0'
    }
  });

  if (!Array.isArray(media) || !media.length) return null;

  const normalizedBase = baseName.toLowerCase();
  const candidate = media.find((item) => {
    const source = String(item?.source_url || '').toLowerCase();
    const filename = source.split('/').pop() || '';
    return filename.includes(normalizedBase);
  }) || media[0];

  return {
    wpId: candidate?.id || null,
    sourceUrl: String(candidate?.source_url || '').trim() || null,
    title: String(candidate?.title?.rendered || '').trim() || null
  };
}

async function main() {
  const payload = await fetchJson(`${PUBLIC_GALLERY_URL}?cb=${Date.now()}`);
  const items = Array.isArray(payload?.items) ? payload.items : [];

  const sized = items
    .map((item) => {
      const parsed = stripResizeSuffix(item?.originalName);
      if (!parsed) return null;
      return {
        id: item?.id,
        album: item?.album,
        label: item?.label,
        originalName: item?.originalName,
        file: item?.file,
        width: parsed.width,
        height: parsed.height,
        ratio: Number((parsed.width / parsed.height).toFixed(3)),
        baseName: parsed.baseName,
        extension: parsed.extension
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.ratio - a.ratio);

  const landscape = sized.filter((item) => item.width > item.height);
  const portrait = sized.filter((item) => item.height > item.width);
  const square = sized.filter((item) => item.height === item.width);

  const sample = landscape.slice(0, Math.max(1, LIMIT));
  const withWp = [];

  for (const item of sample) {
    const wp = await lookupWpOriginal(item.baseName);
    withWp.push({ ...item, wp });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    publicGalleryUrl: PUBLIC_GALLERY_URL,
    totalItems: items.length,
    resizedNameItems: sized.length,
    resizedLandscapeItems: landscape.length,
    resizedPortraitItems: portrait.length,
    resizedSquareItems: square.length,
    wpLookupEnabled: Boolean(WP_BASE_URL && WP_USERNAME && WP_APP_PASSWORD),
    candidates: withWp
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
