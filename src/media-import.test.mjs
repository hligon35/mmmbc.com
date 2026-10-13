import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceEnv } from './test-support/workspace-db.mjs';
import { handleMediaImport } from './worker-media-import.js';
import worker from './worker-admin-api-wrapper.js';
import { migrateMedia, sha256 } from '../scripts/lib/media-migration.mjs';
import { originalMediaUrl } from '../scripts/import_wp_media_to_worker_gallery.mjs';
import { main } from '../scripts/import_wp_media_to_worker_gallery.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const image = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
function bucket() {
  const objects = new Map();
  return { objects, async get(key) { const bytes = objects.get(key); return bytes ? { body:bytes, arrayBuffer:async () => bytes,
    writeHttpMetadata() {} } : null; }, async put(key,bytes) { objects.set(key,Buffer.from(bytes)); },
    async list() { return { truncated:false, objects:[...objects].map(([key,bytes]) => ({ key,size:bytes.length,etag:sha256(bytes) })) }; } };
}
function uploadRequest(reuseKey = '', bytes = image) {
  const body = new FormData();
  body.append('image',new Blob([bytes],{ type:'image/png' }),'profile.png');
  body.set('reuseKey',reuseKey);
  return new Request('https://localhost/api/gallery/import',{ method:'POST',body });
}

test('authenticated importer retries produce one object and one gallery record', async () => {
  const env = { ...workspaceEnv(), GALLERY_BUCKET:bucket() };
  const first = await worker.fetch(uploadRequest(),env,{});
  assert.equal(first.status,200);
  const result = await first.json();
  const second = await worker.fetch(uploadRequest(),env,{});
  assert.equal((await second.json()).galleryId,result.galleryId);
  assert.equal(env.GALLERY_BUCKET.objects.size,1);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM gallery_items').get().count,1);
});

test('reusing a registered hidden image preserves its identity and visibility', async () => {
  const env = { ...workspaceEnv(), GALLERY_BUCKET:bucket() };
  const first = await (await handleMediaImport(uploadRequest(),env)).json();
  env.DB.sqlite.prepare('UPDATE gallery_items SET is_hidden=1 WHERE id=?').run(first.galleryId);
  const second = await (await handleMediaImport(uploadRequest(first.key),env)).json();
  assert.equal(second.hidden,true);
  assert.equal(second.galleryId,first.galleryId);
  assert.equal(env.GALLERY_BUCKET.objects.size,1);
});

test('existing unindexed objects are registered without uploading another copy', async () => {
  const env = { ...workspaceEnv(), GALLERY_BUCKET:bucket() };
  const key = 'gallery/old/profile.png';
  env.GALLERY_BUCKET.objects.set(key,image);
  const result = await (await handleMediaImport(uploadRequest(key),env)).json();
  assert.equal(result.key,key);
  assert.equal(result.reused,true);
  assert.equal(env.GALLERY_BUCKET.objects.size,1);
  const conflict = await handleMediaImport(uploadRequest(key,Buffer.concat([image,Buffer.from([9])])),env);
  assert.equal(conflict.status,409);
});

test('inventory and private deduplication reads require photo-management authorization', async () => {
  const env = { ...workspaceEnv(), GALLERY_BUCKET:bucket() };
  const denied = await handleMediaImport(new Request('https://church.example/api/gallery/import'),env);
  assert.equal(denied.status,401);
  env.DB.sqlite.prepare("UPDATE admin_users SET role='auditor'").run();
  const limited = await handleMediaImport(new Request('https://localhost/api/gallery/import'),env);
  assert.equal(limited.status,403);
});

test('dry runs never upload and treat different filenames with identical contents as duplicates', async () => {
  let uploads = 0;
  const manifest = {};
  const summary = await migrateMedia({ candidates:[{ source:'one.png' },{ source:'renamed.png' }], inventory:[],
    readSource:async () => image, readExisting:async () => image, upload:async () => { uploads++; },
    manifest,save:async () => {},dryRun:true });
  assert.equal(uploads,0);
  assert.equal(summary.planned,1);
  assert.equal(summary.reused,1);
  assert.equal(manifest.sources['one.png'].key,manifest.sources['renamed.png'].key);
});

