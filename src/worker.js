// Cloudflare Worker (Option B scaffold)
// - Serves static site assets from ./cf_site via env.ASSETS
// - Implements gallery API + CDN endpoints using D1 + R2
//
// Auth model (Cloudflare-native): protect /admin and /api via Cloudflare Access.
// When Access is enabled, Cloudflare injects cf-access-authenticated-user-email.

import { EmailMessage } from 'cloudflare:email';

function applySecurityHeaders(headers, { isHttps = true } = {}) {
  const setIfMissing = (k, v) => {
    try {
      if (!headers.has(k)) headers.set(k, v);
    } catch {
      // ignore
    }
  };

  setIfMissing('X-Content-Type-Options', 'nosniff');
  setIfMissing('Referrer-Policy', 'strict-origin-when-cross-origin');
  setIfMissing('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Only meaningful on HTTPS.
  if (isHttps) {
    setIfMissing('Strict-Transport-Security', 'max-age=15552000');
  }
}

function json(resBody, { status = 200, headers = {} } = {}) {
  const mergedHeaders = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  applySecurityHeaders(mergedHeaders);
  return new Response(JSON.stringify(resBody), {
    status,
    headers: mergedHeaders
  });
}

function text(body, { status = 200, headers = {} } = {}) {
  const mergedHeaders = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers
  });
  applySecurityHeaders(mergedHeaders);
  return new Response(body, {
    status,
    headers: mergedHeaders
  });
}

function canonicalHost(env) {
  // Optional: set this when you move from *.workers.dev to your real domain.
  // Example: CANONICAL_HOST=mmmbc.com
  return String(env.CANONICAL_HOST || '').trim().toLowerCase();
}

