import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker-admin-api-wrapper.js';
import { workspaceEnv } from './test-support/workspace-db.mjs';

const call = (env, method, path) => worker.fetch(new Request('https://localhost' + path, {
  method,
  headers: { Origin: 'https://localhost', 'Content-Type': 'application/json' },
  body: method === 'GET' ? undefined : '{}'
}), env, { waitUntil() {} });

const MODULE_ENDPOINTS = [
  ['GET', '/api/submissions'], ['GET', '/api/submissions/one?type=contact'], ['GET', '/api/gallery'], ['GET', '/api/gallery?limit=5'],
  ['GET', '/api/announcements'], ['GET', '/api/events'], ['GET', '/api/bulletins'], ['GET', '/api/subscribers'],
  ['GET', '/api/newsletter/records'], ['POST', '/api/newsletter/send'], ['POST', '/api/newsletter/test'],
  ['POST', '/api/announcements'], ['POST', '/api/events'], ['POST', '/api/gallery/upload'],
  ['GET', '/api/users'], ['GET', '/api/profiles']
];

for (const role of ['auditor', 'finance_entry', 'treasurer']) {
  test(`${role} is denied website module endpoints on direct API requests`, async () => {
    const env = workspaceEnv(role);
    for (const [method, path] of MODULE_ENDPOINTS) {
      const res = await call(env, method, path);
      assert.equal(res.status, 403, `${role} ${method} ${path} returned ${res.status}`);
    }
  });
}

test('retired compatibility endpoints are gone for administrators and still permission-gated', async () => {
  const admin = workspaceEnv('administrator');
  for (const [method, path] of [['PUT', '/api/livestream'], ['PUT', '/api/settings'], ['POST', '/api/export'], ['POST', '/api/theme/preview'], ['POST', '/api/theme/preview/clear']]) {
    assert.equal((await call(admin, method, path)).status, 410, path);
  }
  const auditor = workspaceEnv('auditor');
  assert.equal((await call(auditor, 'POST', '/api/export')).status, 403);
});

test('newsletter send and test endpoints are routed and validate input before any delivery', async () => {
  const env = workspaceEnv('administrator');
  for (const path of ['/api/newsletter/send', '/api/newsletter/test']) {
    assert.equal((await call(env, 'POST', path)).status, 400, path);
  }
});
