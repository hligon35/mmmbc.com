import worker from './worker-auth-wrapper.js';
import { handleGivingRequest } from './worker-giving.js';
import { handleGivingPageRequest } from './worker-giving-pages.js';
import { EmailMessage } from 'cloudflare:email';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function requireSession(request, env, ctx) {
  const url = new URL(request.url);
  url.pathname = '/api/me';
  url.search = '';
  const response = await worker.fetch(new Request(url.toString(), {
    method: 'GET',
    headers: request.headers
  }), env, ctx);
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data?.user || null;
}

async function readAssetJson(request, env, pathname, fallback) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return fallback;
  try {
    const url = new URL(request.url);
    url.pathname = pathname;
    url.search = '';
    const response = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

function normalizeAnnouncements(data) {
  if (Array.isArray(data)) return { posts: data };
  if (Array.isArray(data?.posts)) return { posts: data.posts };
  if (Array.isArray(data?.announcements)) return { posts: data.announcements };
  return { posts: [] };
}

function normalizeEvents(data) {
  if (Array.isArray(data)) return { events: data };
  if (Array.isArray(data?.events)) return { events: data.events };
  if (Array.isArray(data?.schedule)) return { events: data.schedule };
  return { events: [] };
}

function normalizeBulletins(data) {
  if (Array.isArray(data)) return { bulletins: data };
  if (Array.isArray(data?.bulletins)) return { bulletins: data.bulletins };
  return { bulletins: [] };
}

function isoOrEmpty(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString();
}

function bulletinUrlForKey(fileKey) {
  const key = String(fileKey || '').trim();
  if (!key) return '';
  if (/^https?:\/\//i.test(key)) return key;
  if (key.startsWith('/')) return key;
  return `/cdn/gallery/${encodeURI(key)}`;
}

async function forwardWithPath(request, env, ctx, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  const forwarded = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
  });
  return worker.fetch(forwarded, env, ctx);
}

