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

      if (url.pathname === '/api/subscribers') {
        return json({ subscribers: [] });
      }

      if (url.pathname === '/api/finances') {
        return json(emptyFinances());
      }

      if (url.pathname === '/api/profiles') {
        const data = await readAssetJson(request, env, '/profiles.json', { profiles: [], metadata: {} });
        return json(data && typeof data === 'object' ? data : { profiles: [], metadata: {} });
      }

      if (url.pathname === '/api/newsletter/records') {
        return json({ records: [] });
      }
    }

    return worker.fetch(request, env, ctx);
  }
};
