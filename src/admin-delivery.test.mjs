import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminDelivery, verifyAdminDelivery } from '../scripts/admin-delivery.mjs';
import worker from './worker-admin-api-wrapper.js';

const html = `<head><script>window.MMWorkspaceEnabled = false;</script><link href="/admin/admin-style.css?v=old" rel="stylesheet"></head><body>
<script id="mmmbc-admin-structure-js" src="/admin/admin-structure-overrides.js?v=old" defer></script>
<script src="/admin/admin.js?v=old" defer></script></body>`;
const assets = {'/admin/index.html': html, '/admin/admin-style.css': 'body{}', '/admin/admin.js': 'boot()', '/admin/admin-structure-overrides.js': 'refine()'};
const source = async url => assets[url];

test('admin build fingerprints every entry asset, preserves script order and changes with source', async () => {
  const first = await createAdminDelivery(html, source);
  assert.equal(first.manifest.layout, 'tabbed');
  assert.ok(first.html.indexOf('admin-structure-overrides.js') < first.html.indexOf('/admin/admin.js'));
  assert.doesNotMatch(first.html, /v=old/);
  const second = await createAdminDelivery(html, async url => url.endsWith('/admin.js') ? 'newBoot()' : source(url));
  assert.notEqual(second.manifest.fingerprint, first.manifest.fingerprint);
  assert.notEqual(second.manifest.files['/admin/admin.js'], first.manifest.files['/admin/admin.js']);
  assert.deepEqual(await createAdminDelivery(html, source), first);
});

test('deployment refuses a revived mailbox shell and stale or mixed assets', async () => {
  await assert.rejects(createAdminDelivery(html.replace(' = false', ' = true'), source), /current tabbed admin/);
  await assert.rejects(createAdminDelivery(html.replace('</head>', '<link href="/admin/workspace/workspace.css"></head>'), source), /current tabbed admin/);
  const delivery = await createAdminDelivery(html, source);
  const output = {...assets, '/admin/index.html': delivery.html, '/admin/build-info.json': JSON.stringify(delivery.manifest)};
  assert.equal((await verifyAdminDelivery(source, async url => output[url])).fingerprint, delivery.manifest.fingerprint);
  await assert.rejects(verifyAdminDelivery(source, async url => url.endsWith('/admin.js') ? 'staleBoot()' : output[url]), /Stale admin deployment asset/);
  await assert.rejects(verifyAdminDelivery(source, async url => url.endsWith('/index.html') ? html : output[url]), /output is stale/);
});

test('live build diagnostics identify the shipped admin rather than just the Worker marker', async () => {
  const delivery = await createAdminDelivery(html, source);
  const response = await worker.fetch(new Request('https://church.example/api/build-info'), {
    ASSETS: {fetch: async () => Response.json(delivery.manifest)}
  }, {});
  const info = await response.json();
  assert.deepEqual(info.adminBuild, {layout:'tabbed', fingerprint:delivery.manifest.fingerprint});
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  const missing = await worker.fetch(new Request('https://church.example/api/build-info'), {}, {});
  assert.equal((await missing.json()).adminBuild, null);
});
