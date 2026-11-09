import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import worker from './worker-admin-api-wrapper.js';
import { canonicalAdminRedirect } from './worker-host-routing.js';
import { verifyTurnstile } from './public-forms-security.js';

const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const env = config.vars;
const alternate = 'https://mmmbc.hligon.workers.dev';

test('deployment enables the dedicated Worker URL and primary custom domain without moving storage', () => {
  assert.equal(config.name, 'mmmbc');
  assert.equal(config.workers_dev, true);
  assert.ok(config.routes.some(route => route.pattern === 'mmmbc.com' && route.custom_domain));
  assert.equal(env.PUBLIC_SITE_URL, 'https://mmmbc.com');
  assert.equal(env.CANONICAL_HOST, 'mmmbc.com');
  assert.equal(config.d1_databases.find(binding => binding.binding === 'DB').database_id, 'a981265d-7e16-486c-9d02-48dfa5017bed');
  assert.equal(config.r2_buckets[0].bucket_name, 'mmmbc');
});

test('Worker entry redirects admin navigation before attempting authentication or storage', async () => {
  for (const path of ['/admin', '/admin/', '/admin/mailbox?folder=inbox']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(new Request(alternate + path, { method }), env, {});
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('Location'), 'https://mmmbc.com' + path);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  }
  assert.equal(canonicalAdminRedirect(new Request('https://mmmbc.com/admin/'), env), null);
  assert.equal(canonicalAdminRedirect(new Request('https://localhost/admin/'), env), null);
  assert.equal(canonicalAdminRedirect(new Request(alternate + '/admin/', { method: 'POST' }), env), null);
});

test('public pages and APIs remain on the alternate origin', async () => {
  const originEnv = { ...env, ASSETS: { fetch: async request => new Response(request.url, { headers: { 'Content-Type': 'text/plain' } }) } };
  const home = await worker.fetch(new Request(alternate + '/'), originEnv, {});
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('Location'), null);
  assert.match(await home.text(), /mmmbc\.hligon\.workers\.dev/);
  for (const path of ['/api/public/site-settings', '/public/site-settings']) {
    const response = await worker.fetch(new Request(alternate + path), originEnv, {});
    assert.equal(response.headers.get('Location'), null);
    assert.equal(response.status, 200);
  }
  assert.equal(canonicalAdminRedirect(new Request(alternate + '/administrator'), env), null);
});

test('alternate-origin private APIs still reject unauthenticated requests', async () => {
  const response = await worker.fetch(new Request(alternate + '/api/me'), env, {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('Turnstile accepts configured origins and rejects other Worker accounts', async () => {
  const originalFetch = globalThis.fetch;
  let hostname;
  globalThis.fetch = async () => Response.json({ success: true, hostname });
  try {
    const verificationEnv = { ...env, TURNSTILE_SECRET_KEY: 'test-secret' };
    for (hostname of ['mmmbc.com', 'mmmbc.hligon.workers.dev', 'mmmbc.alphazonelabs.com']) {
      assert.equal((await verifyTurnstile(verificationEnv, 'test-token', '')).ok, true);
    }
    for (hostname of ['mmmbc.other-account.workers.dev', 'mmmbc.com.attacker.example']) {
      assert.equal((await verifyTurnstile(verificationEnv, 'test-token', '')).status, 403);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('giving on workers.dev publishes the primary-domain canonical URL', async () => {
  const html = fs.readFileSync(new URL('../Pages/giving.html', import.meta.url), 'utf8');
  const response = await worker.fetch(new Request(alternate + '/give'), {
    ...env,
    ASSETS: { fetch: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) }
  }, {});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /rel="canonical" href="https:\/\/mmmbc\.com\/give"/);
});
