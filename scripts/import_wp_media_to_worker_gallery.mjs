#!/usr/bin/env node
/**
 * Import WordPress Media Library images into the MMMBC Worker gallery.
 *
 * Best-quality / most efficient approach:
 * - Use WordPress REST API (authenticated) to list attachments + find the largest/original image URL.
 * - Download the image bytes.
 * - Upload into the Worker gallery endpoint (/api/gallery/upload), which writes to R2 + D1.
 *
 * Requirements:
 * - Node.js 18+ (global fetch/FormData)
 * - A WordPress Application Password (WP admin user -> Profile -> Application Passwords)
 * - Cloudflare Access Service Token if /api* is protected by Access.
 *
 * Env vars:
 *   WP_BASE_URL                 e.g. https://mmmbc.com
 *   WP_USERNAME                 e.g. admin@...
 *   WP_APP_PASSWORD             the WP Application Password (NOT your normal password)
 *   TARGET_BASE_URL             e.g. https://mmmbc-preview.hligon.workers.dev
 *   CF_ACCESS_CLIENT_ID         (optional) Access Service Token client id
 *   CF_ACCESS_CLIENT_SECRET     (optional) Access Service Token client secret
 *   ALBUM_MODE                  year-month | year | wordpress-month (default: year-month)
 *   PER_PAGE                    (default: 100)
 *   START_PAGE                  (default: 1)
 *   MAX_PAGES                   (default: 1000)
 *   MAX_ITEMS                   (default: 0 = no limit)
 *   DRY_RUN                     true/false (default: false)
 *   SLEEP_MS                    delay between uploads (default: 250)
 */

import { setTimeout as sleep } from 'node:timers/promises';

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

