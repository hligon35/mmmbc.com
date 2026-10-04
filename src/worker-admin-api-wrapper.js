import { securityHeaders, mutationDenied, checkBodySize } from './launch-security.js';
import { handleNewsletterPreferences } from './newsletter-preferences.js';
import { deliverSubmissionEmail, retrySubmissionEmails } from './submission-delivery.js';
import worker from './worker-auth-wrapper.js';
import { handleGivingRequest } from './worker-giving.js';
import { handleGivingPageRequest } from './worker-giving-pages.js';
import { handlePublicSiteContentGet } from './worker-site-editor.js';
import { PERMISSIONS } from './admin-rbac.js';
import { honeypotTripped, verifyTurnstile, checkRateLimit, clientIp } from './public-forms-security.js';
import { sendResendEmail } from './email-resend.js';
import { handleWorkspaceRequest } from './worker-workspace.js';
import { resolveRoute, legacyRoutes } from '../admin/public/workspace/modules.mjs';
import { authenticateAdminRequest, authErrorResponse } from './admin-auth.js';

const authStateCache = new WeakMap();

// The demo seeder submits through the same public endpoints that the browser
// uses. Preview is deliberately the only environment where those synthetic
// requests may skip anti-abuse checks and outbound email delivery. Keeping the
// environment check here prevents a demo flag from ever changing production
// behavior by accident.
function previewDemoModeEnabled(env) {
  return String(env?.ENVIRONMENT || '').trim().toLowerCase() === 'preview'
    && String(env?.DEMO_MODE || '').trim().toLowerCase() === 'true';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function isMissingSiteColumn(error) {
  return /no such column|has no column named/i.test(String(error?.message || error));
}

async function updateSubmissionIfSupported(db, sql, values) {
  try {
    await db.prepare(sql).bind(...values).run();
  } catch (error) {
    if (!isMissingSiteColumn(error)) console.error('Website submission status update failed', error);
  }
}

async function requireSession(request, env, ctx) {
  if (authStateCache.has(request)) return authStateCache.get(request);
  const url = new URL(request.url);
  url.pathname = '/api/me';
  url.search = '';
  const response = await worker.fetch(new Request(url.toString(), {
    method: 'GET',
    headers: request.headers
  }), env, ctx);
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  const state = data?.user ? { ...data, ...data.user } : null;
  authStateCache.set(request, state);
  return state;
}

async function handleWebsiteSubmissions(request, env, ctx) {
  const session = await requireSession(request, env, ctx);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!session.permissions?.includes(PERMISSIONS.SUBMISSIONS_VIEW)) return json({ error: 'Permission denied.' }, 403);
  if (!env.SITE_DB) return json({ error: 'Site database is not configured.' }, 500);
  const url = new URL(request.url);
  const id = url.pathname.startsWith('/api/submissions/') ? decodeURIComponent(url.pathname.slice('/api/submissions/'.length)) : '';
  if (request.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
    const like = `%${q}%`;
    try {
      const result = await env.SITE_DB.prepare(`
      SELECT id, 'contact' AS type, name AS sender_name, email AS sender_email, subject,
        phone AS sender_phone, address AS sender_address, message AS body, created_at, status,
        read_at, archived_at, auto_reply_status, auto_reply_at, auto_reply_error
        FROM contact_messages WHERE archived_at IS NULL
          AND (? = '' OR name LIKE ? OR email LIKE ? OR subject LIKE ? OR message LIKE ? OR phone LIKE ? OR address LIKE ?)
      UNION ALL
      SELECT id, 'facility_rental' AS type, person_responsible AS sender_name,
        contact_email AS sender_email, 'Facility Rental Request' AS subject, phone AS sender_phone,
        '' AS sender_address, form_json AS body, created_at, status, read_at, archived_at,
        auto_reply_status, auto_reply_at, auto_reply_error
        FROM facility_rental_requests WHERE archived_at IS NULL
          AND (? = '' OR person_responsible LIKE ? OR contact_email LIKE ? OR form_json LIKE ? OR phone LIKE ?)
      ORDER BY created_at DESC LIMIT 300`)
        .bind(
          q, like, like, like, like, like, like,
          q, like, like, like, like
        ).all();
      return json({ submissions: result.results || [] });
    } catch (error) {
      console.error('Website submissions query failed', error);
      return json({ error: 'Unable to load website messages. Check the site database migrations and try again.' }, 503);
    }
  }
  if (!session.permissions?.includes(PERMISSIONS.SUBMISSIONS_MANAGE)) return json({ error: 'Permission denied.' }, 403);
  if (!id) return json({ error: 'Submission id is required.' }, 400);
  if (request.method === 'DELETE') {
    const type = url.searchParams.get('type');
    if (type !== 'contact' && type !== 'facility_rental') return json({ error: 'Valid submission type is required.' }, 400);
    const table = type === 'facility_rental' ? 'facility_rental_requests' : 'contact_messages';
    const result = await env.SITE_DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    if (result?.meta?.changes === 0) return json({ error: 'Submission not found.' }, 404);
    return json({ ok: true });
  }
  if (request.method !== 'PATCH') return json({ error: 'Method not allowed.' }, 405);
  const body = await request.json().catch(() => ({}));
  if (body.action !== 'read' || !['contact', 'facility_rental'].includes(body.type)) return json({ error: 'Valid read action and type are required.' }, 400);
  const table = body.type === 'facility_rental' ? 'facility_rental_requests' : 'contact_messages';
  await env.SITE_DB.prepare(`UPDATE ${table} SET read_at = COALESCE(read_at, ?) WHERE id = ?`).bind(new Date().toISOString(), id).run();
  return json({ ok: true });
}

