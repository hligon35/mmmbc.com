import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import worker from './worker-admin-api-wrapper.js';
import { INITIAL_PUBLISHED_CONTENT } from './site-editor-schema.js';
import { MINISTRY_R2_IMAGES, LEGACY_MINISTRY_IMAGES, normalizeMinistryImages, servePublishedMinistryImage } from './ministry-images.js';

test('static ministry cards, public profile data, and CMS seed share all fourteen image URLs', () => {
  const html = fs.readFileSync(new URL('../Pages/ministries.html', import.meta.url), 'utf8');
  const profiles = JSON.parse(fs.readFileSync(new URL('../profiles.json', import.meta.url), 'utf8')).profiles;
  assert.equal(profiles.length, 14);
  assert.equal(Object.keys(LEGACY_MINISTRY_IMAGES).length, 14);
  assert.equal(Object.keys(MINISTRY_R2_IMAGES).length, 7);
  for (const profile of profiles) {
    assert.ok(html.includes(`src="${profile.image}"`), profile.id);
    assert.equal(INITIAL_PUBLISHED_CONTENT.ministries.profiles.find(item => item.id === profile.id).image.url, profile.image);
  }
  assert.doesNotMatch(html, /wp-content\/uploads/);
});

test('legacy published photos are repaired without replacing custom uploads or outside URLs', () => {
  const fields = { profiles: [
    { id: 'ministries-1', image: { url: 'https://mmmbc.com/wp-content/uploads/2025/05/Elaine.jpeg', alt: 'Elaine' } },
    { id: 'custom', image: { url: '/cdn/gallery/site/custom-photo.jpg' } },
    { id: 'external', image: { url: 'https://other.example/wp-content/uploads/2025/05/Elaine.jpeg' } }
  ] };
  const repaired = normalizeMinistryImages(fields);
  assert.equal(repaired.profiles[0].image.url, '/cdn/gallery/site/ministry/elaine-fletcher.jpg');
  assert.equal(repaired.profiles[0].image.alt, 'Elaine');
  assert.equal(repaired.profiles[1].image.url, fields.profiles[1].image.url);
  assert.equal(repaired.profiles[2].image.url, fields.profiles[2].image.url);
  assert.notEqual(repaired.profiles[0], fields.profiles[0]);
});

function imageEnv(row = null) {
  const reads = [];
  return { reads, DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
    GALLERY_BUCKET: { get: async key => { reads.push(key); return { body: new Uint8Array([1, 2, 3]), writeHttpMetadata: () => {} }; } } };
}

test('the Worker serves only the seven exact published R2 aliases when gallery indexes are absent', async () => {
  for (const [key, source] of Object.entries(MINISTRY_R2_IMAGES)) {
    const env = imageEnv();
    const response = await worker.fetch(new Request('https://mmmbc.com/cdn/gallery/' + key), env, {});
    assert.equal(response.status, 200);
    assert.deepEqual(env.reads, [source]);
    assert.match(response.headers.get('Content-Type'), /^image\/(png|jpeg)$/);
  }
  const env = imageEnv();
  assert.equal((await servePublishedMinistryImage(new Request('https://mmmbc.com'), env, 'site/ministry/not-published.jpg')).status, 404);
  assert.deepEqual(env.reads, []);
});

test('explicitly hidden photos and visibility lookup failures are never served', async () => {
  const request = new Request('https://mmmbc.com');
  const key = 'site/ministry/elaine-fletcher.jpg';
  const env = imageEnv({ is_hidden: 1 });
  assert.equal((await servePublishedMinistryImage(request, env, key)).status, 404);
  assert.deepEqual(env.reads, []);
  env.DB.prepare = () => { throw new Error('unavailable'); };
  assert.equal((await servePublishedMinistryImage(request, env, key)).status, 503);
  assert.deepEqual(env.reads, []);
});

test('missing R2 objects produce an actionable server log without exposing diagnostics publicly', async t => {
  const warn = console.warn;
  const messages = [];
  console.warn = (...args) => messages.push(args);
  t.after(() => { console.warn = warn; });
  const env = imageEnv();
  env.GALLERY_BUCKET.get = async () => null;
  const key = 'site/ministry/jesse-shields.jpg';
  const response = await servePublishedMinistryImage(new Request('https://mmmbc.com'), env, key);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  assert.equal(messages[0][1].reason, 'r2_object_missing');
  assert.equal(messages[0][1].source, MINISTRY_R2_IMAGES[key]);
});

test('published profile endpoint works outside the protected API prefix and excludes drafts', async () => {
  const env = { DB: { prepare: sql => {
    assert.match(sql, /SELECT published_fields/);
    assert.doesNotMatch(sql, /draft_fields/);
    return { bind: () => ({ first: async () => ({ published_fields: JSON.stringify({ profiles: [
      { id: 'ministries-1', image: { url: 'https://mmmbc.com/wp-content/uploads/2025/05/Elaine.jpeg' } }
    ] }), published_version: 2 }) }) };
  } } };
  const response = await worker.fetch(new Request('https://mmmbc.com/public/site-content/ministries'), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fields.profiles[0].image.url, '/cdn/gallery/site/ministry/elaine-fletcher.jpg');
  const unknown = await worker.fetch(new Request('https://mmmbc.com/public/site-content/settings'), env, {});
  assert.equal(unknown.status, 404);
});