function boolEnv(name, def = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function numEnv(name, def) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function sanitizeAlbum(input) {
  return String(input || '')
    .trim()
    .replace(/[^a-zA-Z0-9\- _]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'Imported';
}

function stripHtml(input) {
  return String(input || '').replace(/<[^>]*>/g, '').trim();
}

function base64Basic(user, pass) {
  // WP App Passwords are used via basic auth.
  const raw = `${user}:${pass}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function bestImageUrl(media) {
  // Always prefer the original media source when available.
  // WP resized variants often include "-WIDTHxHEIGHT" suffixes (e.g. -2880x1800)
  // which can be cropped/derived assets rather than the true original.
  const source = media?.source_url ? String(media.source_url).trim() : '';
  if (source) return source;

  // Fallback: choose the largest available derivative.
  const md = media?.media_details;
  const sizes = md?.sizes && typeof md.sizes === 'object' ? md.sizes : null;
  let best = '';
  let bestArea = 0;

  if (sizes) {
    for (const key of Object.keys(sizes)) {
      const s = sizes[key];
      const url = s?.source_url ? String(s.source_url) : '';
      const w = Number(s?.width || 0);
      const h = Number(s?.height || 0);
      const area = Number.isFinite(w) && Number.isFinite(h) ? w * h : 0;
      if (url && area >= bestArea) {
        bestArea = area;
        best = url;
      }
    }
  }

  return best;
}

function inferFileName(url, fallback = 'image.jpg') {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').pop() || '').trim();
    return base || fallback;
  } catch {
    return fallback;
  }
}

function albumForMedia(media, albumMode) {
  const date = String(media?.date_gmt || media?.date || '').trim();
  const yyyy = date.slice(0, 4);
  const mm = date.slice(5, 7);

  if (albumMode === 'year') {
    return sanitizeAlbum(yyyy || 'Imported');
  }

  if (albumMode === 'wordpress-month') {
    // Common WP structure: uploads/YYYY/MM
    if (yyyy && mm) return sanitizeAlbum(`${yyyy}/${mm}`);
    return 'Imported';
  }

  // default: year-month
  if (yyyy && mm) return sanitizeAlbum(`${yyyy}-${mm}`);
  return 'Imported';
}

async function wpFetchJson(url, { authHeader }) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      'User-Agent': 'mmmbc-importer/1.0'
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`WP request failed ${res.status} ${res.statusText} for ${url}\n${txt.slice(0, 500)}`);
  }

  return res.json();
}

async function downloadFile(url) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'mmmbc-importer/1.0'
    }
  });

  if (!res.ok) {
    throw new Error(`Download failed ${res.status} ${res.statusText} for ${url}`);
  }

  const ct = res.headers.get('content-type') || 'application/octet-stream';
  const ab = await res.arrayBuffer();
  return { contentType: ct, arrayBuffer: ab };
}

async function uploadToWorker({ targetBaseUrl, album, label, tags, fileName, contentType, arrayBuffer, accessHeaders, dryRun }) {
  const uploadUrl = new URL('/api/gallery/upload', targetBaseUrl).toString();

  if (dryRun) {
    return { ok: true, dryRun: true, uploadUrl, album, label, tags, fileName };
  }

  const form = new FormData();
  form.set('album', album);
  form.set('label', label);
  form.set('tags', tags);

  const blob = new Blob([arrayBuffer], { type: contentType || 'application/octet-stream' });
  form.append('images', blob, fileName);

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...accessHeaders
    },
    body: form
  });

  const respCt = res.headers.get('content-type') || '';
  const txt = await res.text().catch(() => '');

  // Cloudflare Access may return an HTML login page with 200.
  // In that case, the request never reached the Worker, so treat it as a hard failure.
  if (
    res.ok
    && respCt.toLowerCase().includes('text/html')
    && /cloudflare\s+access/i.test(txt)
  ) {
    throw new Error(
      `Upload blocked by Cloudflare Access (received HTML login page) for ${fileName}.`
      + `\nFix: allow your Access Service Token for this app/path, or temporarily disable Access on /api/gallery/* during migration.`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Upload failed ${res.status} ${res.statusText} for ${fileName}`
      + `\nContent-Type: ${respCt || '(none)'}`
      + `\n${txt.slice(0, 800)}`
    );
  }

  // Some intermediaries return HTML (e.g. Access/login) even with 200.
  // Always try to parse JSON, but keep a snippet for debugging when parsing fails.
  try {
    return JSON.parse(txt);
  } catch {
    return {
      ok: true,
      nonJson: true,
      status: res.status,
      contentType: respCt,
      bodySnippet: txt.slice(0, 300)
    };
  }
}

async function main() {
  const wpBase = requireEnv('WP_BASE_URL').replace(/\/$/, '');
  const wpUser = requireEnv('WP_USERNAME');
  const wpAppPass = requireEnv('WP_APP_PASSWORD');
  const targetBaseUrl = requireEnv('TARGET_BASE_URL').replace(/\/$/, '');

  const dryRun = boolEnv('DRY_RUN', false);
  const albumMode = String(process.env.ALBUM_MODE || 'year-month').trim();
  const perPage = numEnv('PER_PAGE', 100);
  const startPage = numEnv('START_PAGE', 1);
  const maxPages = numEnv('MAX_PAGES', 1000);
  const maxItems = numEnv('MAX_ITEMS', 0);
  const sleepMs = numEnv('SLEEP_MS', 250);

  const accessHeaders = {};
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    accessHeaders['CF-Access-Client-Id'] = String(process.env.CF_ACCESS_CLIENT_ID);
    accessHeaders['CF-Access-Client-Secret'] = String(process.env.CF_ACCESS_CLIENT_SECRET);
  }

  const authHeader = `Basic ${base64Basic(wpUser, wpAppPass)}`;

  let imported = 0;
  for (let page = startPage; page < startPage + maxPages; page += 1) {
    const url = new URL('/wp-json/wp/v2/media', wpBase);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('orderby', 'date');
    url.searchParams.set('order', 'asc');
    url.searchParams.set('media_type', 'image');
    // context=edit often returns richer metadata; requires auth.
    url.searchParams.set('context', 'edit');

    let items;
    try {
      items = await wpFetchJson(url.toString(), { authHeader });
    } catch (err) {
      // WP returns 400 when page is out of range.
      const msg = String(err?.message || err);
      if (msg.includes('rest_post_invalid_page_number') || msg.includes('400')) {
        break;
      }
      throw err;
    }

    if (!Array.isArray(items) || items.length === 0) break;

    for (const media of items) {
      if (maxItems > 0 && imported >= maxItems) break;

      const mime = String(media?.mime_type || '');
      if (!mime.startsWith('image/')) continue;

      const urlBest = bestImageUrl(media);
      if (!urlBest) continue;

      const album = albumForMedia(media, albumMode);
      const label = stripHtml(media?.title?.rendered || media?.alt_text || media?.slug || '') || album;
      const tags = '';
      const fileName = inferFileName(urlBest, `wp_${media?.id || 'image'}.jpg`);

      process.stdout.write(`Importing [${album}] ${fileName} ... `);

      const dl = await downloadFile(urlBest);
      const result = await uploadToWorker({
        targetBaseUrl,
        album,
        label,
        tags,
        fileName,
        contentType: dl.contentType,
        arrayBuffer: dl.arrayBuffer,
        accessHeaders,
        dryRun
      });

      imported += 1;
      if (dryRun) {
        process.stdout.write('DRY RUN\n');
      } else {
        if (result?.nonJson) {
          process.stdout.write(
            `OK (non-JSON response; status ${result.status}; ct ${result.contentType || 'n/a'})\n`
          );
          process.stdout.write(
            `  HINT: This often means Cloudflare Access returned HTML (login/forbidden) or you hit a non-Worker endpoint.\n`
          );
          if (result.bodySnippet) {
            process.stdout.write(`  BODY: ${String(result.bodySnippet).replace(/\s+/g, ' ').slice(0, 160)}\n`);
          }
          if (sleepMs > 0) await sleep(sleepMs);
          continue;
        }

        const added = Array.isArray(result?.added) ? result.added : [];
        const location = added[0]?.file || '';
        if (location) {
          process.stdout.write(`OK -> ${location}\n`);
          if (!String(location).startsWith('/cdn/gallery/')) {
            process.stdout.write(
              `  WARNING: Response does not look like Worker R2 CDN path. Check TARGET_BASE_URL (may be pointing at the Node admin server).\n`
            );
          }
        } else {
          process.stdout.write('OK\n');
        }
      }

      if (sleepMs > 0) await sleep(sleepMs);
    }

    if (maxItems > 0 && imported >= maxItems) break;
  }

  console.log(`\nDone. Imported ${imported} images into ${targetBaseUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
