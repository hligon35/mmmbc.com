import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker-admin-api-wrapper.js';
import { workspaceEnv } from './test-support/workspace-db.mjs';

const api = (env, path) => worker.fetch(new Request('https://localhost' + path), env, { waitUntil() {} });

function seedGallery(env, count) {
  const insert = env.DB.sqlite.prepare('INSERT INTO gallery_items(id,album,label,tags_json,file_key,thumb_key,original_name,created_at,position) VALUES(?,?,?,?,?,?,?,?,?)');
  env.DB.sqlite.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    insert.run('g' + String(i).padStart(4, '0'), i % 2 ? 'Easter' : 'Choir', 'L' + i, JSON.stringify(i % 10 === 0 ? ['special'] : []), 'k' + i + '.jpg', null, 'img' + i + '.jpg', new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), i);
  }
  env.DB.sqlite.exec('COMMIT');
}

test('gallery pages, filters, and totals are computed on the server', async () => {
  const env = workspaceEnv();
  seedGallery(env, 1200);
  const page = await (await api(env, '/api/gallery?limit=48&offset=0')).json();
  assert.equal(page.items.length, 48);
  assert.equal(page.total, 1200);
  assert.deepEqual(page.albums, ['Choir', 'Easter']);
  assert.equal(page.items[0].id, 'g1199');

  const last = await (await api(env, '/api/gallery?limit=48&offset=1176')).json();
  assert.equal(last.items.length, 24);

  const capped = await (await api(env, '/api/gallery?limit=99999')).json();
  assert.equal(capped.items.length, 200);

  const tagged = await (await api(env, '/api/gallery?limit=10&tag=SPEC')).json();
  assert.equal(tagged.total, 120);

  const album = await (await api(env, '/api/gallery?limit=5&album=easter&sort=date-asc')).json();
  assert.equal(album.total, 600);
  assert.equal(album.items[0].id, 'g0001');

  const manual = await (await api(env, '/api/gallery?limit=3&sort=manual&arrangeAlbum=Choir')).json();
  assert.deepEqual(manual.items.map((i) => i.id), ['g0000', 'g0002', 'g0004']);

  const literal = await (await api(env, '/api/gallery?limit=5&album=%25')).json();
  assert.equal(literal.total, 0);
});

