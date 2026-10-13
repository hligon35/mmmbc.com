import { authenticateAdminRequest, authErrorResponse, requirePermission } from './admin-auth.js';
import { PERMISSIONS } from './admin-rbac.js';
import { imageBytesAllowed } from './launch-security.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const managedImage = key => /^(gallery|site)\/.+\.(jpe?g|png|gif|webp)$/i.test(key);
async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function handleMediaImport(request, env) {
  try {
    const auth = await authenticateAdminRequest(request, env, env.__ACCESS_JWKS ? { jwks: env.__ACCESS_JWKS } : {});
    requirePermission(auth.user, PERMISSIONS.PHOTOS_MANAGE);
  } catch (error) { return authErrorResponse(error); }
  if (!env.DB || !env.GALLERY_BUCKET) return json({ error: 'Media storage is unavailable.' }, 503);
  const url = new URL(request.url);
  if (request.method === 'GET' && url.searchParams.get('key')) {
    const key = url.searchParams.get('key');
    if (!managedImage(key)) return json({ error: 'Unsupported media key.' }, 400);
    const object = await env.GALLERY_BUCKET.get(key);
    if (!object) return json({ error: 'Object not found.' }, 404);
    // Authenticated reads include hidden images solely for exact-content deduplication.
    return new Response(object.body, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream' } });
  }
  if (request.method === 'GET') {
    const list = await env.GALLERY_BUCKET.list({ limit: 1000, cursor: url.searchParams.get('cursor') || undefined });
    const rows = await env.DB.prepare('SELECT id, file_key, thumb_key, is_hidden FROM gallery_items').all();
    const records = new Map();
    for (const row of rows.results || []) {
      records.set(row.file_key, row);
      if (row.thumb_key) records.set(row.thumb_key, row);
    }
    return json({ objects: list.objects.filter(object => managedImage(object.key)).map(object => ({
      key: object.key, size: object.size, etag: object.etag,
      galleryId: records.get(object.key)?.id || null,
      hidden: Boolean(Number(records.get(object.key)?.is_hidden || 0))
    })), nextCursor: list.truncated ? list.cursor : null });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const form = await request.formData();
  const file = form.get('image');
  if (!file || typeof file.arrayBuffer !== 'function' || !TYPES[file.type] || !file.size || file.size > MAX_IMAGE_BYTES) {
    return json({ error: 'Use a JPG, PNG, GIF, or WebP image no larger than 10 MB.' }, 400);
  }
  const bytes = await file.arrayBuffer();
  if (!imageBytesAllowed(bytes, file.type)) return json({ error: 'Image bytes do not match the file type.' }, 400);
  const sha256 = await hash(bytes);
  const reuseKey = String(form.get('reuseKey') || '');
  if (reuseKey) {
    if (!managedImage(reuseKey)) return json({ error: 'Unsupported existing media key.' }, 400);
    const existing = await env.GALLERY_BUCKET.get(reuseKey);
    if (!existing || await hash(await existing.arrayBuffer()) !== sha256) return json({ error: 'Existing media changed; refresh the inventory.' }, 409);
    const registered = await env.DB.prepare('SELECT * FROM gallery_items WHERE file_key=? OR thumb_key=? LIMIT 1').bind(reuseKey, reuseKey).first();
    if (registered) return json({ ok: true, reused: true, sha256, key: reuseKey, galleryId: registered.id,
      hidden: Boolean(Number(registered.is_hidden)), url: '/cdn/gallery/' + encodeURI(reuseKey) });
  }
  // Deterministic identity/key makes retries and competing import processes reuse one record/object.
  const id = 'wp-' + sha256;
  const prior = await env.DB.prepare('SELECT * FROM gallery_items WHERE id=?').bind(id).first();
  if (prior) {
    const stored = await env.GALLERY_BUCKET.get(prior.file_key);
    if (!stored || await hash(await stored.arrayBuffer()) !== sha256) return json({ error: 'Registered image is missing or changed; repair storage before retrying.' }, 409);
    return json({ ok: true, reused: true, sha256, key: prior.file_key, galleryId: prior.id,
      hidden: Boolean(Number(prior.is_hidden)), url: '/cdn/gallery/' + encodeURI(prior.file_key) });
  }
  const key = reuseKey || `gallery/wordpress/${sha256}.${TYPES[file.type]}`;
  if (!reuseKey) await env.GALLERY_BUCKET.put(key, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { sha256 } });
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO gallery_items (id,album,label,tags_json,file_key,thumb_key,original_name,created_at,position,is_hidden)
    VALUES (?,?,?,'[]',?,NULL,?,?,NULL,0) ON CONFLICT(id) DO NOTHING`).bind(id,
      String(form.get('album') || 'WordPress').slice(0,80), String(form.get('label') || file.name).slice(0,240), key, file.name, now).run();
  const record = await env.DB.prepare('SELECT * FROM gallery_items WHERE id=?').bind(id).first();
  return json({ ok: true, reused: Boolean(reuseKey), sha256, key: record.file_key, galleryId: record.id,
    hidden: Boolean(Number(record.is_hidden)), url: '/cdn/gallery/' + encodeURI(record.file_key) });
}
