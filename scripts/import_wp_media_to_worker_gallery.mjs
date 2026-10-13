#!/usr/bin/env node
// Resumable exact-content import into the existing Worker gallery/R2/D1 workflow.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { migrateMedia } from './lib/media-migration.mjs';

const required = name => { if (!process.env[name]) throw new Error(`Missing ${name}.`); return process.env[name]; };
const flag = (name, fallback) => process.env[name] == null ? fallback : /^(true|1|yes)$/i.test(process.env[name]);
function origin(value) {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('Use an HTTPS origin without embedded credentials.');
  return url.origin;
}
export function originalMediaUrl(media) {
  const source = media.source_url || '';
  return media.media_details?.original_image && source ? new URL(media.media_details.original_image, source).href : source;
}
async function readResponse(response, json = false, context = '') {
  if (!response.ok) {
    if (response.status === 404 && context === 'inventory') {
      throw new Error('The Worker media-import endpoint returned 404. Deploy the latest master successfully before migrating; check the Cloudflare build logs.');
    }
    if ([401,403].includes(response.status) && context === 'inventory') {
      throw new Error('The import endpoint rejected authentication. Use a fresh Cloudflare Access session with photo-management permission.');
    }
    throw new Error(`Request failed (${response.status}); check source, storage, and authentication.`);
  }
  if (json && !response.headers.get('content-type')?.includes('application/json')) throw new Error('Expected JSON; the request may be blocked by Cloudflare Access.');
  return json ? response.json() : Buffer.from(await response.arrayBuffer());
}
async function localFiles(root) {
  const files = [];
  async function visit(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir,item.name);
      if (item.isDirectory()) await visit(full);
      else if (item.isFile() && /\.(jpe?g|png|webp|gif|svg|avif|heic)$/i.test(item.name)) {
        const relative = path.relative(root,full).split(path.sep).join('/');
        files.push({ source: full, file: full, name: item.name, label: item.name,
          album: relative.match(/^\d{4}\/\d{2}\//)?.[0].slice(0,-1).replace('/','-') || 'WordPress',
          oldUrls: [new URL('/wp-content/uploads/' + relative.split('/').map(encodeURIComponent).join('/'), process.env.WP_ORIGINAL_URL || 'https://mmmbc.com').href] });
      }
    }
  }
  await visit(root);
  return files.sort((a,b) => a.source.localeCompare(b.source));
}
async function wordpressFiles() {
  const base = required('WP_BASE_URL').replace(/\/+$/, '') + '/';
  origin(base);
  const authorization = 'Basic ' + Buffer.from(required('WP_USERNAME') + ':' + required('WP_APP_PASSWORD')).toString('base64');
  const files = [];
  const maximum = Number(process.env.MAX_PAGES || 1000);
  for (let page = 1; page <= maximum; page++) {
    const url = new URL('wp-json/wp/v2/media', base);
    url.search = new URLSearchParams({ media_type:'image', context:'edit', per_page:'100', page:String(page) });
    const response = await fetch(url, { headers: { authorization }, redirect:'error', signal:AbortSignal.timeout(30000) });
    if (response.status === 400) {
      const body = await response.json().catch(() => ({}));
      if (body.code === 'rest_post_invalid_page_number') return files;
      throw new Error('WordPress rejected the media listing.');
    }
    const media = await readResponse(response,true);
    if (!Array.isArray(media)) throw new Error('Invalid WordPress media response.');
    for (const item of media) {
      const source = originalMediaUrl(item);
      if (!source) throw new Error(`WordPress attachment ${item.id} has no image URL.`);
      files.push({ source, name: decodeURIComponent(new URL(source).pathname.split('/').pop()),
        label: String(item.title?.rendered || item.alt_text || '').replace(/<[^>]*>/g,''), album:String(item.date || '').slice(0,7) || 'WordPress',
        oldUrls: [...new Set([item.source_url, source, ...Object.values(item.media_details?.sizes || {}).map(size => size.source_url)].filter(Boolean))] });
    }
    if (media.length < 100) return files;
  }
  throw new Error('MAX_PAGES reached before completing the WordPress inventory; increase it.');
}

