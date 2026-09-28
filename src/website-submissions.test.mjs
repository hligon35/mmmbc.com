import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { PERMISSIONS } from './admin-rbac.js';

function submissionsHandler() {
  const source = fs.readFileSync(new URL('./worker-admin-api-wrapper.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace('export default {', 'globalThis.__workerAdminApi = {');
  const context = vm.createContext({
    URL, Request, Response, console, PERMISSIONS,
    worker: { fetch: async () => Response.json({ user: { email: 'admin@example.com' }, permissions: Object.values(PERMISSIONS) }) }
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
  assert.equal((sql.match(/\?/g) || []).length, args.length);
  assert.equal(args[1], 'hello');
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