async function sendWebsiteAutoReply(env, { to, kind = 'contact', submissionId }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) return { ok: true, skipped: true };
  const facility = kind === 'facility_rental';
  const subject = facility ? 'We received your facility rental request' : 'We received your message';
  const text = facility
    ? 'Thank you for submitting your facility rental request to Mt. Moriah Missionary Baptist Church. We received your request and will contact you after reviewing the details.'
    : 'Thank you for contacting Mt. Moriah Missionary Baptist Church. We received your message and will respond as soon as possible.';
  const html = facility
    ? '<p>Thank you for submitting your facility rental request to Mt. Moriah Missionary Baptist Church.</p><p>We received your request and will contact you after reviewing the details.</p>'
    : '<p>Thank you for contacting Mt. Moriah Missionary Baptist Church.</p><p>We received your message and will respond as soon as possible.</p>';
  return deliverSubmissionEmail(env, { to, subject, text, html, submissionId, submissionType:kind,kind:'confirmation' });
}

const FORM_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formText(value, max = 240) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function formMessage(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeFormEmail(value) {
  const email = formText(value, 254).toLowerCase();
  return email && email.length <= 254 && FORM_EMAIL_PATTERN.test(email) ? email : '';
}

function normalizeFormPhone(value) {
  const raw = formText(value, 80);
  if (!raw) return { value: '', valid: true };
  const digits = raw.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return { value: '', valid: false };
  return { value: `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`, valid: true };
}

function normalizeFormPostalCode(value) {
  const raw = formText(value, 20);
  if (!raw) return { value: '', valid: true };
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 5) return { value: digits, valid: true };
  if (digits.length === 9) return { value: `${digits.slice(0, 5)}-${digits.slice(5)}`, valid: true };
  return { value: '', valid: false };
}

function normalizeFormState(value) {
  const state = formText(value, 2).toUpperCase();
  return { value: state, valid: !state || /^[A-Z]{2}$/.test(state) };
}

function splitLegacyName(value) {
  const name = formText(value, 140);
  if (!name) return { firstName: '', lastName: '', name: '' };
  const parts = name.split(/\s+/);
  return {
    firstName: parts.shift() || '',
    lastName: parts.join(' '),
    name
  };
}

function normalizeFormAddress(body) {
  const structuredKeys = ['addressLine1', 'addressLine2', 'city', 'state', 'postalCode'];
  const hasStructuredAddress = structuredKeys.some((key) => String(body?.[key] ?? '').trim() !== '');
  const addressLine1 = formText(body?.addressLine1, 120);
  const addressLine2 = formText(body?.addressLine2, 120);
  const city = formText(body?.city, 80);
  const stateResult = normalizeFormState(body?.state);
  const postalResult = normalizeFormPostalCode(body?.postalCode);
  const address = formText(body?.address, 240);
  return {
    addressLine1,
    addressLine2,
    city,
    state: stateResult.value,
    postalCode: postalResult.value,
    address: address || [addressLine1, addressLine2, city, stateResult.value, postalResult.value].filter(Boolean).join(', '),
    hasStructuredAddress,
    valid: (!hasStructuredAddress || Boolean(addressLine1)) && stateResult.valid && postalResult.valid
  };
}

function normalizeFormPerson(body, legacyField = 'name') {
  const legacy = splitLegacyName(body?.[legacyField] || body?.personResponsible);
  const hasStructuredName = Object.prototype.hasOwnProperty.call(body || {}, 'firstName')
    || Object.prototype.hasOwnProperty.call(body || {}, 'lastName');
  const firstName = formText(body?.firstName || legacy.firstName, 60);
  const lastName = formText(body?.lastName || legacy.lastName, 80);
  return {
    firstName,
    lastName,
    name: [firstName, lastName].filter(Boolean).join(' ') || legacy.name,
    hasStructuredName,
    valid: !hasStructuredName || (Boolean(firstName) && Boolean(lastName))
  };
}