async function sendSupportEmailMessage(env, {
  subject,
  textBody,
  replyTo = '',
  fromNameOverride = ''
} = {}) {
  const toEmail = String(env.SUPPORT_TO_EMAIL || 'support@hldesignedit.com').trim();
  const deliveryToEmail = String(env.SUPPORT_EMAIL_DESTINATION || toEmail).trim();
  const fromEmail = String(env.SUPPORT_FROM_EMAIL || 'no-reply@mmmbc.com').trim();
  const fromName = String(fromNameOverride || env.SUPPORT_FROM_NAME || 'MMMBC Website').trim() || 'MMMBC Website';

  if (!env.SUPPORT_EMAIL || typeof env.SUPPORT_EMAIL.send !== 'function') {
    throw new Error('Email send is not configured. SUPPORT_EMAIL binding is missing.');
  }

  const escapeQuotes = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
  const fromHeaderName = fromName ? `"${escapeQuotes(fromName)}" ` : '';
  const fromHeader = `${fromHeaderName}<${fromEmail}>`;
  const replyToHeader = replyTo ? `Reply-To: ${replyTo}\r\n` : '';
  const safeSubject = String(subject || '').trim().slice(0, 180);
  const safeBody = String(textBody || '').trim().slice(0, 12000);
  const messageId = `<${crypto.randomUUID()}@mmmbc.local>`;

  const raw = [
    `To: ${toEmail}`,
    `From: ${fromHeader}`,
    replyToHeader.trimEnd(),
    `Subject: ${safeSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    safeBody
  ].filter(Boolean).join('\r\n');

  const msg = new EmailMessage(fromEmail, deliveryToEmail, raw);
  await env.SUPPORT_EMAIL.send(msg);
}

function emptyFinances() {
  return {
    entries: [],
    funds: [],
    donors: [],
    weeklyGiving: [],
    settings: {}
  };
}

const READ_ENDPOINTS = new Set([
  '/api/finances',
  '/api/profiles'
]);

function parseDateOnlyToTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  const ms = Date.parse(`${raw}T00:00:00`);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function startOfTodayMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function isoFromDateTimeParts(datePart, timePart) {
  const d = String(datePart || '').trim();
  if (!d) return '';
  const t = String(timePart || '').trim();
  const ms = Date.parse(`${d}T${t || '00:00'}`);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}

async function buildDashboardOverview(request, env) {
  const now = Date.now();
  const todayStart = startOfTodayMs();
  const in14Days = now + (14 * 24 * 60 * 60 * 1000);

  let announcements = [];
  let events = [];
  let subscribers = 0;
  let drafts = 0;
  let scheduled = 0;
  let history = 0;
  let nextScheduledAt = '';
  let givingIncome30d = 0;
  let givingExpense30d = 0;
  let pendingReviewCount = 0;
  let currentMonthEntries = 0;

  if (env.DB) {
    const announcementsRows = await env.DB.prepare(
      'SELECT id, title, body, created_at, expires_at FROM announcements ORDER BY created_at DESC LIMIT 250'
    ).all().catch(() => ({ results: [] }));
    announcements = Array.isArray(announcementsRows?.results) ? announcementsRows.results : [];

    const eventRows = await env.DB.prepare(
      'SELECT id, title, event_date, event_time, created_at FROM events ORDER BY event_date ASC, event_time ASC LIMIT 250'
    ).all().catch(() => ({ results: [] }));
    events = Array.isArray(eventRows?.results) ? eventRows.results : [];

    const subCountRow = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM subscribers WHERE lower(coalesce(status, 'active')) = 'active'"
    ).first().catch(() => ({ c: 0 }));
    subscribers = Number(subCountRow?.c || 0);

    const newsletterRows = await env.DB.prepare(
      'SELECT status, schedule_at, sent_at FROM newsletter_records ORDER BY created_at DESC LIMIT 500'
    ).all().catch(() => ({ results: [] }));
    const newsletterRecords = Array.isArray(newsletterRows?.results) ? newsletterRows.results : [];
    for (const row of newsletterRecords) {
      const status = String(row?.status || '').toLowerCase();
      if (status === 'draft') drafts += 1;
      if (status === 'scheduled' || status === 'retrying') {
        scheduled += 1;
        const sch = isoOrEmpty(row?.schedule_at);
        if (sch && (!nextScheduledAt || Date.parse(sch) < Date.parse(nextScheduledAt))) {
          nextScheduledAt = sch;
        }
      }
      if (status === 'sent' || status === 'delivered' || status === 'completed') history += 1;
    }

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthStartIso = monthStart.toISOString();
    const day30Iso = new Date(now - (30 * 24 * 60 * 60 * 1000)).toISOString();

    const financeRows = await env.DB.prepare(
      `SELECT type, amount_cents, date, status
       FROM finances
       WHERE date >= ?
       ORDER BY date DESC
       LIMIT 1000`
    ).bind(day30Iso).all().catch(() => ({ results: [] }));
    const financeEntries = Array.isArray(financeRows?.results) ? financeRows.results : [];
    for (const row of financeEntries) {
      const type = String(row?.type || '').toLowerCase();
      const amount = Number(row?.amount_cents || 0);
      if (type === 'income') givingIncome30d += amount;
      if (type === 'expense') givingExpense30d += amount;
      const st = String(row?.status || '').toLowerCase();
      if (st === 'pending' || st === 'review') pendingReviewCount += 1;
      const dateMs = Date.parse(String(row?.date || ''));
      if (Number.isFinite(dateMs) && dateMs >= Date.parse(monthStartIso)) currentMonthEntries += 1;
    }
  } else {
    const announcementData = await readAssetJson(request, env, '/announcements.json', { posts: [] });
    announcements = Array.isArray(announcementData?.posts) ? announcementData.posts : [];

    const eventData = await readAssetJson(request, env, '/schedule.json', []);
    events = Array.isArray(eventData?.events)
      ? eventData.events
      : (Array.isArray(eventData) ? eventData : []);
  }

  const activeAnnouncements = announcements.filter((row) => {
    const exp = isoOrEmpty(row?.expires_at || row?.expiresAt || '');
    return !exp || Date.parse(exp) > now;
  });

  const upcomingEvents = events
    .map((row) => {
      const title = String(row?.title || 'Event').trim() || 'Event';
      const date = String(row?.event_date || row?.date || '').trim();
      const time = String(row?.event_time || row?.time || '').trim();
      const dateMs = parseDateOnlyToTime(date);
      return {
        title,
        date,
        time,
        dateMs,
        createdAt: String(row?.created_at || row?.createdAt || '')
      };
    })
    .filter((row) => Number.isFinite(row.dateMs) && row.dateMs >= todayStart)
    .sort((a, b) => a.dateMs - b.dateMs);

  const upcoming14 = upcomingEvents.filter((row) => row.dateMs <= in14Days);
  const todayEvents = upcomingEvents.filter((row) => row.dateMs === todayStart);

  const galleryData = await readAssetJson(request, env, '/gallery.json', { items: [], albums: [] });
  const galleryItems = Array.isArray(galleryData?.items) ? galleryData.items : (Array.isArray(galleryData) ? galleryData : []);
  const galleryAlbums = Array.isArray(galleryData?.albums) ? galleryData.albums : [];

  const needsAttention = [];
  if (!activeAnnouncements.length) {
    needsAttention.push({
      title: 'No active announcements',
      detail: 'Post an announcement so members see fresh updates.',
      action: {
        label: 'Open Announcements',
        sectionTarget: 'tab-content'
      }
    });
  }
  if (!upcoming14.length) {
    needsAttention.push({
      title: 'No events in the next 14 days',
      detail: 'Add an upcoming event to keep the calendar current.',
      action: {
        label: 'Open Events',
        sectionTarget: 'tab-events'
      }
    });
  }
  if (!subscribers) {
    needsAttention.push({
      title: 'No active subscribers',
      detail: 'Invite members to subscribe to the newsletter list.',
      action: {
        label: 'Open Newsletter',
        sectionTarget: 'tab-newsletter'
      }
    });
  }

  const recentActivity = [];
  for (const row of activeAnnouncements.slice(0, 3)) {
    recentActivity.push({
      title: `Announcement: ${String(row?.title || 'Untitled')}`,
      detail: isoOrEmpty(row?.created_at || row?.createdAt || '') || 'Recently updated'
    });
  }
  for (const row of upcomingEvents.slice(0, 4)) {
    recentActivity.push({
      title: `Event: ${String(row?.title || 'Event')}`,
      detail: isoFromDateTimeParts(row.date, row.time) || row.date
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      upcomingEvents14d: upcoming14.length,
      todayEvents: todayEvents.length,
      activeAnnouncements: activeAnnouncements.length,
      totalAnnouncements: announcements.length,
      subscribers,
      scheduledNewsletters: scheduled,
      galleryItems: galleryItems.length,
      galleryAlbums: galleryAlbums.length
    },
    needsAttention,
    upcomingEvents: upcoming14.slice(0, 8).map((row) => ({
      title: row.title,
      date: row.date,
      time: row.time
    })),
    giving: {
      last30dIncomeCents: givingIncome30d,
      last30dExpenseCents: givingExpense30d,
      pendingReviewCount,
      currentMonthEntries
    },
    newsletter: {
      drafts,
      scheduled,
      history,
      nextScheduledAt: nextScheduledAt || ''
    },
    websiteStatus: {
      storageMode: env.DB ? 'd1' : 'assets_only',
      announcementsStorage: env.DB ? 'd1' : 'assets',
      schedulerRunning: true,
      degraded: false
    },
    status: {
      announcements: { ok: true },
      gallery: { ok: true },
      newsletter: { ok: true }
    },
    recentActivity: recentActivity.slice(0, 10),
    permissions: {
      canViewFinance: true
    }
  };
}

const HEADER_BULK_BAR = `
            <div class="photoBulkBar photoBulkBar--header" id="photoBulkBar" hidden>
              <button class="btn" id="photoBulkEditBtn" type="button">Edit selected photos</button>
              <button class="btn btn--danger" id="photoBulkDeleteBtn" type="button">Delete selected photos</button>
              <span class="muted" id="photoBulkCount" aria-live="polite"></span>
            </div>`;

const FINAL_GALLERY_STYLE = `
<style id="mmmbc-gallery-layout-final">
  #photoPager:not([hidden]),
  #photoPagerBottom:not([hidden]) {
    display: flex !important;
    width: fit-content !important;
    max-width: 100%;
    margin-left: auto !important;
    margin-right: auto !important;
    justify-content: center !important;
    align-items: center !important;
    gap: 14px !important;
  }
  #photoPager:not([hidden]) {
    margin-top: 26px !important;
    margin-bottom: 22px !important;
  }
  #photoPagerBottom:not([hidden]) {
    margin-top: 24px !important;
    margin-bottom: 10px !important;
  }
  #tab-photos > .sectionHeader {
    align-items: flex-start;
  }
  #tab-photos > .sectionHeader > .iconGroup {
    margin-left: auto;
    align-items: flex-end;
    min-width: min(100%, 620px);
  }
  #tab-photos .photoBulkBar--header {
    position: static !important;
    inset: auto !important;
    width: auto !important;
    max-width: 100%;
    margin: 8px 0 0 auto !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
    backdrop-filter: none !important;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
  }
  #tab-photos .photoBulkBar--header[hidden] {
    display: none !important;
  }
  #tab-photos .photoBulkBar--header #photoBulkCount {
    width: 100%;
    text-align: right;
  }
  @media (max-width: 900px) {
    #tab-photos > .sectionHeader {
      flex-wrap: wrap;
    }
    #tab-photos > .sectionHeader > .iconGroup {
      width: 100%;
      min-width: 0;
      align-items: stretch;
    }
    #tab-photos .photoBulkBar--header {
      margin-left: 0 !important;
      justify-content: flex-start;
    }
    #tab-photos .photoBulkBar--header #photoBulkCount {
      text-align: left;
    }
  }