function sanitizeSegment(input) {
  return String(input || '')
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function sanitizePrefix(input, { fallback = 'gallery/', ensureTrailingSlash = false } = {}) {
  const raw = String(input || '').trim();
  // Allow only path-ish characters; keep '/' so we can browse prefixes.
  let cleaned = raw.replace(/[^a-zA-Z0-9/_-]/g, '');
  cleaned = cleaned.replace(/^\/+/, '');
  if (!cleaned) cleaned = fallback;
  if (ensureTrailingSlash && !cleaned.endsWith('/')) cleaned += '/';
  return cleaned;
}

function youtubeChannelId(env) {
  return String(env.YOUTUBE_CHANNEL_ID || 'UCkAaHiYmUKIdKePifg1D2pg').trim();
}

function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchYoutubeFeed(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/atom+xml,text/xml;q=0.9,*/*;q=0.1',
      'User-Agent': 'MMMBC-Worker/1.0'
    }
  });
  if (!resp.ok) throw new Error(`YouTube feed fetch failed (${resp.status})`);
  const xml = await resp.text();

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

function parseVideoIdFromWatchUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const v = u.searchParams.get('v');
    return v ? String(v).trim() : '';
  } catch {
    return '';
  }
}

async function detectYoutubeLiveVideo(channelId) {
  const url = `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`;
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'MMMBC-Worker/1.0'
    }
  });

  const finalUrl = String(resp.url || url);
  const fromUrl = parseVideoIdFromWatchUrl(finalUrl);
  if (fromUrl) return { isLive: true, videoId: fromUrl, source: 'redirect' };

  // Fallback: some setups may not redirect. Try a best-effort parse.
  const html = await resp.text().catch(() => '');
  const fromHtml = (html.match(/\"videoId\"\s*:\s*\"([a-zA-Z0-9_-]{11})\"/) || [])[1];
  if (fromHtml) {
    // We can't reliably tell if it's live from HTML alone without a full parse.
    // Only treat this as live if the /live page strongly indicates live content.
    const indicatesLive = /isLiveContent\"\s*:\s*true|\"LIVE\"/i.test(html);
    if (indicatesLive) return { isLive: true, videoId: fromHtml, source: 'html' };
  }

  return { isLive: false, videoId: '', source: 'none' };
}

async function handlePublicYoutube(request, env) {
  const channelId = youtubeChannelId(env);

  let live = { isLive: false, videoId: '', source: 'none' };
  let videos = [];
  let errors = [];

  try {
    live = await detectYoutubeLiveVideo(channelId);
  } catch (e) {
    errors.push({ type: 'live', error: String(e?.message || e).slice(0, 200) });
  }

  try {
    videos = await fetchYoutubeFeed(channelId);
  } catch (e) {
    errors.push({ type: 'feed', error: String(e?.message || e).slice(0, 200) });
  }

  // YouTube feeds can include scheduled/upcoming livestream entries. Embedding those
  // often shows a "Live stream offline" state. Prefer videos already published.
  if (Array.isArray(videos) && videos.length) {
    const now = Date.now();
    const graceMs = 5 * 60 * 1000;
    const published = videos.filter((v) => {
      const t = Date.parse(String(v?.published || ''));
      return Number.isFinite(t) && t <= (now + graceMs);
    });
    if (published.length) videos = published;
  }

  return json(
    {
      ok: true,
      channelId,
      live,
      videos,
      fetchedAt: new Date().toISOString(),
      errors
    },
    {
      headers: {
        // Keep this fresh so it can flip quickly when you start streaming.
        'Cache-Control': 'public, max-age=60'
      }
    }
  );
}

function splitTags(raw) {
  return String(raw || '')
    .split(',')
    .map((t) => sanitizeSegment(t).toLowerCase())
    .filter(Boolean)
    .slice(0, 25);
}

function tryParseJwtPayload(jwt) {
  const token = String(jwt || '').trim();
  const parts = token.split('.');
  if (parts.length < 2) return null;

  const b64url = parts[1];
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (b64.length % 4)) % 4;
  const padded = b64 + '='.repeat(padLen);

  try {
    const jsonStr = atob(padded);
    const payload = JSON.parse(jsonStr);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function getAccessJwt(request) {
  return (
    getHeaderTrim(request, 'cf-access-jwt-assertion')
    || getHeaderTrim(request, 'Cf-Access-Jwt-Assertion')
    || ''
  ).trim();
}

function getAccessEmailHeaderOnly(request) {
  return (
    request.headers.get('cf-access-authenticated-user-email')
    || request.headers.get('Cf-Access-Authenticated-User-Email')
    || ''
  ).trim().toLowerCase();
}

function getAccessEmail(request) {
  const headerEmail = getAccessEmailHeaderOnly(request);
  if (headerEmail) return headerEmail;

  // Some Access setups do not forward the email header, but DO forward a JWT assertion.
  // In that case, derive email from the JWT payload.
  const jwt = getAccessJwt(request);
  if (!jwt) return '';

  const payload = tryParseJwtPayload(jwt);
  const email = String(payload?.email || payload?.user_email || payload?.upn || '').trim().toLowerCase();
  return email;
}

function hasAccessSessionCookie(request) {
  const cookie = String(request.headers.get('cookie') || '');
  return (
    /(?:^|;\s*)CF_Authorization(?:_[^=]+)?=/.test(cookie)
    || /(?:^|;\s*)CF_AppSession=/.test(cookie)
  );
}

function allowList(env) {
  const raw = String(env.ADMIN_ALLOW_EMAILS || '').trim();
  if (!raw) return null;
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isDevBypass(env) {
  const raw = String(env.DEV_BYPASS_AUTH || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function allowServiceTokenAdmin(env) {
  const raw = String(env.ALLOW_SERVICE_TOKEN_ADMIN || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function getHeaderTrim(request, name) {
  return String(request.headers.get(name) || '').trim();
}

function hasServiceTokenHeaders(request) {
  // Cloudflare Access service tokens are presented via these headers.
  const id = getHeaderTrim(request, 'CF-Access-Client-Id') || getHeaderTrim(request, 'cf-access-client-id');
  const secret = getHeaderTrim(request, 'CF-Access-Client-Secret') || getHeaderTrim(request, 'cf-access-client-secret');
  return Boolean(id) && Boolean(secret);
}

function hasValidServiceToken(request, env) {
  // Support server-to-server auth for local admin proxying.
  // If these are set as Worker secrets/vars, we validate and allow.
  const expectedId = String(env.CF_ACCESS_CLIENT_ID || '').trim();
  const expectedSecret = String(env.CF_ACCESS_CLIENT_SECRET || '').trim();
  if (!expectedId || !expectedSecret) return false;

  const id = getHeaderTrim(request, 'CF-Access-Client-Id') || getHeaderTrim(request, 'cf-access-client-id');
  const secret = getHeaderTrim(request, 'CF-Access-Client-Secret') || getHeaderTrim(request, 'cf-access-client-secret');
  if (!id || !secret) return false;

  return id === expectedId && secret === expectedSecret;
}

function hasAccessJwtAssertion(request) {
  return Boolean(getAccessJwt(request));
}

function requireAdmin(request, env) {
  if (isDevBypass(env)) return { ok: true, email: 'dev@local' };

  // Strong path: validate the service token headers against Worker secrets.
  if (hasValidServiceToken(request, env)) {
    return { ok: true, email: 'service-token@access' };
  }

  // Allow Access Service Tokens (useful for automation/migrations) when enabled.
  // NOTE: If Cloudflare Access is in front of this Worker, it will validate the
  // service token at the edge and typically inject a JWT assertion header.
  // In that case we can allow without having the token values in Worker env.
  if (allowServiceTokenAdmin(env) && hasServiceTokenHeaders(request) && hasAccessJwtAssertion(request)) {
    return { ok: true, email: 'service-token@access' };
  }

  const email = getAccessEmail(request);
  if (!email) return { ok: false, error: 'Unauthorized (Cloudflare Access required)' };
  const allow = allowList(env);
  if (allow && !allow.has(email)) return { ok: false, error: 'Forbidden' };
  return { ok: true, email };
}

async function handleSupportMessage(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const body = await request.json().catch(() => null);
  const subjectRaw = String(body?.subject || '').trim();
  const messageRaw = String(body?.message || '').trim();
  const replyToRaw = String(body?.replyTo || '').trim();

  if (!subjectRaw || !messageRaw) return json({ error: 'Subject and message are required.' }, { status: 400 });

  const subject = subjectRaw.slice(0, 140);
  const message = messageRaw.slice(0, 5000);
  const replyTo = replyToRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyToRaw) ? replyToRaw : '';

  const toEmail = String(env.SUPPORT_TO_EMAIL || 'support@hldesignedit.com').trim();
  // Cloudflare send_email requires the destination address to be verified and it must
  // match the binding's destination_address. Use SUPPORT_EMAIL_DESTINATION for actual
  // delivery, while keeping the visible "To:" header as SUPPORT_TO_EMAIL.
  const deliveryToEmail = String(env.SUPPORT_EMAIL_DESTINATION || toEmail).trim();
  const fromEmail = String(env.SUPPORT_FROM_EMAIL || 'no-reply@mmmbc.com').trim();
  const fromName = String(env.SUPPORT_FROM_NAME || 'MMMBC Admin Support').trim() || 'MMMBC Admin Support';

  const composedSubject = `[MMMBC Support] ${subject}`;
  const textBody = [
    `From (admin): ${auth.email}`,
    replyTo ? `Reply-To: ${replyTo}` : 'Reply-To: (not provided)',
    '',
    message
  ].join('\n');

  // Prefer Cloudflare Email Routing (send_email binding) when configured.
  // This is more reliable than the legacy MailChannels endpoint, which may reject requests.
  let emailRoutingError = '';
  if (env.SUPPORT_EMAIL && typeof env.SUPPORT_EMAIL.send === 'function') {
    const escapeQuotes = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
    const fromHeaderName = fromName ? `"${escapeQuotes(fromName)}" ` : '';
    const fromHeader = `${fromHeaderName}<${fromEmail}>`;
    const replyToHeader = replyTo ? `Reply-To: ${replyTo}\r\n` : '';

    const messageIdDomain = (() => {
      const pick = (addr) => {
        const m = String(addr || '').match(/@([^>\s]+)$/);
        return m ? m[1] : '';
      };
      return pick(toEmail) || pick(fromEmail) || 'mmmbc.local';
    })();

    const messageId = (() => {
      try {
        // crypto.randomUUID is available in Workers.
        return `<${crypto.randomUUID()}@${messageIdDomain}>`;
      } catch {
        const rand = Math.random().toString(16).slice(2);
        return `<${Date.now().toString(16)}.${rand}@${messageIdDomain}>`;
      }
    })();

    const dateHeader = new Date().toUTCString();

    // Minimal RFC-5322-ish message. Good enough for plain-text support emails.
    const raw = [
      `To: ${toEmail}`,
      `From: ${fromHeader}`,
      replyToHeader.trimEnd(),
      `Subject: ${composedSubject}`,
      `Date: ${dateHeader}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      textBody
    ].filter(Boolean).join('\r\n');

    try {
      const msg = new EmailMessage(fromEmail, deliveryToEmail, raw);
      await env.SUPPORT_EMAIL.send(msg);
      return json({ ok: true });
    } catch (e) {
      // Common Cloudflare Email Routing error: destination address not verified.
      // Fall back to MailChannels when possible.
      emailRoutingError = (e && (e.stack || e.message)) ? String(e.stack || e.message) : String(e);

      if (/destination address is not a verified address/i.test(emailRoutingError)) {
        return json(
          {
            error: 'Email send failed (Email Routing): the delivery destination is not verified. Verify the destination_address for the SUPPORT_EMAIL binding (or set SUPPORT_EMAIL_DESTINATION to a verified address) in Cloudflare Dashboard → Email → Email Routing.'
          },
          { status: 502 }
        );
      }

      // When SUPPORT_EMAIL is configured, do not fall back to MailChannels.
      // MailChannels frequently rejects non-Cloudflare origins and can mask the real error.
      return json(
        { error: `Email send failed (Email Routing). ${emailRoutingError}`.slice(0, 2000) },
        { status: 502 }
      );
    }
  }

  // Fallback: MailChannels (legacy). This may return 401/403 depending on current policy.
  const payload = {
    personalizations: [{ to: [{ email: deliveryToEmail }], subject: composedSubject }],
    from: { email: fromEmail, name: fromName },
    ...(replyTo ? { reply_to: { email: replyTo } } : {}),
    content: [{ type: 'text/plain', value: textBody }]
  };

  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 401) {
      return json(
        {
          error: 'Email send failed (401 from MailChannels). Configure Cloudflare Email Routing with a send_email binding named SUPPORT_EMAIL.'
        },
        { status: 502 }
      );
    }
    const prefix = emailRoutingError
      ? `Email Routing failed (${String(emailRoutingError).slice(0, 500)}). `
      : '';
    return json({ error: `${prefix}Email send failed (${res.status}). ${errText}`.trim().slice(0, 2000) }, { status: 502 });
  }

  return json({ ok: true });
}

function guessContentType(key) {
  const k = String(key || '').toLowerCase();
  if (k.endsWith('.jpg') || k.endsWith('.jpeg')) return 'image/jpeg';
  if (k.endsWith('.png')) return 'image/png';
  if (k.endsWith('.webp')) return 'image/webp';
  if (k.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

async function listGallery(env) {
  const rows = await env.DB.prepare(
    `SELECT id, album, label, tags_json, file_key, thumb_key, original_name, created_at, position
     FROM gallery_items`
  ).all();

  const items = (rows.results || []).map((r) => {
    const tags = (() => {
      try {
        const parsed = JSON.parse(r.tags_json || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();

    return {
      id: r.id,
      album: r.album,
      label: r.label,
      tags,
      file: `/cdn/gallery/${encodeURI(r.file_key)}`,
      thumb: r.thumb_key ? `/cdn/gallery/${encodeURI(r.thumb_key)}` : `/cdn/gallery/${encodeURI(r.file_key)}`,
      originalName: r.original_name,
      createdAt: r.created_at,
      position: r.position
    };
  });

  return { items };
}

async function handlePublicGallery(request, env) {
  // Public endpoint: drives the public photo gallery page.
  // Note: if your Cloudflare Access policy currently protects ALL /api paths,
  // we keep this under /public so it can remain unprotected.
  const data = await listGallery(env);
  return json(data, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function splitKeyUnderPrefix(key, prefix) {
  const k = String(key || '');
  const p = String(prefix || '');
  if (!k.startsWith(p)) return null;
  const rest = k.slice(p.length);
  if (!rest) return null;
  const first = rest.split('/')[0];
  if (!first) return null;
  const isFolder = rest.includes('/') && !rest.endsWith(first);
  return { first, rest, isFolder };
}

async function handleR2Tree(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const url = new URL(request.url);
  let prefix = sanitizePrefix(url.searchParams.get('prefix') || 'gallery/', {
    fallback: 'gallery/',
    ensureTrailingSlash: true
  });
  if (!prefix.startsWith('gallery/')) prefix = 'gallery/';
  const limitRaw = Number(url.searchParams.get('limit') || 250);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.trunc(limitRaw))) : 250;
  const cursor = String(url.searchParams.get('cursor') || '').trim() || undefined;

  const listed = await env.GALLERY_BUCKET.list({ prefix, limit, cursor });
  const folders = new Map();
  const files = [];

  for (const o of (listed.objects || [])) {
    const parsed = splitKeyUnderPrefix(o.key, prefix);
    if (!parsed) continue;
    if (parsed.rest.includes('/')) {
      const folderPrefix = `${prefix}${parsed.first}/`;
      if (!folders.has(parsed.first)) {
        folders.set(parsed.first, { name: parsed.first, prefix: folderPrefix });
      }
    } else {
      files.push({
        name: parsed.first,
        key: o.key,
        size: o.size,
        etag: o.etag,
        uploaded: o.uploaded
      });
    }
  }

  const folderList = Array.from(folders.values()).sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return json({
    ok: true,
    prefix,
    limit,
    cursor: cursor || null,
    truncated: Boolean(listed.truncated),
    nextCursor: listed.truncated ? listed.cursor : null,
    folders: folderList,
    files
  });
}

async function handleR2DeleteObject(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const url = new URL(request.url);
  const key = String(url.searchParams.get('key') || '').trim();
  if (!key) return json({ error: 'key is required' }, { status: 400 });
  if (!key.startsWith('gallery/')) return json({ error: 'Only gallery/ keys can be deleted here.' }, { status: 400 });

  await env.GALLERY_BUCKET.delete(key);

  // Keep DB in sync if this key had a record.
  try {
    await env.DB.prepare(
      'DELETE FROM gallery_items WHERE file_key=? OR thumb_key=?'
    ).bind(key, key).run();
  } catch {
    // ignore
  }

  return json({ ok: true, deleted: key });
}

async function handleGallerySyncFromR2(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const url = new URL(request.url);
  let prefix = sanitizePrefix(url.searchParams.get('prefix') || 'gallery/', {
    fallback: 'gallery/',
    ensureTrailingSlash: false
  });
  if (!prefix.startsWith('gallery/')) prefix = 'gallery/';
  const limitRaw = Number(url.searchParams.get('limit') || 250);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.trunc(limitRaw))) : 250;
  const cursor = String(url.searchParams.get('cursor') || '').trim() || undefined;

  const listed = await env.GALLERY_BUCKET.list({ prefix, limit, cursor });
  const objects = listed.objects || [];

  let added = 0;
  let existing = 0;

  for (const o of objects) {
    const key = String(o.key || '');
    if (!key || key.endsWith('/')) continue;
    if (!key.startsWith('gallery/')) continue;

    const found = await env.DB.prepare(
      'SELECT id FROM gallery_items WHERE file_key=? LIMIT 1'
    ).bind(key).first();

    if (found?.id) {
      existing += 1;
      continue;
    }

    const parts = key.split('/');
    const album = sanitizeSegment(parts[1] || 'General') || 'General';
    const originalName = String(parts[parts.length - 1] || 'image');
    const createdAt = (() => {
      try {
        const d = o.uploaded ? new Date(o.uploaded) : new Date();
        return d.toISOString();
      } catch {
        return new Date().toISOString();
      }
    })();

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO gallery_items (id, album, label, tags_json, file_key, thumb_key, original_name, created_at, position)
       VALUES (?, ?, '', '[]', ?, NULL, ?, ?, NULL)`
    ).bind(id, album, key, originalName, createdAt).run();

    added += 1;
  }

  return json({
    ok: true,
    prefix,
    limit,
    cursor: cursor || null,
    processed: objects.length,
    added,
    existing,
    truncated: Boolean(listed.truncated),
    nextCursor: listed.truncated ? listed.cursor : null
  });
}

async function handleGalleryUpload(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const ct = request.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const form = await request.formData();
  const album = sanitizeSegment(form.get('album') || 'General') || 'General';
  const label = sanitizeSegment(form.get('label') || '') || '';
  const tags = splitTags(form.get('tags') || '');

  const files = form.getAll('images').filter((f) => f && typeof f === 'object' && 'arrayBuffer' in f);
  if (!files.length) return json({ error: 'No images uploaded.' }, { status: 400 });

  const added = [];
  for (const file of files) {
    const id = crypto.randomUUID();
    const originalName = String(file.name || 'image');
    const safeBase = sanitizeSegment(originalName.replace(/\.[^.]+$/, '')).replace(/\s+/g, '-') || 'image';
    const ext = (originalName.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const createdAt = new Date().toISOString();

    const fileKey = `gallery/${album}/${createdAt.slice(0, 10)}_${safeBase}_${id}.${ext || 'jpg'}`;

    // Store original in R2
    await env.GALLERY_BUCKET.put(fileKey, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: file.type || guessContentType(fileKey)
      }
    });

    // No server-side thumbnail generation in Workers (sharp not available).
    // For now, thumb == original; later we can add client-generated thumbs.
    const thumbKey = null;

    await env.DB.prepare(
      `INSERT INTO gallery_items (id, album, label, tags_json, file_key, thumb_key, original_name, created_at, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).bind(
      id,
      album,
      label,
      JSON.stringify(tags),
      fileKey,
      thumbKey,
      originalName,
      createdAt
    ).run();

    added.push({
      id,
      album,
      label,
      tags,
      file: `/cdn/gallery/${encodeURI(fileKey)}`,
      thumb: `/cdn/gallery/${encodeURI(fileKey)}`,
      originalName,
      createdAt,
      position: null
    });
  }

  return json({ ok: true, added });
}

async function handleGalleryOrder(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const album = sanitizeSegment(body?.album || '');
  const orderedIds = Array.isArray(body?.orderedIds) ? body.orderedIds.map((x) => String(x)) : [];
  if (!album) return json({ error: 'Album is required.' }, { status: 400 });
  if (!orderedIds.length) return json({ error: 'orderedIds is required.' }, { status: 400 });

  // Transaction-like: set positions for ids in order.
  for (let i = 0; i < orderedIds.length; i += 1) {
    await env.DB.prepare(
      `UPDATE gallery_items SET position=? WHERE id=? AND album=?`
    ).bind(i, orderedIds[i], album).run();
  }

  return json({ ok: true });
}

async function handleGalleryUpdate(request, env, id) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const label = sanitizeSegment(body?.label || '') || '';
  const tags = splitTags(body?.tags || '');

  const existing = await env.DB.prepare(
    `SELECT id, album, label, tags_json, file_key, thumb_key, original_name, created_at, position
     FROM gallery_items WHERE id=?`
  ).bind(String(id)).first();

  if (!existing) return json({ error: 'Not found' }, { status: 404 });

  await env.DB.prepare(
    `UPDATE gallery_items SET label=?, tags_json=? WHERE id=?`
  ).bind(label, JSON.stringify(tags), String(id)).run();

  return json({
    ok: true,
    item: {
      id: existing.id,
      album: existing.album,
      label,
      tags,
      file: `/cdn/gallery/${encodeURI(existing.file_key)}`,
      thumb: existing.thumb_key ? `/cdn/gallery/${encodeURI(existing.thumb_key)}` : `/cdn/gallery/${encodeURI(existing.file_key)}`,
      originalName: existing.original_name,
      createdAt: existing.created_at,
      position: existing.position
    }
  });
}

async function handleGalleryDelete(request, env, id) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const row = await env.DB.prepare(
    `SELECT file_key, thumb_key FROM gallery_items WHERE id=?`
  ).bind(id).first();

  if (!row) return json({ error: 'Not found' }, { status: 404 });

  try {
    if (row.file_key) await env.GALLERY_BUCKET.delete(row.file_key);
    if (row.thumb_key) await env.GALLERY_BUCKET.delete(row.thumb_key);
  } catch {
    // ignore
  }

  await env.DB.prepare(`DELETE FROM gallery_items WHERE id=?`).bind(id).run();
  return json({ ok: true });
}

async function handleR2List(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const url = new URL(request.url);
  let prefix = sanitizePrefix(url.searchParams.get('prefix') || 'gallery/', { fallback: 'gallery/', ensureTrailingSlash: false });
  if (!prefix.startsWith('gallery/')) prefix = 'gallery/';
  const limitRaw = Number(url.searchParams.get('limit') || 50);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.trunc(limitRaw))) : 50;
  const cursor = String(url.searchParams.get('cursor') || '').trim() || undefined;

  const listed = await env.GALLERY_BUCKET.list({ prefix, limit, cursor });
  return json({
    ok: true,
    prefix,
    limit,
    cursor: cursor || null,
    truncated: Boolean(listed.truncated),
    nextCursor: listed.truncated ? listed.cursor : null,
    objects: (listed.objects || []).map((o) => ({
      key: o.key,
      size: o.size,
      etag: o.etag,
      uploaded: o.uploaded
    }))
  });
}

async function handleR2Migrate(request, env) {
  const auth = requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.error }, { status: 401 });

  const src = env.GALLERY_BUCKET_SRC;
  const dst = env.GALLERY_BUCKET_DST;
  if (!src || !dst || typeof src.list !== 'function' || typeof src.get !== 'function' || typeof dst.put !== 'function') {
    return json({
      error: 'Migration buckets not configured. Bind GALLERY_BUCKET_SRC and GALLERY_BUCKET_DST in wrangler.jsonc.'
    }, { status: 500 });
  }

  const url = new URL(request.url);
  let prefix = sanitizePrefix(url.searchParams.get('prefix') || 'gallery/', { fallback: 'gallery/', ensureTrailingSlash: false });
  if (!prefix.startsWith('gallery/')) prefix = 'gallery/';
  const limitRaw = Number(url.searchParams.get('limit') || 100);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 100;
  const cursor = String(url.searchParams.get('cursor') || '').trim() || undefined;

  const overwrite = ['1', 'true', 'yes', 'y', 'on'].includes(String(url.searchParams.get('overwrite') || '').trim().toLowerCase());
  const dryRun = ['1', 'true', 'yes', 'y', 'on'].includes(String(url.searchParams.get('dryRun') || '').trim().toLowerCase());

  const listed = await src.list({ prefix, limit, cursor });
  const objects = listed.objects || [];

  let copied = 0;
  let skipped = 0;
  let missing = 0;
  const errors = [];

  for (const obj of objects) {
    const key = obj.key;
    try {
      if (!overwrite) {
        const existing = await dst.head(key);
        if (existing) {
          skipped += 1;
          continue;
        }
      }

      if (dryRun) {
        copied += 1;
        continue;
      }

      const srcObj = await src.get(key);
      if (!srcObj) {
        missing += 1;
        continue;
      }

      await dst.put(key, srcObj.body, {
        httpMetadata: srcObj.httpMetadata,
        customMetadata: srcObj.customMetadata
      });
      copied += 1;
    } catch (e) {
      const msg = (e && (e.stack || e.message)) ? String(e.stack || e.message) : String(e);
      errors.push({ key, error: msg.slice(0, 500) });
    }
  }

  return json({
    ok: true,
    prefix,
    limit,
    cursor: cursor || null,
    processed: objects.length,
    copied,
    skipped,
    missing,
    errors,
    truncated: Boolean(listed.truncated),
    nextCursor: listed.truncated ? listed.cursor : null
  });
}

async function handleCdn(request, env) {
  const prefix = '/cdn/gallery/';
  const url = new URL(request.url);
  const key = decodeURI(url.pathname.slice(prefix.length));
  if (!key) return new Response('Not found', { status: 404 });

  const obj = await env.GALLERY_BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  const guessed = guessContentType(key);
  const ct = String(headers.get('Content-Type') || '').trim().toLowerCase();
  if (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream') {
    headers.set('Content-Type', guessed);
  }
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

  applySecurityHeaders(headers);

  return new Response(obj.body, { status: 200, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isHttps = url.protocol === 'https:';

    // Production hardening: once you have a real domain, force admin/api to it.
    // This also avoids confusion where Cloudflare Access is configured only on the real hostname.
    const canon = canonicalHost(env);
    if (
      canon
      && url.hostname.endsWith('.workers.dev')
      && (url.pathname.startsWith('/admin') || url.pathname.startsWith('/api'))
      && (request.method === 'GET' || request.method === 'HEAD')
    ) {
      const dest = new URL(request.url);
      dest.hostname = canon;
      dest.protocol = 'https:';
      return new Response(null, {
        status: 302,
        headers: {
          Location: dest.toString(),
          'Cache-Control': 'no-store'
        }
      });
    }

    // Browsers commonly request /favicon.ico even when the site uses a PNG favicon.
    // Ensure this never 500s by redirecting to the existing asset.
    if (/\/favicon\.ico$/i.test(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      const headers = new Headers({
        Location: '/Icons/favicon.png',
        'Cache-Control': 'public, max-age=86400'
      });
      applySecurityHeaders(headers, { isHttps });
      return new Response(null, { status: 302, headers });
    }

    // Admin auth is expected to be enforced by Cloudflare Access at the edge.
    // Keep the Worker itself agnostic: if Access isn't configured, /admin/* will still load.

    // Public gallery feed (used by the public Photo Gallery page)
    if ((url.pathname === '/public/gallery.json' || url.pathname === '/public/gallery') && request.method === 'GET') {
      return handlePublicGallery(request, env);
    }

    // Public YouTube status/feed (used by Live Praise page)
    if ((url.pathname === '/public/youtube.json' || url.pathname === '/public/youtube') && request.method === 'GET') {
      return handlePublicYoutube(request, env);
    }

    // CDN endpoint for gallery objects in R2
    if (url.pathname.startsWith('/cdn/gallery/')) {
      return handleCdn(request, env);
    }

    // Minimal API
    if (url.pathname === '/api/access/status' && request.method === 'GET') {
      const emailHeader = getAccessEmailHeaderOnly(request);
      const jwt = getAccessJwt(request);
      const jwtPayload = tryParseJwtPayload(jwt);
      const emailFromJwt = String(jwtPayload?.email || jwtPayload?.user_email || jwtPayload?.upn || '').trim().toLowerCase();
      const email = getAccessEmail(request);

      return json({
        ok: true,
        hostname: url.hostname,
        pathname: url.pathname,
        devBypass: isDevBypass(env),
        allowListEnabled: Boolean(allowList(env)),
        access: {
          hasSessionCookie: hasAccessSessionCookie(request),
          hasJwtAssertion: Boolean(jwt),
          hasEmailHeader: Boolean(emailHeader),
          hasServiceTokenHeaders: hasServiceTokenHeaders(request),
          email,
          emailHeader,
          emailFromJwt,
          jwtIssuer: String(jwtPayload?.iss || ''),
          jwtAudience: jwtPayload?.aud || null
        },
        hint: 'If hasSessionCookie/hasJwtAssertion/hasEmailHeader are all false, Cloudflare Access is not currently protecting this hostname/path (or you are using a hostname Access cannot intercept, like some workers.dev setups).'
      });
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      const email = getAccessEmail(request);
      if (!email && !isDevBypass(env)) return json({ user: null });
      return json({ user: { id: email || 'dev', email: email || 'dev@local', role: 'admin', name: '', isMaster: false, mustOnboard: false, twoFactorEnabled: false } });
    }

    if (url.pathname === '/api/gallery' && request.method === 'GET') {
      const auth = requireAdmin(request, env);
      if (!auth.ok) return json({ error: auth.error }, { status: 401 });
      return json(await listGallery(env));
    }

    if (url.pathname === '/api/gallery/upload' && request.method === 'POST') {
      return handleGalleryUpload(request, env);
    }

    if (url.pathname === '/api/gallery/order' && request.method === 'PUT') {
      return handleGalleryOrder(request, env);
    }

    if (url.pathname.startsWith('/api/gallery/') && request.method === 'PUT') {
      const id = url.pathname.split('/').pop();
      return handleGalleryUpdate(request, env, id);
    }

    // Diagnostic: list objects in the configured R2 bucket (admin only)
    if (url.pathname === '/api/gallery/r2list' && request.method === 'GET') {
      return handleR2List(request, env);
    }

    // Admin-only: browse R2 objects by "folder" prefix
    if (url.pathname === '/api/gallery/r2tree' && request.method === 'GET') {
      return handleR2Tree(request, env);
    }

    // Admin-only: delete an R2 object by key (and remove DB row if any)
    if (url.pathname === '/api/gallery/r2object' && request.method === 'DELETE') {
      return handleR2DeleteObject(request, env);
    }

    // Admin-only: sync D1 gallery rows from current R2 contents (paginated)
    if (url.pathname === '/api/gallery/sync' && request.method === 'POST') {
      return handleGallerySyncFromR2(request, env);
    }

    // Admin-only: migrate/copy objects between two R2 buckets (paginated)
    // Requires wrangler bindings: GALLERY_BUCKET_SRC (source) and GALLERY_BUCKET_DST (destination)
    if (url.pathname === '/api/gallery/r2migrate' && request.method === 'GET') {
      return handleR2Migrate(request, env);
    }

    if (url.pathname.startsWith('/api/gallery/') && request.method === 'DELETE') {
      const id = url.pathname.split('/').pop();
      return handleGalleryDelete(request, env, id);
    }

    // Health
    if (url.pathname === '/api/admin/health') {
      const auth = requireAdmin(request, env);
      if (!auth.ok) return json({ error: auth.error }, { status: 401 });
      return json({ ok: true, time: new Date().toISOString() });
    }

    // Support messages (admin only)
    if (url.pathname === '/api/support/message' && request.method === 'POST') {
      return handleSupportMessage(request, env);
    }

    // Legacy login entry points are removed from static assets.
    // Redirect old bookmarks to the active admin app entry.
    if (
      (url.pathname === '/admin/login'
        || url.pathname === '/admin/login.html'
        || url.pathname === '/admin/login.js'
        || url.pathname === '/admin/login_legacy.html')
      && (request.method === 'GET' || request.method === 'HEAD')
    ) {
      const headers = new Headers({
        Location: '/admin/',
        'Cache-Control': 'no-store'
      });
      applySecurityHeaders(headers, { isHttps });
      return new Response(null, { status: 302, headers });
    }

    // Static assets (public site + admin UI) from ./cf_site
    if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
      return text('Assets binding missing. Check wrangler.jsonc assets config.', { status: 500 });
    }

    // Avoid stale admin assets at the edge during frequent updates.
    const assetRes = await env.ASSETS.fetch(request);
    const headers = new Headers(assetRes.headers);
    applySecurityHeaders(headers, { isHttps });

    if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/')) {
      headers.set('Cache-Control', 'no-store');
    }

    // If we didn't change anything, returning the original response is fine too,
    // but this keeps header logic consistent and explicit.
    return new Response(assetRes.body, { status: assetRes.status, headers });
  }
};