function normalizeRentalDate(value) {
  const date = formText(value, 10);
  return { value: date, valid: /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) };
}

function normalizeRentalTime(value) {
  const time = formText(value, 5);
  return { value: time, valid: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) };
}

async function requireSessionState(request, env, ctx) {
  const url = new URL(request.url);
  url.pathname = '/api/me';
  url.search = '';
  const response = await worker.fetch(new Request(url.toString(), {
    method: 'GET',
    headers: request.headers
  }), env, ctx);
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

function canViewDeveloperDiagnostics(sessionState) {
  if (!sessionState?.user) return false;
  return sessionState?.user?.developer === true
    || sessionState?.capabilities?.developer === true
    || sessionState?.capabilities?.diagnostics?.view === true;
}

function authFailure(status, code, message) {
  return json({ error: { code, message } }, status);
}

function requiredOuterPermission(pathname, method) {
  if (pathname === '/api/profiles' || pathname === '/api/export') return PERMISSIONS.SETTINGS_MANAGE;
  if (pathname === '/api/livestream' || pathname === '/api/settings' || pathname.startsWith('/api/theme/')) {
    return PERMISSIONS.SETTINGS_MANAGE;
  }
  return '';
}

function outerRouteRequiresSession(pathname) {
  return pathname === '/api/dashboard/overview'
    || pathname === '/api/account'
    || pathname === '/api/account/password'
    || pathname === '/api/admin/storage-health'
    || pathname === '/api/admin/integration-health';
}

async function enforceOuterPermission(request, env, ctx, permission = '') {
  const state = await requireSession(request, env, ctx);
  if (!state) return authFailure(401, 'AUTH_REQUIRED', 'Cloudflare Access authentication is required.');
  if (permission && (!Array.isArray(state.permissions) || !state.permissions.includes(permission))) {
    return authFailure(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.');
  }
  return null;
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
  fromNameOverride = '',
  submissionId = '', submissionType = ''
} = {}) {
  const toEmail = String(env.SUPPORT_TO_EMAIL || 'support@hldesignedit.com').trim();
  const deliveryToEmail = String(env.SUPPORT_EMAIL_DESTINATION || toEmail).trim();
  const fromEmail = String(env.RESEND_FROM_EMAIL || env.SUPPORT_FROM_EMAIL || 'no-reply@mmmbc.com').trim();
  const fromName = String(fromNameOverride || env.SUPPORT_FROM_NAME || 'MMMBC Website').trim() || 'MMMBC Website';
  const safeSubject = String(subject || '').trim().slice(0, 180);
  const safeBody = String(textBody || '').trim().slice(0, 12000);

  const sender=submissionId ? (env,payload)=>deliverSubmissionEmail(env,{...payload,submissionId,submissionType,kind:'notification'}) : sendResendEmail;
  const out = await sender(env, {
    to: deliveryToEmail,
    subject: safeSubject,
    text: safeBody,
    replyTo,
    fromEmail,
    fromName
  });
  if (!out.ok) {
    throw new Error(out.error || 'Email send failed via Resend.');
  }
}

const READ_ENDPOINTS = new Set([
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
  let galleryItemsCount = 0;
  let galleryAlbumsCount = 0;

  if (env.DB) {
    const announcementsRows = await env.DB.prepare(
      'SELECT id, title, body, created_at, expires_at FROM announcements ORDER BY created_at DESC LIMIT 250'
    ).all().catch(() => ({ results: [] }));
    announcements = Array.isArray(announcementsRows?.results) ? announcementsRows.results : [];

    const eventRows = await env.DB.prepare(
      'SELECT id, title, event_date, event_time, created_at FROM events ORDER BY event_date ASC, event_time ASC LIMIT 250'
    ).all().catch(() => ({ results: [] }));
    events = Array.isArray(eventRows?.results) ? eventRows.results : [];

    const subCountRow = env.SITE_DB
      ? await env.SITE_DB.prepare(
          "SELECT COUNT(*) AS c FROM subscribers WHERE lower(coalesce(status, 'active')) = 'active'"
        ).first().catch(() => ({ c: 0 }))
      : { c: 0 };
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

    const galleryCountRow = await env.DB.prepare(
      `SELECT
          COUNT(*) AS items_count,
          COUNT(DISTINCT CASE WHEN trim(coalesce(album, '')) <> '' THEN trim(album) ELSE NULL END) AS albums_count
       FROM gallery_items`
    ).first().catch(() => null);
    galleryItemsCount = Number(galleryCountRow?.items_count || 0);
    galleryAlbumsCount = Number(galleryCountRow?.albums_count || 0);
  } else {
    const announcementData = await readAssetJson(request, env, '/announcements.json', { posts: [] });
    announcements = Array.isArray(announcementData?.posts) ? announcementData.posts : [];

    const eventData = await readAssetJson(request, env, '/schedule.json', []);
    events = Array.isArray(eventData?.events)
      ? eventData.events
      : (Array.isArray(eventData) ? eventData : []);

    const galleryData = await readAssetJson(request, env, '/gallery.json', { items: [], albums: [] });
    const galleryItems = Array.isArray(galleryData?.items) ? galleryData.items : (Array.isArray(galleryData) ? galleryData : []);
    const galleryAlbums = Array.isArray(galleryData?.albums) ? galleryData.albums : [];
    galleryItemsCount = galleryItems.length;
    galleryAlbumsCount = galleryAlbums.length;
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
      galleryItems: galleryItemsCount,
      galleryAlbums: galleryAlbumsCount
    },
    needsAttention,
    upcomingEvents: upcoming14.slice(0, 8).map((row) => ({
      title: row.title,
      date: row.date,
      time: row.time
    })),
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
    permissions: {}
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

  if (!html.includes('id="mmmbc-admin-structure-js"')) {
    html = html.replace('</body>', `${STRUCTURE_SCRIPT}\n</body>`);
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(html, { status: response.status, headers });
}

async function transformPublicHtml(response, pathname) {
  const type = String(response.headers.get('Content-Type') || '').toLowerCase();
  if (!type.includes('text/html')) return response;

  let html = await response.text();
  const pageHref = '/give';

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
      `<div class="hero-giving-actions" data-mmmbc-hero-give>$1<a href="/give" class="btn-give">Give Online</a></div>`
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(html, { status: response.status, headers });
}

const applicationWorker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const workspaceResponse = await handleWorkspaceRequest(request, env);
    if (workspaceResponse) return workspaceResponse;
    const shellRoute = resolveRoute(url.pathname, url.hash);
    if (shellRoute && (request.method === 'GET' || request.method === 'HEAD')) {
      try {
        await authenticateAdminRequest(request, env, env.__ACCESS_JWKS ? { jwks: env.__ACCESS_JWKS } : {});
      } catch (error) {
        if (error.status !== 401) return authErrorResponse(error);
        const login = new URL('/cdn-cgi/access/login', url.origin);
        login.searchParams.set('redirect_url', url.href);
        return new Response(null, { status: 302, headers: { Location: login.href, 'Cache-Control': 'no-store' } });
      }
      if (legacyRoutes[url.pathname]) return new Response(null, { status: 302,
        headers: { Location: '/admin/' + shellRoute.module, 'Cache-Control': 'no-store' } });
      const assetUrl = new URL('/admin/index.html', url.origin);
      const headers = new Headers(request.headers);
      headers.set('Accept-Encoding', 'identity');
      const response = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers }));
      return request.method === 'HEAD' ? response : transformAdminHtml(response);
    }

    if (url.pathname === '/scan' || url.pathname.startsWith('/scan/') || url.pathname === '/scan.js') return json({error:'Scanning has been retired.'},410);
    const preferences=await handleNewsletterPreferences(request,env);
    if(preferences) return preferences;

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
      const siteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
      const secretPresent = Boolean(String(env.TURNSTILE_SECRET_KEY || '').trim());
      out.verificationRequired = Boolean(secretPresent || String(env.ENVIRONMENT || '').toLowerCase() === 'production');
      out.formVerificationUnavailable = String(env.ENVIRONMENT || '').toLowerCase() === 'production'
        && (!siteKey || !secretPresent);
      if (siteKey && !out.formVerificationUnavailable) out.turnstileSiteKey = siteKey;
      else delete out.turnstileSiteKey;
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
      const input=await request.clone().json().catch(()=>({}));
      const signupEmail=String(input.email||'').trim().toLowerCase();
      if(env.DB) {
        const suppressed=await env.DB.prepare("SELECT email FROM newsletter_suppressions WHERE email=? UNION SELECT email FROM newsletter_subscribers WHERE lower(email)=? AND status IN ('unsubscribed','suppressed','bounced','complained') LIMIT 1").bind(signupEmail,signupEmail).first();
        if(suppressed) return json({error:'This address has opted out. Please contact the church to request renewed subscription consent.'},409);
      }

      const body = await request.json().catch(() => ({}));
      if (honeypotTripped(body)) return json({ ok: true, email: '' });
      const demoMode = previewDemoModeEnabled(env);
      const email = String(body?.email || '').trim().toLowerCase();
      const firstName = formText(body?.firstName, 60);
      const lastName = formText(body?.lastName, 80);
      if (Boolean(firstName) !== Boolean(lastName)) return json({ error: 'First and last name are required.' }, 400);
      const name = (firstName ? `${firstName} ${lastName}` : formText(body?.name, 140)).slice(0, 140);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'A valid email is required.' }, 400);
      }
      if (!name) return json({ error: 'First and last name are required.' }, 400);
      if (!demoMode) {
        const rate = await checkRateLimit(env, request, 'newsletter_subscribe', { max: 5, windowSeconds: 600 });
        if (!rate.ok) return json({ error: rate.error }, 429);
        const turnstile = await verifyTurnstile(env, body?.turnstileToken, clientIp(request));
        if (!turnstile.ok) return json({ error: turnstile.error }, turnstile.status || 403);
      }
      if (!env.SITE_DB) return json({ error: 'Subscriptions are temporarily unavailable.' }, 503);
      const prior = await env.SITE_DB.prepare('SELECT status FROM subscribers WHERE lower(email)=? LIMIT 1').bind(email).first();
      if (prior && ['unsubscribed','suppressed','bounced','complained'].includes(prior.status)) return json({error:'This address has opted out. Please contact the church to renew your consent.'},409);
      const now = new Date().toISOString();
      try {
        await env.SITE_DB.prepare(
        `INSERT INTO subscribers (id, email, name, status, created_at)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT(email) DO UPDATE SET
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE subscribers.name END,
           status = 'active'`
        ).bind(crypto.randomUUID(), email, name, now).run();
      } catch (error) {
        console.error('Newsletter subscriber could not be saved', error);
        return json({ error: 'The newsletter list is temporarily unavailable. Please try again later.' }, 503);
      }
      return json({ ok: true, email });
    }

    if (url.pathname === '/api/public/contact-message' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (JSON.stringify(body).length > 20000) return json({ error: 'Submission is too large.' }, 413);
      if (honeypotTripped(body)) return json({ ok: true });
      const demoMode = previewDemoModeEnabled(env);
      const person = normalizeFormPerson(body);
      const email = normalizeFormEmail(body?.email);
      const phoneResult = normalizeFormPhone(body?.phone);
      const addressResult = normalizeFormAddress(body);
      const message = formMessage(body?.message);
      if (!person.name || !message) return json({ error: 'First name, last name, and message are required.' }, 400);
      if (!person.valid) return json({ error: 'First name and last name are required.' }, 400);
      if (!email) return json({ error: 'A valid email is required.' }, 400);
      if (!phoneResult.valid) return json({ error: 'Enter a valid 10-digit phone number.' }, 400);
      if (!addressResult.valid) return json({ error: 'Enter a complete address with a valid state and ZIP code.' }, 400);
      if (!env.SITE_DB) return json({ error: 'The website inbox is temporarily unavailable. Please try again later.' }, 503);
      const name = person.name.slice(0, 140);
      const phone = phoneResult.value;
      const address = addressResult.address;

      if (!demoMode) {
        const rate = await checkRateLimit(env, request, 'contact_message', { max: 5, windowSeconds: 600 });
        if (!rate.ok) return json({ error: rate.error }, 429);
        const turnstile = await verifyTurnstile(env, body?.turnstileToken, clientIp(request));
        if (!turnstile.ok) return json({ error: turnstile.error }, turnstile.status || 403);
      }

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      // Persist before attempting email so the submission is never lost if Resend/email fails.
      try {
        await env.SITE_DB.prepare(
          `INSERT INTO contact_messages
           (id, name, first_name, last_name, email, phone, address, address_line1, address_line2,
            city, state, postal_code, message, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
        ).bind(
          id, name, person.firstName, person.lastName, email, phone, address,
          addressResult.addressLine1, addressResult.addressLine2, addressResult.city,
          addressResult.state, addressResult.postalCode, message, createdAt
        ).run();
      } catch (error) {
        if (!isMissingSiteColumn(error)) {
          console.error('Website contact message could not be saved', error);
          return json({ error: 'The website inbox could not save your message. Please try again later.' }, 503);
        }
        try {
          // 0001 already has these fields. Preserve the full name and address until 0003 is applied.
          await env.SITE_DB.prepare(
            `INSERT INTO contact_messages (id, name, email, phone, address, message, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'received', ?)`
          ).bind(id, name, email, phone, address, message, createdAt).run();
        } catch (fallbackError) {
          console.error('Website contact message could not be saved to site database', fallbackError);
          return json({ error: 'The website inbox could not save your message. Please try again later.' }, 503);
        }
      }

      if (demoMode) {
        if (env.SITE_DB) {
          await updateSubmissionIfSupported(env.SITE_DB,
            `UPDATE contact_messages
                SET status = 'received', auto_reply_status = 'skipped_demo',
                    auto_reply_at = ?, auto_reply_error = ''
              WHERE id = ?`, [createdAt, id]);
        }
        return json({ ok: true, demo: true });
      }

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
        const autoReply = await sendWebsiteAutoReply(env, { to: email, kind: 'contact', submissionId:id });
        if (env.SITE_DB) await updateSubmissionIfSupported(env.SITE_DB, `UPDATE contact_messages SET auto_reply_status = ?, auto_reply_at = ?, auto_reply_error = ? WHERE id = ?`, [autoReply.ok ? 'sent' : 'failed', autoReply.ok ? new Date().toISOString() : null, autoReply.error || '', id]);
        await sendSupportEmailMessage(env, {
          subject: '[MMMBC Contact] New Website Message',
          textBody,
          replyTo: email,
          fromNameOverride: 'MMMBC Public Contact', submissionId:id, submissionType:'contact'
        });
        if (env.SITE_DB) {
          await updateSubmissionIfSupported(env.SITE_DB, `UPDATE contact_messages SET status = 'emailed' WHERE id = ?`, [id]);
        }
        return json(autoReply.ok ? { ok: true } : { ok: true, warning: 'Message received, but the confirmation email could not be sent.' });
      } catch (e) {
        const errMsg = String(e?.message || e).slice(0, 500);
        if (env.SITE_DB) {
          await updateSubmissionIfSupported(env.SITE_DB,
            `UPDATE contact_messages SET status = 'email_failed', email_error = ? WHERE id = ?`, [errMsg, id]);
        }
        // The message was still saved (if SITE_DB is configured); tell the visitor it was received.
        return json(env.SITE_DB
          ? { ok: true, warning: 'Message received; an email notification could not be sent. Please check Website Messages for delivery details.' }
          : { error: `Unable to send message. ${errMsg}` }, env.SITE_DB ? 200 : 502);
      }
    }

    if (url.pathname === '/api/public/facility-rental-request' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (JSON.stringify(body).length > 20000) return json({ error: 'Submission is too large.' }, 413);
      if (honeypotTripped(body)) return json({ ok: true });
      const demoMode = previewDemoModeEnabled(env);
      const audience = String(body?.audience || '').trim().toLowerCase() === 'non_member' ? 'non_member' : 'member';
      const form = (body?.form && typeof body.form === 'object') ? body.form : {};
      const person = normalizeFormPerson(form, 'personResponsible');
      const phoneResult = normalizeFormPhone(form.phone);
      const addressResult = normalizeFormAddress(form);
      const contactEmail = normalizeFormEmail(form.contactEmail);
      const eventGroup = formText(form.eventGroup, 140);
      const purpose = formText(form.purpose, 240);
      const dateResult = normalizeRentalDate(form.dateOfUse);
      const timeFromResult = normalizeRentalTime(form.timeFrom);
      const timeToResult = normalizeRentalTime(form.timeTo);
      const facilities = Array.isArray(form.facilities)
        ? form.facilities.map((item) => formText(item, 120)).filter(Boolean).slice(0, 10)
        : [];
      const responsibleSignature = formText(form.responsibleSignature, 140);
      const responsibleSignatureDate = formText(form.responsibleSignatureDate, 10);
      if (!eventGroup || !person.name || !purpose || !dateResult.value || !timeFromResult.value || !timeToResult.value || !facilities.length || !responsibleSignature || !responsibleSignatureDate) {
        return json({ error: 'Please complete all required rental fields.' }, 400);
      }
      if (!person.valid) return json({ error: 'First name and last name are required.' }, 400);
      if (!phoneResult.valid || !phoneResult.value) return json({ error: 'Enter a valid 10-digit phone number.' }, 400);
      if (!contactEmail) return json({ error: 'A valid email is required for your confirmation.' }, 400);
      if (!addressResult.valid) return json({ error: 'Enter a complete address with a valid state and ZIP code.' }, 400);
      if (!dateResult.valid || !timeFromResult.valid || !timeToResult.valid || timeToResult.value <= timeFromResult.value) {
        return json({ error: 'Choose a valid date and a start/end time range.' }, 400);
      }
      if (!env.SITE_DB) return json({ error: 'The website inbox is temporarily unavailable. Please try again later.' }, 503);

      const normalizedForm = {
        ...form,
        eventGroup,
        firstName: person.firstName,
        lastName: person.lastName,
        personResponsible: person.name,
        phone: phoneResult.value,
        addressLine1: addressResult.addressLine1,
        addressLine2: addressResult.addressLine2,
        city: addressResult.city,
        state: addressResult.state,
        postalCode: addressResult.postalCode,
        address: addressResult.address,
        purpose,
        dateOfUse: dateResult.value,
        timeFrom: timeFromResult.value,
        timeTo: timeToResult.value,
        facilities,
        responsibleSignature,
        responsibleSignatureDate,
        contactEmail
      };

      if (!demoMode) {
        const rate = await checkRateLimit(env, request, 'facility_rental_request', { max: 5, windowSeconds: 600 });
        if (!rate.ok) return json({ error: rate.error }, 429);
        const turnstile = await verifyTurnstile(env, body?.turnstileToken, clientIp(request));
        if (!turnstile.ok) return json({ error: turnstile.error }, turnstile.status || 403);
      }

      const formLines = [];
      for (const [key, value] of Object.entries(normalizedForm)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          formLines.push(`${key}: ${value.join(', ')}`);
          continue;
        }
        formLines.push(`${key}: ${formText(value, 500)}`);
      }

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      try {
        await env.SITE_DB.prepare(
          `INSERT INTO facility_rental_requests
             (id, audience, person_responsible, first_name, last_name, phone, purpose, date_of_use,
              time_from, time_to, contact_email, address, address_line1, address_line2, city, state,
              postal_code, form_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
        ).bind(
          id, audience, person.name, person.firstName, person.lastName, phoneResult.value, purpose,
          dateResult.value, timeFromResult.value, timeToResult.value, contactEmail, addressResult.address,
          addressResult.addressLine1, addressResult.addressLine2, addressResult.city, addressResult.state,
          addressResult.postalCode, JSON.stringify(normalizedForm).slice(0, 20000), createdAt
        ).run();
      } catch (error) {
        if (!isMissingSiteColumn(error)) {
          console.error('Facility rental request could not be saved', error);
          return json({ error: 'The website inbox could not save your request. Please try again later.' }, 503);
        }
        try {
          await env.SITE_DB.prepare(
            `INSERT INTO facility_rental_requests
               (id, audience, person_responsible, phone, purpose, date_of_use,
                time_from, time_to, contact_email, form_json, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
          ).bind(id, audience, person.name, phoneResult.value, purpose, dateResult.value,
            timeFromResult.value, timeToResult.value, contactEmail,
            JSON.stringify(normalizedForm).slice(0, 20000), createdAt).run();
        } catch (fallbackError) {
          console.error('Facility rental request could not be saved to site database', fallbackError);
          return json({ error: 'The website inbox could not save your request. Please try again later.' }, 503);
        }
      }

      if (demoMode) {
        if (env.SITE_DB) {
          await updateSubmissionIfSupported(env.SITE_DB,
            `UPDATE facility_rental_requests
                SET status = 'received', auto_reply_status = 'skipped_demo',
                    auto_reply_at = ?, auto_reply_error = ''
              WHERE id = ?`, [createdAt, id]);
        }
        return json({ ok: true, demo: true });
      }

      const textBody = [
        `Facility rental request (${audience === 'non_member' ? 'Non-member' : 'Member'})`,
        `Submitted at: ${createdAt}`,
        '',
        ...formLines
      ].join('\n');

      try {
        const autoReply = await sendWebsiteAutoReply(env, { to: contactEmail, kind: 'facility_rental', submissionId:id });
        await updateSubmissionIfSupported(env.SITE_DB, `UPDATE facility_rental_requests SET auto_reply_status = ?, auto_reply_at = ?, auto_reply_error = ? WHERE id = ?`, [autoReply.ok ? 'sent' : 'failed', autoReply.ok ? new Date().toISOString() : null, autoReply.error || '', id]);
        await sendSupportEmailMessage(env, {
          subject: `[MMMBC Facility Rental] ${audience === 'non_member' ? 'Non-member' : 'Member'} Request`,
          textBody,
          replyTo: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) ? contactEmail : '',
          fromNameOverride: 'MMMBC Public Facility Rental', submissionId:id, submissionType:'facility_rental'
        });
        if (env.SITE_DB) {
          await updateSubmissionIfSupported(env.SITE_DB, `UPDATE facility_rental_requests SET status = 'emailed' WHERE id = ?`, [id]);
        }
        return json(autoReply.ok ? { ok: true } : { ok: true, warning: 'Request received, but the confirmation email could not be sent.' });
      } catch (e) {
        const errMsg = String(e?.message || e).slice(0, 500);
        if (env.SITE_DB) {
          await updateSubmissionIfSupported(env.SITE_DB,
            `UPDATE facility_rental_requests SET status = 'email_failed', email_error = ? WHERE id = ?`, [errMsg, id]);
        }
        return json(env.SITE_DB
          ? { ok: true, warning: 'Request received; email notification is delayed.' }
          : { error: `Unable to send request. ${errMsg}` }, env.SITE_DB ? 200 : 502);
      }
    }

    if (url.pathname === '/api/submissions' || url.pathname.startsWith('/api/submissions/')) {
      return handleWebsiteSubmissions(request, env, ctx);
    }

    // Core auth/session routes are implemented in worker-auth-wrapper.
    // Forward them explicitly so they are not caught by the generic /api 404 guard below.
    if (url.pathname === '/api/auth/logout' && (request.method === 'GET' || request.method === 'POST')) {
      return worker.fetch(request, env, ctx);
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      return worker.fetch(request, env, ctx);
    }

    if (url.pathname === '/api/csrf' && request.method === 'GET') {
      return worker.fetch(request, env, ctx);
    }

    if (url.pathname.startsWith('/api/site-content/') && request.method === 'GET') {
      const page = decodeURIComponent(url.pathname.slice('/api/site-content/'.length));
      return handlePublicSiteContentGet(request, env, page);
    }

    const outerPermission = requiredOuterPermission(url.pathname, request.method);
    if (outerPermission || outerRouteRequiresSession(url.pathname)) {
      const denied = await enforceOuterPermission(request, env, ctx, outerPermission);
      if (denied) return denied;
    }

    if (request.method === 'GET' && READ_ENDPOINTS.has(url.pathname)) {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);


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
      url.pathname.startsWith('/api/users/') ||
      url.pathname === '/api/users/roles' ||
      url.pathname === '/api/audit-log' ||
      url.pathname === '/api/admin/audit-log' ||
      url.pathname === '/api/admin/settings/roles' ||
      url.pathname === '/api/admin/settings/users' ||
      url.pathname.startsWith('/api/admin/settings/users/') ||
      url.pathname === '/api/admin/users' ||
      url.pathname.startsWith('/api/admin/users/')
    ) {
      return worker.fetch(request, env, ctx);
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
      const sessionState = await requireSessionState(request, env, ctx);
      const user = sessionState?.user || null;
      if (!user) return json({ error: 'Unauthorized' }, 401);
      if (!canViewDeveloperDiagnostics(sessionState)) {
        return authFailure(403, 'DEVELOPER_DIAGNOSTICS_REQUIRED', 'Developer diagnostics access is required for this action.');
      }
      const checkDatabase = async (db) => {
        if (!db || typeof db.prepare !== 'function') return 'missing';
        try {
          await db.prepare('SELECT 1 AS ok').first();
          return 'healthy';
        } catch (error) {
          console.error('Diagnostics database check failed', error);
          return 'unavailable';
        }
      };
      const [adminDatabase, siteDatabase] = await Promise.all([
        checkDatabase(env.DB), checkDatabase(env.SITE_DB)
      ]);
      const checks = {
        adminDatabase,
        siteDatabase,
        galleryBucket: env.GALLERY_BUCKET ? 'configured' : 'missing',
        staticAssets: env.ASSETS && typeof env.ASSETS.fetch === 'function' ? 'configured' : 'missing',
        transactionalEmail: env.RESEND_API_KEY && env.RESEND_FROM_EMAIL ? 'configured' : 'missing'
      };
      const degraded = Object.values(checks).some((status) => status === 'missing' || status === 'unavailable');
      return json({ ok: !degraded, degraded, checkedAt: new Date().toISOString(), storage: { mode: 'Cloudflare D1 + R2' }, checks });
    }

    if (url.pathname === '/api/admin/integration-health' && request.method === 'GET') {
      const sessionState = await requireSessionState(request, env, ctx);
      const user = sessionState?.user || null;
      if (!user) return json({ error: 'Unauthorized' }, 401);
      if (!canViewDeveloperDiagnostics(sessionState)) {
        return authFailure(403, 'DEVELOPER_DIAGNOSTICS_REQUIRED', 'Developer diagnostics access is required for this action.');
      }
      return json({
        ok: true,
        checkedAt: new Date().toISOString(),
        actor: String(user?.email || ''),
        checks: {
          dbBinding: Boolean(env.DB),
          assetsBinding: Boolean(env.ASSETS && typeof env.ASSETS.fetch === 'function'),
          galleryBucketBinding: Boolean(env.GALLERY_BUCKET),
          resendConfigured: Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL)
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

    // The visual site editor is implemented by the primary Worker. Forward its
    // authenticated draft/publish/media routes before the wrapper's unknown-API
    // guard so Cloudflare production uses the same D1-backed editor surface.
    if (url.pathname === '/api/admin/site-pages' || url.pathname.startsWith('/api/admin/site-pages/')) {
      return worker.fetch(request, env, ctx);
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
    try { await retrySubmissionEmails(env); } catch (error) { console.error('Submission email retry failed', { name: error?.name || 'Error' }); }
    if (typeof worker.scheduled === 'function') {
      return worker.scheduled(event, env, ctx);
    }
  }
};


export default {
  async fetch(request,env,ctx) {
    const path=new URL(request.url).pathname;
    try {
      if(mutationDenied(request)) return securityHeaders(json({error:'Requests must come from this website.'},403),path);
      const max=request.headers.get('content-type')?.includes('multipart/form-data') ? 20*1024*1024 : 1024*1024;
      if(!await checkBodySize(request,max)) return securityHeaders(json({error:'Request is too large.'},413),path);
      return securityHeaders(await applicationWorker.fetch(request,env,ctx),path);
    } catch(error) {
      console.error('Request failed',{path,name:error?.name||'Error'});
      return securityHeaders(json({error:'This service is temporarily unavailable. Please try again.'},503),path);
    }
  },
  scheduled: applicationWorker.scheduled
};
