import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminDelivery, verifyAdminDelivery } from '../scripts/admin-delivery.mjs';
import worker from './worker-admin-api-wrapper.js';

const html = `<head>
<script>window.MMWorkspaceEnabled = true;</script>
<link href="/admin/admin-style.css?v=old" rel="stylesheet">
<link href="/admin/workspace/workspace.css?v=old" rel="stylesheet">
</head><body>
<script id="mmmbc-admin-structure-js" src="/admin/admin-structure-overrides.js?v=old" defer></script>
<script src="/admin/admin.js?v=old" defer></script>
<script type="module" src="/admin/workspace/shell.mjs?v=old"></script>
</body>`;
const assets = {
  '/admin/index.html': html,
  '/admin/admin-style.css': 'body{}',
  '/admin/admin.js': 'boot()',
  '/admin/admin-structure-overrides.js': 'refine()',
  '/admin/workspace/workspace.css': '.ws-shell{}',
  '/admin/workspace/shell.mjs': 'import "./modules.mjs";',
  '/admin/workspace/modules.mjs': 'export const modules=[];',
  '/admin/workspace/shared.mjs': 'export const el=()=>{};',
  '/admin/workspace/mailbox.mjs': 'export class Mailbox{}',
  '/admin/workspace/views.mjs': 'export const calendar=()=>{};'
};
const source = async url => assets[url];

test('admin build fingerprints the mailbox workspace and all nested shell assets', async () => {
  const first = await createAdminDelivery(html, source);
  assert.equal(first.manifest.layout, 'mailbox-workspace');
  assert.ok(first.html.indexOf('admin-structure-overrides.js') < first.html.indexOf('/admin/admin.js'));
  assert.doesNotMatch(first.html, /v=old/);
  for (const url of ['/admin/workspace/shell.mjs','/admin/workspace/workspace.css','/admin/workspace/modules.mjs','/admin/workspace/shared.mjs','/admin/workspace/mailbox.mjs','/admin/workspace/views.mjs']) {
    assert.ok(first.manifest.files[url], url);
  }
  const second = await createAdminDelivery(html, async url => url.endsWith('/mailbox.mjs') ? 'export class Mailbox{changed=true}' : source(url));
  assert.notEqual(second.manifest.fingerprint, first.manifest.fingerprint);
  assert.notEqual(second.manifest.files['/admin/workspace/mailbox.mjs'], first.manifest.files['/admin/workspace/mailbox.mjs']);
});

test('deployment refuses the old tabbed entry or an incomplete mailbox shell', async () => {
  await assert.rejects(createAdminDelivery(html.replace(' = true', ' = false'), source), /mailbox workspace shell/);
  await assert.rejects(createAdminDelivery(html.replace(/<script type="module"[^>]+shell\.mjs[^>]*><\/script>/, ''), source), /mailbox workspace shell/);
  await assert.rejects(createAdminDelivery(html.replace(/<link href="\/admin\/workspace\/workspace\.css[^>]+>/, ''), source), /mailbox workspace shell/);
  const delivery = await createAdminDelivery(html, source);
  const output = {...assets, '/admin/index.html': delivery.html, '/admin/build-info.json': JSON.stringify(delivery.manifest)};
  assert.equal((await verifyAdminDelivery(source, async url => output[url])).fingerprint, delivery.manifest.fingerprint);
  await assert.rejects(verifyAdminDelivery(source, async url => url.endsWith('/shell.mjs') ? 'staleShell()' : output[url]), /Stale admin deployment asset/);
});

test('live build diagnostics identify the shipped mailbox workspace', async () => {
  const delivery = await createAdminDelivery(html, source);
  const response = await worker.fetch(new Request('https://church.example/api/build-info'), {
    ASSETS: {fetch: async () => Response.json(delivery.manifest)}
  }, {});
  const info = await response.json();
  assert.deepEqual(info.adminBuild, {layout:'mailbox-workspace', fingerprint:delivery.manifest.fingerprint});
  assert.match(response.headers.get('Cache-Control'), /no-store/);
});