test('existing R2 bytes are reused and resume refreshes hashes after an object changes', async () => {
  const manifest = { objects:{ 'gallery/a.png':{ etag:'old',size:image.length,sha256:'0'.repeat(64) } } };
  let reads = 0, uploads = 0;
  const summary = await migrateMedia({ candidates:[{ source:'one.png' },{ source:'two.png' }],
    inventory:[{ key:'gallery/a.png',size:image.length,etag:'new',hidden:false }],
    readExisting:async () => { reads++;return image; },readSource:async () => image,
    upload:async payload => { uploads++; assert.equal(payload.reuseKey,'gallery/a.png');
      return { sha256:payload.sha256,key:payload.reuseKey,reused:true }; }, manifest,save:async () => {},dryRun:false });
  assert.equal(reads,1);
  assert.equal(uploads,1);
  assert.equal(summary.reused,2);
  assert.equal(manifest.sources['two.png'].status,'complete');
});

test('failed source reads are reported and do not prevent other images from completing', async () => {
  const manifest = {};
  const summary = await migrateMedia({ candidates:[{ source:'missing' },{ source:'valid' }],inventory:[],
    readExisting:async () => image,readSource:async c => { if(c.source==='missing')throw Error('missing');return image; },
    upload:async p => ({ sha256:p.sha256,key:'gallery/new.png',reused:false }),manifest,save:async () => {},dryRun:false });
  assert.equal(summary.failed,1);
  assert.equal(summary.uploaded,1);
  assert.equal(manifest.sources.missing.status,'failed');
});

test('WordPress original-image metadata takes precedence over the scaled derivative', () => {
  assert.equal(originalMediaUrl({ source_url:'https://old.example/uploads/photo-scaled.jpg',media_details:{ original_image:'photo.jpg' } }),
    'https://old.example/uploads/photo.jpg');
});

test('local-backup CLI dry run, real import, and resume share one canonical image', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'media-import-'));
  await fs.writeFile(path.join(dir,'one.png'),image);
  await fs.writeFile(path.join(dir,'renamed.png'),image);
  const env = { ...workspaceEnv(), GALLERY_BUCKET:bucket() };
  const names = ['TARGET_BASE_URL','CF_ACCESS_JWT','WP_UPLOADS_DIR','MIGRATION_MANIFEST','DRY_RUN','SLEEP_MS'];
  const previous = Object.fromEntries(names.map(name => [name,process.env[name]]));
  const originalFetch = globalThis.fetch, log = console.log;
  t.after(async () => {
    globalThis.fetch = originalFetch; console.log = log;
    for(const name of names) { if(previous[name] == null) delete process.env[name];else process.env[name]=previous[name]; }
    await fs.rm(dir,{ recursive:true,force:true });
  });
  Object.assign(process.env,{ TARGET_BASE_URL:'https://localhost', CF_ACCESS_JWT:'test-only',WP_UPLOADS_DIR:dir,
    MIGRATION_MANIFEST:path.join(dir,'manifest.json'),DRY_RUN:'true',SLEEP_MS:'1' });
  console.log = () => {};
  globalThis.fetch = async (url,options) => handleMediaImport(new Request(url,options),env);
  await main();
  assert.equal(env.GALLERY_BUCKET.objects.size,0);
  process.env.DRY_RUN='false';
  await main();
  await main();
  assert.equal(env.GALLERY_BUCKET.objects.size,1);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM gallery_items').get().count,1);
  const manifest = JSON.parse(await fs.readFile(process.env.MIGRATION_MANIFEST,'utf8'));
  assert.equal(manifest.summary.reused,2);
  assert.doesNotMatch(JSON.stringify(manifest),/test-only/);
});
