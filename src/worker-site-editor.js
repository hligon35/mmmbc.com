// D1-backed storage + API handlers for the visual website editor (draft/published
// content per public page). Mirrors the conventions in src/worker-communications.js.
// Route wiring + admin-permission checks live in src/worker.js (which calls
// requireAdmin() before invoking any handler here, passing the authenticated email).

import { PAGE_KEYS, getPageSchema, INITIAL_PUBLISHED_CONTENT } from './site-editor-schema.js';
import { validatePageFields } from './site-editor-validate.js';

function json(resBody, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(resBody), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePageKey(page) {
  return String(page || '').trim().toLowerCase();
}

function parseJsonColumn(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Idempotent migration: creates the D1 row for a page the first time it's needed,
// seeded from INITIAL_PUBLISHED_CONTENT so the public site's appearance is unchanged.
// Never overwrites an existing row.
async function ensurePageRow(env, page) {
  const existing = await env.DB.prepare('SELECT * FROM site_page_content WHERE page = ?').bind(page).first();
  if (existing) return existing;

  const seed = INITIAL_PUBLISHED_CONTENT[page] || {};
  const seedJson = JSON.stringify(seed);
  const ts = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO site_page_content
        (page, draft_fields, draft_version, draft_updated_at, draft_updated_by,
         published_fields, published_version, published_updated_at, published_updated_by, created_at)
       VALUES (?, ?, 1, ?, 'system:migration', ?, 1, ?, 'system:migration', ?)`
    ).bind(page, seedJson, ts, seedJson, ts, ts).run();
  } catch {
    // Row may have been created concurrently — re-read below regardless.
  }
  return env.DB.prepare('SELECT * FROM site_page_content WHERE page = ?').bind(page).first();
}

// Fills in any schema field that isn't present yet in a stored fields object using its
// INITIAL_PUBLISHED_CONTENT seed value. This lets new fields (added to the schema after
// a page's D1 row already existed) show up immediately with the value that matches the
// current live static HTML, without ever overwriting a value someone already edited.
function mergeWithSeed(page, storedFields) {
  const seed = INITIAL_PUBLISHED_CONTENT[page] || {};
  const stored = isPlainObject(storedFields) ? storedFields : {};
  const merged = { ...seed, ...stored };
  for (const key of Object.keys(seed)) {
    if (!Object.prototype.hasOwnProperty.call(stored, key)) merged[key] = seed[key];
  }
  return merged;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function rowToPageState(page, row) {
  return {
    draft: {
      fields: mergeWithSeed(page, parseJsonColumn(row.draft_fields, {})),
      version: row.draft_version,
      updatedAt: row.draft_updated_at,
      updatedBy: row.draft_updated_by
    },
    published: {
      fields: mergeWithSeed(page, parseJsonColumn(row.published_fields, {})),
      version: row.published_version,
      updatedAt: row.published_updated_at,
      updatedBy: row.published_updated_by
    }
  };
}

export async function handleSitePagesList(request, env) {
  const pages = [];
  for (const page of PAGE_KEYS) {
    const row = await ensurePageRow(env, page);
    pages.push({
      page,
      label: getPageSchema(page).label,
      draftVersion: row.draft_version,
      publishedVersion: row.published_version,
      draftUpdatedAt: row.draft_updated_at,
      publishedUpdatedAt: row.published_updated_at
    });
  }
  return json({ pages });
}

export async function handleSitePageGet(request, env, page) {
  const key = normalizePageKey(page);
  const schema = getPageSchema(key);
  if (!schema) return json({ error: `Unknown page "${page}".` }, 404);

  const row = await ensurePageRow(env, key);
  const state = rowToPageState(key, row);
  return json({
    page: key,
    label: schema.label,
    fields: schema.fields,
    ...state
  });
}

export async function handleSitePageDraftPut(request, env, page, actorEmail) {
  const key = normalizePageKey(page);
  const schema = getPageSchema(key);
  if (!schema) return json({ error: `Unknown page "${page}".` }, 404);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request body.' }, 400);

  const row = await ensurePageRow(env, key);
  const baseVersion = Number.isFinite(body.baseVersion) ? body.baseVersion : null;
  if (baseVersion !== null && baseVersion !== row.draft_version) {
    return json({
      error: 'This draft was changed elsewhere since you loaded it. Reload the page draft before saving again.',
      code: 'STALE_DRAFT',
      currentVersion: row.draft_version
    }, 409);
  }

  // Merge onto the existing draft so a save that only includes changed keys doesn't
  // clobber other fields; unknown keys are rejected by validatePageFields.
  const existingDraft = parseJsonColumn(row.draft_fields, {});
  const mergedInput = { ...existingDraft, ...(body.fields && typeof body.fields === 'object' ? body.fields : {}) };

  const { ok, fields, errors } = validatePageFields(key, mergedInput, { partial: true });
  if (!ok) return json({ error: 'Validation failed.', details: errors }, 400);

  const ts = nowIso();
  const nextVersion = row.draft_version + 1;
  const email = String(actorEmail || 'unknown').toLowerCase();

  await env.DB.prepare(
    `UPDATE site_page_content
       SET draft_fields = ?, draft_version = ?, draft_updated_at = ?, draft_updated_by = ?
     WHERE page = ?`
  ).bind(JSON.stringify(fields), nextVersion, ts, email, key).run();

  return json({
    page: key,
    draft: { fields, version: nextVersion, updatedAt: ts, updatedBy: email }
  });
}

export async function handleSitePagePublishPost(request, env, page, actorEmail) {
  const key = normalizePageKey(page);
  const schema = getPageSchema(key);
  if (!schema) return json({ error: `Unknown page "${page}".` }, 404);

  const body = await request.json().catch(() => ({}));
  const row = await ensurePageRow(env, key);

  const baseVersion = Number.isFinite(body?.baseVersion) ? body.baseVersion : null;
  if (baseVersion !== null && baseVersion !== row.draft_version) {
    return json({
      error: 'The saved draft changed since you loaded it. Reload before publishing.',
      code: 'STALE_DRAFT',
      currentVersion: row.draft_version
    }, 409);
  }

  const draftFields = parseJsonColumn(row.draft_fields, {});
  const { ok, fields, errors } = validatePageFields(key, draftFields, { partial: false });
  if (!ok) return json({ error: 'The draft is incomplete or invalid and cannot be published.', details: errors }, 400);

  const ts = nowIso();
  const email = String(actorEmail || 'unknown').toLowerCase();
  const nextPublishedVersion = row.published_version + 1;

  await env.DB.prepare(
    `UPDATE site_page_content
       SET published_fields = ?, published_version = ?, published_updated_at = ?, published_updated_by = ?,
           previous_published_fields = ?, previous_published_version = ?, previous_published_updated_at = ?
     WHERE page = ?`
  ).bind(
    JSON.stringify(fields), nextPublishedVersion, ts, email,
    row.published_fields, row.published_version, row.published_updated_at,
    key
  ).run();

  return json({
    page: key,
    published: { fields, version: nextPublishedVersion, updatedAt: ts, updatedBy: email }
  });
}

// One-level "undo publish": swaps the current published content back to whatever was
// published immediately before it (stored in previous_published_* since the schema's
// initial release). This is not full multi-revision history — only the single most
// recent prior publish can be restored, and restoring again just toggles back and forth
// between the two most recent published versions.
export async function handleSitePageRestorePreviousPost(request, env, page, actorEmail) {
  const key = normalizePageKey(page);
  const schema = getPageSchema(key);
  if (!schema) return json({ error: `Unknown page "${page}".` }, 404);

  const row = await ensurePageRow(env, key);
  if (!row.previous_published_fields) {
    return json({ error: 'There is no earlier published version to restore.' }, 400);
  }

  const ts = nowIso();
  const email = String(actorEmail || 'unknown').toLowerCase();
  const nextPublishedVersion = row.published_version + 1;

  await env.DB.prepare(
    `UPDATE site_page_content
       SET published_fields = ?, published_version = ?, published_updated_at = ?, published_updated_by = ?,
           previous_published_fields = ?, previous_published_version = ?, previous_published_updated_at = ?
     WHERE page = ?`
  ).bind(
    row.previous_published_fields, nextPublishedVersion, ts, email,
    row.published_fields, row.published_version, row.published_updated_at,
    key
  ).run();

  return json({
    page: key,
    published: { fields: mergeWithSeed(key, parseJsonColumn(row.previous_published_fields, {})), version: nextPublishedVersion, updatedAt: ts, updatedBy: email }
  });
}

export async function handleSitePageMediaUpload(request, env, page) {
  const key = normalizePageKey(page);
  if (!getPageSchema(key)) return json({ error: `Unknown page "${page}".` }, 404);
  if (!env.GALLERY_BUCKET) return json({ error: 'Media storage is not configured.' }, 500);

  const ct = String(request.headers.get('content-type') || '');
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data.' }, 400);
  }

  const form = await request.formData();
  const file = form.get('image');
  if (!(file instanceof File)) return json({ error: 'Missing "image" file.' }, 400);

  const MAX_BYTES = 8 * 1024 * 1024;
  if (file.size > MAX_BYTES) return json({ error: 'Image exceeds the 8MB limit.' }, 400);

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const type = String(file.type || '').toLowerCase();
  if (!allowedTypes.includes(type)) {
    return json({ error: 'Only JPEG, PNG, WEBP, or GIF images are allowed.' }, 400);
  }

  const safeName = String(file.name || 'image')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(-80);
  const fileKey = `site-content/${key}/${Date.now()}-${safeName}`;

  await env.GALLERY_BUCKET.put(fileKey, await file.arrayBuffer(), {
    httpMetadata: { contentType: type }
  });

  return json({ url: `/cdn/gallery/${encodeURI(fileKey)}` });
}

// Public, unauthenticated: published content only. Never touches draft data and
// never writes to D1 (falls back to the static seed if the row doesn't exist yet,
// so it can't be used to force a migration write from an unauthenticated request).
export async function handlePublicSiteContentGet(request, env, page) {
  const key = normalizePageKey(page);
  const schema = getPageSchema(key);
  if (!schema) return json({ error: 'Not found.' }, 404);

  let fields = INITIAL_PUBLISHED_CONTENT[key] || {};
  let version = 1;
  let updatedAt = null;

  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT published_fields, published_version, published_updated_at FROM site_page_content WHERE page = ?'
      ).bind(key).first();
      if (row) {
        fields = mergeWithSeed(key, parseJsonColumn(row.published_fields, fields));
        version = row.published_version;
        updatedAt = row.published_updated_at;
      }
    } catch {
      // Fall back to static seed on any D1 error — public page still renders.
    }
  }

  // Short, self-invalidating cache so publishes propagate within ~60s without any
  // explicit purge step; the admin editor also cache-busts its own iframe reload.
  return json(
    { page: key, fields, version, updatedAt },
    200,
    { 'Cache-Control': 'public, max-age=60' }
  );
}
