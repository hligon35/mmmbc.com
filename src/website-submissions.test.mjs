import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { PERMISSIONS } from './admin-rbac.js';

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

test('website messages query works without structured rental fields', async () => {
  let sql;
  let args;
  const SITE_DB = { prepare(statement) {
    sql = statement;
    return { bind(...values) {
      args = values;
      return { all: async () => ({ results: [{ id: 'message-1', type: 'contact' }] }) };
    } };
  } };
  const response = await submissionsHandler()(new Request('https://example.com/api/submissions?q=hello'), { SITE_DB }, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).submissions[0].id, 'message-1');
  assert.doesNotMatch(sql, /first_name|last_name/i);
  assert.match(sql, /'' AS sender_address/);
  assert.match(sql, /FROM contact_messages WHERE archived_at IS NULL/);
  assert.equal((sql.match(/\?/g) || []).length, args.length);
  assert.equal(args[0], 'hello');
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