</style>`;

const STRUCTURE_STYLESHEET = '<link id="mmmbc-admin-structure-css" rel="stylesheet" href="/admin/admin-structure-overrides.css?v=20260724-1" />';
const STRUCTURE_SCRIPT = '<script id="mmmbc-admin-structure-js" src="/admin/admin-structure-overrides.js?v=20260724-1" defer></script>';

async function transformAdminHtml(response) {
  const type = String(response.headers.get('Content-Type') || '').toLowerCase();
  if (!type.includes('text/html')) return response;

  let html = await response.text();

  html = html.replace(
    /\s*<div class="photoBulkBar" id="photoBulkBar" hidden>[\s\S]*?<\/div>/,
    ''
  );

  if (!html.includes('photoBulkBar--header')) {
    html = html.replace(
      '<div class="syncProgress" id="syncProgressWrap" aria-live="polite" hidden>',
      `${HEADER_BULK_BAR}\n            <div class="syncProgress" id="syncProgressWrap" aria-live="polite" hidden>`
    );
  }

  if (!html.includes('id="mmmbc-gallery-layout-final"')) {
    html = html.replace('</head>', `${FINAL_GALLERY_STYLE}\n</head>`);
  }

  if (!html.includes('id="mmmbc-admin-structure-css"')) {
    html = html.replace('</head>', `${STRUCTURE_STYLESHEET}\n</head>`);
  }

  if (!html.includes('id="mmmbc-admin-structure-js"')) {
    html = html.replace('</body>', `${STRUCTURE_SCRIPT}\n</body>`);
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(html, { status: response.status, headers });
}

async function transformPublicHtml(response, pathname) {
  const type = String(response.headers.get('Content-Type') || '').toLowerCase();
  if (!type.includes('text/html')) return response;

  let html = await response.text();
  const pageHref = '/giving.html';

  if (!html.includes('data-mmmbc-give-link')) {
    const giveLink = `<a href="${pageHref}" class="nav-give-link" data-mmmbc-give-link>Give</a>`;
    html = html.replace(
      /(<a\s+href=["'][^"']*contact\.html[^"']*["'][^>]*>Contact Us<\/a>)/i,
      `${giveLink}\n            $1`
    );
  }

  if (!html.includes('id="mmmbc-giving-public-style"')) {
    html = html.replace('</head>', `<style id="mmmbc-giving-public-style">
      .nav-give-link{font-weight:700!important;border:1px solid currentColor;border-radius:999px;padding:.45rem .9rem!important}
      .hero-giving-actions{display:flex;gap:.75rem;justify-content:center;align-items:center;flex-wrap:wrap}
      .btn-give{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;border-radius:999px;padding:.8rem 1.2rem;font-weight:700;background:#d5af45;color:#111;border:2px solid #d5af45}
      .btn-give:hover,.btn-give:focus-visible{filter:brightness(1.08)}
    </style>\n</head>`);
  }

  if ((pathname === '/' || pathname === '/index.html') && !html.includes('data-mmmbc-hero-give')) {
    html = html.replace(
      /(<a\s+href=["']Pages\/contact\.html#contact-form-section["'][^>]*class=["']btn-contact["'][^>]*>Contact Us<\/a>)/i,
      `<div class="hero-giving-actions" data-mmmbc-hero-give>$1<a href="/giving.html" class="btn-give">Give Online</a></div>`
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(html, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const givingPageResponse = await handleGivingPageRequest(request, env);
    if (givingPageResponse) return givingPageResponse;

    const givingResponse = await handleGivingRequest(request, env);
    if (givingResponse) return givingResponse;

    // Compatibility public API surface, served directly here so canonical-host
    // behavior is stable even when downstream worker route mappings drift.
    if ((url.pathname === '/api/public/gallery' || url.pathname === '/api/public/gallery.json') && request.method === 'GET') {
      const forwarded = await forwardWithPath(request, env, ctx, '/public/gallery');
      if (forwarded.ok) return forwarded;
      return json({ items: [], metadata: { source: 'compat-empty' } }, forwarded.status >= 500 ? 200 : forwarded.status);
    }

    if ((url.pathname === '/api/public/youtube' || url.pathname === '/api/public/youtube.json') && request.method === 'GET') {
      const forwarded = await forwardWithPath(request, env, ctx, '/public/youtube');
      if (forwarded.ok) return forwarded;
      return json({ videos: [], status: 'offline', source: 'compat-empty' }, forwarded.status >= 500 ? 200 : forwarded.status);
    }

    if ((url.pathname === '/api/public/announcements' || url.pathname === '/api/public/announcements.json') && request.method === 'GET') {
      if (env.DB) {
        const rows = await env.DB.prepare(
          'SELECT id, title, body, created_at, expires_at FROM announcements ORDER BY created_at DESC LIMIT 100'
        ).all().catch(() => ({ results: [] }));
        const posts = (rows?.results || [])
          .filter((r) => {
            const exp = isoOrEmpty(r.expires_at);
            return !exp || Date.parse(exp) > Date.now();
          })
          .map((r) => ({
            id: String(r.id || ''),
            title: String(r.title || ''),
            body: String(r.body || ''),
            createdAt: String(r.created_at || ''),
            expiresAt: isoOrEmpty(r.expires_at) || undefined
          }));
        return json({ posts });
      }
      const data = await readAssetJson(request, env, '/announcements.json', { posts: [] });
      return json(normalizeAnnouncements(data));
    }

    if ((url.pathname === '/api/public/events' || url.pathname === '/api/public/events.json') && request.method === 'GET') {
      if (env.DB) {
        const rows = await env.DB.prepare(
          'SELECT id, title, event_date, event_time, created_at, updated_at FROM events ORDER BY event_date ASC, event_time ASC, created_at ASC'
        ).all().catch(() => ({ results: [] }));
        const events = (rows?.results || []).map((r) => ({
          id: String(r.id || ''),
          title: String(r.title || ''),
          date: String(r.event_date || ''),
          time: String(r.event_time || ''),
          createdAt: String(r.created_at || ''),
          updatedAt: String(r.updated_at || '')
        }));
        return json({ events });
      }
      const data = await readAssetJson(request, env, '/schedule.json', []);
      return json(normalizeEvents(data));
    }

    if ((url.pathname === '/api/public/bulletins' || url.pathname === '/api/public/bulletins.json') && request.method === 'GET') {
      if (env.DB) {
        const rows = await env.DB.prepare(
          'SELECT id, title, file_key, original_name, starts_at, ends_at, created_at FROM bulletins ORDER BY created_at DESC LIMIT 120'
        ).all().catch(() => ({ results: [] }));
        const now = Date.now();
        const bulletins = (rows?.results || [])
          .map((r) => ({
            id: String(r.id || ''),
            title: String(r.title || 'Bulletin'),
            originalName: String(r.original_name || ''),
            url: bulletinUrlForKey(String(r.file_key || '')),
            startsAt: isoOrEmpty(r.starts_at),
            endsAt: isoOrEmpty(r.ends_at),
            createdAt: String(r.created_at || '')
          }))
          .filter((entry) => {
            if (!entry.startsAt || !entry.endsAt) return false;
            const s = Date.parse(entry.startsAt);
            const e = Date.parse(entry.endsAt);
            return Number.isFinite(s) && Number.isFinite(e) && now >= s && now < e;
          });
        return json({ bulletins });
      }
      const data = await readAssetJson(request, env, '/bulletins.json', { bulletins: [] });
      return json(normalizeBulletins(data));
    }

    if (url.pathname === '/api/public/site-settings' && request.method === 'GET') {
      const raw = await readAssetJson(request, env, '/site-settings.json', {});
      const out = (raw && typeof raw === 'object') ? raw : {};
      if (!out.email) out.email = String(env.SUPPORT_TO_EMAIL || 'mtmoriahmbc1201@gmail.com');
      if (!Array.isArray(out.subscribers)) out.subscribers = [];
      return json(out);
    }

    if (url.pathname === '/api/public/livestream' && request.method === 'GET') {
      const raw = await readAssetJson(request, env, '/livestream.json', {
        active: { platform: 'website', status: 'offline' },
        embeds: { youtube: '', facebook: '', website: '' },
        recurring: []
      });
      return json((raw && typeof raw === 'object') ? raw : {
        active: { platform: 'website', status: 'offline' },
        embeds: { youtube: '', facebook: '', website: '' },
        recurring: []
      });
    }

    if (url.pathname === '/api/public/newsletter/subscribe' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const email = String(body?.email || '').trim().toLowerCase();
      const name = String(body?.name || '').trim().slice(0, 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'A valid email is required.' }, 400);
      }
      if (!env.DB) return json({ ok: true, email, warning: 'DB unavailable; accepted without persistence.' });
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO subscribers (id, email, name, status, created_at)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT(email) DO UPDATE SET
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE subscribers.name END,
           status = 'active'`
      ).bind(crypto.randomUUID(), email, name, now).run();
      return json({ ok: true, email });
    }

    if (url.pathname === '/api/public/contact-message' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = String(body?.name || '').trim().slice(0, 120);
      const email = String(body?.email || '').trim().toLowerCase();
      const phone = String(body?.phone || '').trim().slice(0, 80);
      const address = String(body?.address || '').trim().slice(0, 240);
      const message = String(body?.message || '').trim().slice(0, 4000);
      if (!name || !message) return json({ error: 'Name and message are required.' }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required.' }, 400);

      const textBody = [
        'Public website contact form submission',
        `Name: ${name}`,
        `Email: ${email}`,
        `Phone: ${phone || '(not provided)'}`,
        `Address: ${address || '(not provided)'}`,
        '',
        'Message:',
        message
      ].join('\n');

      try {
        await sendSupportEmailMessage(env, {
          subject: '[MMMBC Contact] New Website Message',
          textBody,
          replyTo: email,
          fromNameOverride: 'MMMBC Public Contact'
        });
        return json({ ok: true });
      } catch (e) {
        return json({ error: `Unable to send message. ${String(e?.message || e)}`.slice(0, 500) }, 502);
      }
    }

    if (url.pathname === '/api/public/facility-rental-request' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const audience = String(body?.audience || '').trim().toLowerCase() === 'non_member' ? 'non_member' : 'member';
      const form = (body?.form && typeof body.form === 'object') ? body.form : {};
      const personResponsible = String(form.personResponsible || '').trim().slice(0, 140);
      const phone = String(form.phone || '').trim().slice(0, 80);
      const purpose = String(form.purpose || '').trim().slice(0, 240);
      const dateOfUse = String(form.dateOfUse || '').trim().slice(0, 40);
      const timeFrom = String(form.timeFrom || '').trim().slice(0, 20);
      const timeTo = String(form.timeTo || '').trim().slice(0, 20);
      const contactEmail = String(form.contactEmail || '').trim().toLowerCase().slice(0, 200);
      if (!personResponsible || !phone || !purpose || !dateOfUse || !timeFrom || !timeTo) {
        return json({ error: 'Please complete all required rental fields.' }, 400);
      }

      const formLines = [];
      for (const [key, value] of Object.entries(form)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          formLines.push(`${key}: ${value.join(', ')}`);
          continue;
        }
        formLines.push(`${key}: ${String(value).trim()}`);
      }

      const textBody = [
        `Facility rental request (${audience === 'non_member' ? 'Non-member' : 'Member'})`,
        `Submitted at: ${new Date().toISOString()}`,
        '',
        ...formLines
      ].join('\n');

      try {
        await sendSupportEmailMessage(env, {
          subject: `[MMMBC Facility Rental] ${audience === 'non_member' ? 'Non-member' : 'Member'} Request`,
          textBody,
          replyTo: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) ? contactEmail : '',
          fromNameOverride: 'MMMBC Public Facility Rental'
        });
        return json({ ok: true });
      } catch (e) {
        return json({ error: `Unable to send request. ${String(e?.message || e)}`.slice(0, 500) }, 502);
      }
    }

    // Core auth/session routes are implemented in worker-auth-wrapper.
    // Forward them explicitly so they are not caught by the generic /api 404 guard below.
    if (url.pathname === '/api/auth/providers' && request.method === 'GET') {
      return worker.fetch(request, env, ctx);
    }

    if (url.pathname === '/api/auth/google' && request.method === 'POST') {
      return worker.fetch(request, env, ctx);
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return worker.fetch(request, env, ctx);
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      return worker.fetch(request, env, ctx);
    }

    if (url.pathname === '/api/csrf' && request.method === 'GET') {
      return worker.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && READ_ENDPOINTS.has(url.pathname)) {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);

      if (url.pathname === '/api/finances') return json(emptyFinances());

      if (url.pathname === '/api/profiles') {
        const data = await readAssetJson(request, env, '/profiles.json', { profiles: [], metadata: {} });
        return json(data && typeof data === 'object' ? data : { profiles: [], metadata: {} });
      }
    }

    if (url.pathname === '/api/dashboard/overview' && request.method === 'GET') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const overview = await buildDashboardOverview(request, env);
      return json(overview);
    }

    if (url.pathname.startsWith('/api/directory/')) {
      return worker.fetch(request, env, ctx);
    }

    if (
      url.pathname === '/api/gallery' ||
      url.pathname.startsWith('/api/gallery/') ||
      url.pathname === '/api/announcements' ||
      url.pathname.startsWith('/api/announcements/') ||
      url.pathname === '/api/events' ||
      url.pathname.startsWith('/api/events/') ||
      url.pathname === '/api/bulletins' ||
      url.pathname.startsWith('/api/bulletins/') ||
      url.pathname === '/api/subscribers' ||
      url.pathname === '/api/newsletter/records' ||
      url.pathname === '/api/users' ||
      url.pathname === '/api/users/invite' ||
      url.pathname.startsWith('/api/users/')
    ) {
      return worker.fetch(request, env, ctx);
    }

    // Finance compatibility surface expected by current admin UI.
    if (url.pathname === '/api/finances/funds' && request.method === 'GET') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({ funds: [] });
    }

    if (url.pathname === '/api/finances/funds' && request.method === 'POST') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const body = await request.json().catch(() => ({}));
      const fundName = String(body?.fundName || '').trim().slice(0, 120);
      if (!fundName) return json({ error: 'Fund name is required.' }, 400);
      return json({ ok: true, fund: { id: crypto.randomUUID(), fundName } }, 201);
    }

    if (/^\/api\/finances\/funds\/[^/]+\/archive$/.test(url.pathname) && request.method === 'POST') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({ ok: true });
    }

    if (url.pathname === '/api/finances/meta' && request.method === 'GET') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({ meta: { categories: [], funds: [] } });
    }

    if (url.pathname === '/api/finances/meta' && request.method === 'PUT') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const body = await request.json().catch(() => ({}));
      const categories = Array.isArray(body?.categories) ? body.categories.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const funds = Array.isArray(body?.funds) ? body.funds.map((x) => String(x || '').trim()).filter(Boolean) : [];
      return json({ ok: true, meta: { categories, funds } });
    }

    // Legacy auth/account/settings routes retained as compatibility shims.
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      return json({ error: 'Use Google sign-in. Password login is not available.' }, 400);
    }

    if (url.pathname === '/api/auth/recover' && request.method === 'POST') {
      return json({ ok: true });
    }

    if (url.pathname === '/api/account' && request.method === 'PUT') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({ ok: true });
    }

    if (url.pathname === '/api/account/password' && request.method === 'PUT') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({ ok: true });
    }

    if (url.pathname === '/api/admin/storage-health' && request.method === 'GET') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({
        ok: true,
        checkedAt: new Date().toISOString(),
        checks: {
          dbBinding: Boolean(env.DB),
          assetsBinding: Boolean(env.ASSETS && typeof env.ASSETS.fetch === 'function'),
          galleryBucketBinding: Boolean(env.GALLERY_BUCKET),
          supportEmailBinding: Boolean(env.SUPPORT_EMAIL && typeof env.SUPPORT_EMAIL.send === 'function')
        }
      });
    }

    if (url.pathname === '/api/admin/integration-health' && request.method === 'GET') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({
        ok: true,
        checkedAt: new Date().toISOString(),
        actor: String(user?.email || ''),
        checks: {
          dbBinding: Boolean(env.DB),
          assetsBinding: Boolean(env.ASSETS && typeof env.ASSETS.fetch === 'function'),
          galleryBucketBinding: Boolean(env.GALLERY_BUCKET),
          supportEmailBinding: Boolean(env.SUPPORT_EMAIL && typeof env.SUPPORT_EMAIL.send === 'function')
        },
        routeCoverage: {
          publicFeeds: [
            '/api/public/announcements',
            '/api/public/events',
            '/api/public/bulletins',
            '/api/public/gallery',
            '/api/public/youtube',
            '/api/public/site-settings',
            '/api/public/livestream'
          ],
          publicSubmissions: [
            '/api/public/newsletter/subscribe',
            '/api/public/contact-message',
            '/api/public/facility-rental-request'
          ]
        }
      });
    }

    if (url.pathname === '/api/livestream' && request.method === 'GET') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const data = await readAssetJson(request, env, '/livestream.json', {
        active: { platform: 'website', status: 'offline' },
        embeds: { youtube: '', facebook: '', website: '' },
        recurring: []
      });
      return json(data && typeof data === 'object' ? data : {
        active: { platform: 'website', status: 'offline' },
        embeds: { youtube: '', facebook: '', website: '' },
        recurring: []
      });
    }

    if (url.pathname === '/api/livestream' && request.method === 'PUT') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const payload = await request.json().catch(() => ({}));
      return json({ ok: true, livestream: payload, persisted: false, warning: 'Livestream runtime edits are not persisted in this deployment mode.' });
    }

    if (url.pathname === '/api/settings' && request.method === 'GET') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const data = await readAssetJson(request, env, '/site-settings.json', {});
      const settings = (data && typeof data === 'object') ? data : {};
      if (!settings.theme || typeof settings.theme !== 'object') {
        settings.theme = { accent: '#c46123', text: '#ffffff', background: '#000000' };
      }
      if (!settings.social || typeof settings.social !== 'object') {
        settings.social = {
          facebook: String(settings.facebook || ''),
          youtube: String(settings.youtube || ''),
          email: String(settings.email || ''),
          phone: String(settings.phone || ''),
          address: String(settings.address || '')
        };
      }
      return json(settings);
    }

    if (url.pathname === '/api/settings' && request.method === 'PUT') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const patch = await request.json().catch(() => ({}));
      return json({ ok: true, settings: patch, persisted: false, warning: 'Settings runtime edits are not persisted in this deployment mode.' });
    }

    if (url.pathname === '/api/theme/preview' && request.method === 'POST') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({ ok: true, preview: true });
    }

    if (url.pathname === '/api/theme/preview/clear' && request.method === 'POST') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({ ok: true, preview: false });
    }

    if (url.pathname === '/api/export' && request.method === 'POST') {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return json({ ok: true, exported: false, warning: 'File export is not available in this Worker runtime.' });
    }

    // Ensure unknown API paths never fall through to static-asset handling.
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'API endpoint not found.' }, 404);
    }

    const response = await worker.fetch(request, env, ctx);
    if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/')) {
      return transformAdminHtml(response);
    }
    return transformPublicHtml(response, url.pathname);
  },

  async scheduled(event, env, ctx) {
    if (typeof worker.scheduled === 'function') {
      return worker.scheduled(event, env, ctx);
    }
  }
};
