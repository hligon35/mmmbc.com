import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker-admin-api-wrapper.js';
import { workspaceEnv } from './test-support/workspace-db.mjs';

const overview = async (env) => {
  const res = await worker.fetch(new Request('https://localhost/api/dashboard/overview'), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
};

function seed(env) {
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const q = env.DB.sqlite;
  const ev = q.prepare('INSERT INTO events(id,title,event_date,event_time,created_at,updated_at) VALUES(?,?,?,?,?,?)');
  q.exec('BEGIN');
  for (let i = 0; i < 400; i++) ev.run('past' + i, 'Past ' + i, day(-5 - i), null, '2020-01-01', '2020-01-01');
  ev.run('soon', 'Soon', day(3), '10:00', '2020-01-01', '2020-01-01');
  ev.run('far', 'Far', day(60), null, '2020-01-01', '2020-01-01');
  const an = q.prepare('INSERT INTO announcements(id,title,body,created_at,expires_at) VALUES(?,?,?,?,?)');
  for (let i = 0; i < 300; i++) an.run('old' + i, 'Old ' + i, 'b', '2020-01-01T00:00:00Z', '2021-01-01T00:00:00Z');
  an.run('live', 'Live', 'b', '2026-01-01T00:00:00Z', null);
  q.exec('COMMIT');
  const gi = q.prepare("INSERT INTO gallery_items(id,album,label,file_key,created_at) VALUES(?,?,?,?,?)");
  gi.run('a', 'One', 'x', 'a.jpg', '2020-01-01'); gi.run('b', 'Two', 'x', 'b.jpg', '2020-01-01'); gi.run('c', 'Two', 'x', 'c.jpg', '2020-01-01');
}

test('dashboard metrics are exact SQL aggregates beyond the old row caps', async () => {
  const env = workspaceEnv();
  seed(env);
  const { status, body } = await overview(env);
  assert.equal(status, 200);
  assert.equal(body.summary.activeAnnouncements, 1);
  assert.equal(body.summary.totalAnnouncements, 301);
  assert.equal(body.summary.upcomingEvents14d, 1);
  assert.equal(body.summary.galleryItems, 3);
  assert.equal(body.summary.galleryAlbums, 2);
  assert.deepEqual(body.unavailable, []);
  assert.equal(body.upcomingEvents[0].title, 'Soon');
  assert.ok(body.needsAttention.every((item) => item.action.sectionTarget !== 'tab-events'));
});

test('a failing query is reported unavailable instead of zero', async () => {
  const env = workspaceEnv();
  seed(env);
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/FROM gallery_items/.test(sql)) throw new Error('simulated D1 outage');
    return realPrepare(sql);
  };
  const { body } = await overview(env);
  assert.deepEqual(body.unavailable, ['gallery']);
  assert.equal(body.summary.galleryItems, null);
  assert.equal(body.summary.activeAnnouncements, 1);
  assert.equal(body.status.gallery.ok, false);
  assert.equal(body.websiteStatus.degraded, true);
});

test('dashboard returns only metrics the role may view', async () => {
  const env = workspaceEnv('auditor');
  seed(env);
  const { status, body } = await overview(env);
  assert.equal(status, 200);
  assert.deepEqual(Object.values(body.summary), Array(8).fill(null));
  assert.equal(body.newsletter, null);
  assert.deepEqual(body.recentActivity, []);
  assert.equal(body.permissions.gallery, false);
});
