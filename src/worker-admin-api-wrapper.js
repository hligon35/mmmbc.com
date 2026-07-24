import worker from './worker-auth-wrapper.js';

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
  '/api/events',
  '/api/announcements',
  '/api/bulletins',
  '/api/subscribers',
  '/api/finances',
  '/api/profiles',
  '/api/newsletter/records'
]);

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && READ_ENDPOINTS.has(url.pathname)) {
      const user = await requireSession(request, env, ctx);
      if (!user) return json({ error: 'Unauthorized' }, 401);

      if (url.pathname === '/api/announcements') {
        const data = await readAssetJson(request, env, '/announcements.json', { posts: [] });
        return json(normalizeAnnouncements(data));
      }

      if (url.pathname === '/api/events') {
        const data = await readAssetJson(request, env, '/schedule.json', { events: [] });
        return json(normalizeEvents(data));
      }

      if (url.pathname === '/api/bulletins') {
        const data = await readAssetJson(request, env, '/bulletins.json', { bulletins: [] });
        return json(normalizeBulletins(data));
      }

      if (url.pathname === '/api/subscribers') return json({ subscribers: [] });
      if (url.pathname === '/api/finances') return json(emptyFinances());

      if (url.pathname === '/api/profiles') {
        const data = await readAssetJson(request, env, '/profiles.json', { profiles: [], metadata: {} });
        return json(data && typeof data === 'object' ? data : { profiles: [], metadata: {} });
      }

      if (url.pathname === '/api/newsletter/records') return json({ records: [] });
    }

    const response = await worker.fetch(request, env, ctx);
    if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/')) {
      return transformAdminHtml(response);
    }
    return response;
  }
};
