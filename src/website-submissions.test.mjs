import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { PERMISSIONS } from './admin-rbac.js';
import worker from './worker-admin-api-wrapper.js';
import { workspaceEnv } from './test-support/workspace-db.mjs';

function submissionsHandler(permissions = Object.values(PERMISSIONS)) {
  const source = fs.readFileSync(new URL('./worker-admin-api-wrapper.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace('export default {', 'globalThis.__workerAdminApi = {');
  const context = vm.createContext({
    URL, Request, Response, console, PERMISSIONS,
    worker: { fetch: async () => Response.json({ user: { email: 'admin@example.com' }, permissions }) }
  });
  vm.runInContext(`${source}\nglobalThis.submissionsHandler = handleWebsiteSubmissions;`, context);
  return context.submissionsHandler;
}

const api = (env, path, init) => worker.fetch(new Request('https://localhost' + path, init), env, { waitUntil() {} });

function seedMessages(env, count) {
  const insert = env.SITE_DB.sqlite.prepare('INSERT INTO contact_messages(id,name,email,subject,message,created_at) VALUES(?,?,?,?,?,?)');
  env.SITE_DB.sqlite.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    insert.run('bulk-' + String(i).padStart(4, '0'), 'Sender ' + i, 'sender' + i + '@example.com', 'Subject ' + i, 'Body ' + i + ' 100%_literal', new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
  }
  env.SITE_DB.sqlite.exec('COMMIT');
}

test('submissions list is paged, truthful beyond 300 rows, filtered by the server, and omits bodies', async () => {
  const env = workspaceEnv();
  seedMessages(env, 350);
  let data = await (await api(env, '/api/submissions?limit=100&offset=300')).json();
  assert.equal(data.total, 354);
  assert.deepEqual(data.counts, { all: 354, contact: 351, facility_rental: 3 });
  assert.equal(data.submissions.length, 54);
  assert.ok(data.submissions.every((row) => !('body' in row)));
  data = await (await api(env, '/api/submissions?type=facility_rental')).json();
  assert.equal(data.total, 3);
  assert.equal(data.counts.all, 354);
  assert.ok(data.submissions.every((row) => row.type === 'facility_rental'));
  data = await (await api(env, '/api/submissions?limit=5000')).json();
  assert.equal(data.limit, 100);
  assert.equal(data.submissions.length, 100);
  data = await (await api(env, '/api/submissions?q=' + encodeURIComponent('100%_literal') + '&limit=10')).json();
  assert.equal(data.total, 350);
  data = await (await api(env, '/api/submissions?q=' + encodeURIComponent('%'))).json();
  assert.equal(data.total, 350);
  data = await (await api(env, '/api/submissions?q=Sender%20349&type=contact')).json();
  assert.deepEqual(data.submissions.map((row) => row.id), ['bulk-0349']);
});

test('submission detail returns the body only for one validated record', async () => {
  const env = workspaceEnv();
  const detail = await (await api(env, '/api/submissions/one?type=contact')).json();
  assert.match(detail.submission.body, /Hello/);
  assert.equal((await api(env, '/api/submissions/missing?type=contact')).status, 404);
  assert.equal((await api(env, '/api/submissions/one?type=admins')).status, 400);
  const rental = await (await api(env, '/api/submissions/rent-a?type=facility_rental')).json();
  assert.match(rental.submission.body, /Fellowship Hall/);
  const restricted = workspaceEnv('auditor');
  assert.equal((await api(restricted, '/api/submissions?limit=5')).status, 403);
  assert.equal((await api(restricted, '/api/submissions/one?type=contact')).status, 403);
});

test('delete permanently removes the requested contact or rental row and rejects invalid types', async () => {
  const queries = [];
  const SITE_DB = { prepare(sql) {
    return { bind(...args) {
      queries.push({ sql, args });
      return { run: async () => ({ meta: { changes: 1 } }) };
    } };
  } };
  const handler = submissionsHandler();
  for (const [type, table] of [['contact', 'contact_messages'], ['facility_rental', 'facility_rental_requests']]) {
    const response = await handler(new Request(`https://example.com/api/submissions/record-1?type=${type}`, { method: 'DELETE' }), { SITE_DB }, {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.match(queries.at(-1).sql, new RegExp(`^DELETE FROM ${table} WHERE id = \\?$`));
    assert.deepEqual(queries.at(-1).args, ['record-1']);
  }
  const before = queries.length;
  const invalid = await handler(new Request('https://example.com/api/submissions/record-1?type=admins', { method: 'DELETE' }), { SITE_DB }, {});
  assert.equal(invalid.status, 400);
  assert.equal(queries.length, before);
  const viewOnly = submissionsHandler([PERMISSIONS.SUBMISSIONS_VIEW]);
  const denied = await viewOnly(new Request('https://example.com/api/submissions/record-1?type=contact', { method: 'DELETE' }), { SITE_DB }, {});
  assert.equal(denied.status, 403);
});

test('database errors return JSON instead of an HTML exception page', async () => {
  const SITE_DB = { prepare() { throw new Error('no such column: archived_at'); } };
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await submissionsHandler()(new Request('https://example.com/api/submissions'), { SITE_DB }, {});
    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.match((await response.json()).error, /database migrations/);
  } finally {
    console.error = originalError;
  }
});