export async function validateLocalSource(value) {
  const dir = path.resolve(value);
  let stat;
  try { stat = await fs.stat(dir); } catch { throw new Error('WP_UPLOADS_DIR does not exist. Set it to the extracted wp-content/uploads folder.'); }
  if (!stat.isDirectory()) throw new Error('WP_UPLOADS_DIR must be a folder of actual image files. A WordPress .xml export contains references, not the image files; obtain an uploads-folder backup.');
  return dir;
}

export async function main() {
  // Validate the source before network requests so exports cannot masquerade as image backups.
  const localSource = process.env.WP_UPLOADS_DIR ? await validateLocalSource(process.env.WP_UPLOADS_DIR) : null;
  if (!localSource) {
    required('WP_BASE_URL'); required('WP_USERNAME'); required('WP_APP_PASSWORD');
  }
  const target = origin(required('TARGET_BASE_URL'));
  const token = required('CF_ACCESS_JWT');
  const headers = { 'Cf-Access-Jwt-Assertion': token, Cookie:'CF_Authorization=' + token };
  const endpoint = new URL('/api/gallery/import', target);
  const manifestPath = path.resolve(process.env.MIGRATION_MANIFEST || '.migration/wordpress-media.json');
  await fs.mkdir(path.dirname(manifestPath), { recursive:true });
  // Prevent competing local writers. Server-side deterministic keys also protect uploads.
  const lockPath = manifestPath + '.lock';
  const lock = await fs.open(lockPath,'wx');
  try {
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath,'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; manifest = { version:1, target }; }
    if (manifest.target !== target) throw new Error('Manifest belongs to a different target. Use a separate manifest.');
    const save = async data => {
      await fs.writeFile(manifestPath + '.tmp',JSON.stringify(data,null,2) + '\n', { mode:0o600 });
      await fs.rename(manifestPath + '.tmp',manifestPath);
    };
    const inventory = [];
    let cursor = '';
    do {
      const url = new URL(endpoint);
      if (cursor) url.searchParams.set('cursor',cursor);
      const result = await readResponse(await fetch(url,{ headers, redirect:'error', signal:AbortSignal.timeout(30000) }),true,'inventory');
      inventory.push(...result.objects);
      const next = result.nextCursor || '';
      if (next && next === cursor) throw new Error('Inventory cursor did not advance.');
      cursor = next;
    } while (cursor);
    let candidates = localSource ? await localFiles(localSource) : await wordpressFiles();
    const maximum = Number(process.env.MAX_ITEMS || 0);
    manifest.sourceCount = candidates.length;
    if (maximum > 0) candidates = candidates.slice(0,maximum);
    const summary = await migrateMedia({ candidates, inventory, manifest, save, dryRun:flag('DRY_RUN',true),
      readExisting: async key => { const url = new URL(endpoint); url.searchParams.set('key',key);
        return readResponse(await fetch(url,{ headers, redirect:'error', signal:AbortSignal.timeout(60000) })); },
      readSource: async candidate => candidate.file ? fs.readFile(candidate.file) :
        readResponse(await fetch(candidate.source,{ signal:AbortSignal.timeout(60000) })),
      upload: async ({ candidate, bytes, type, reuseKey }) => {
        const form = new FormData();
        form.append('image',new Blob([bytes],{ type }),candidate.name);
        form.set('album',candidate.album); form.set('label',candidate.label); form.set('reuseKey',reuseKey);
        const result = await readResponse(await fetch(endpoint,{ method:'POST',headers,body:form,redirect:'error',signal:AbortSignal.timeout(60000) }),true);
        await pause(Math.max(0,Number(process.env.SLEEP_MS || 250)));
        return result;
      } });
    console.log(JSON.stringify({ ...summary, limited: candidates.length < manifest.sourceCount, manifest:manifestPath },null,2));
    if (summary.failed) process.exitCode = 1;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
