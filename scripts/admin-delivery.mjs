import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const WORKSPACE_ASSETS = [
  '/admin/workspace/shell.mjs',
  '/admin/workspace/workspace.css',
  '/admin/workspace/modules.mjs',
  '/admin/workspace/shared.mjs',
  '/admin/workspace/mailbox.mjs',
  '/admin/workspace/views.mjs',
  '/admin/workspace/finance.mjs',
  '/admin/workspace/zeffy.mjs'
];

// The checked-in entry is authoritative. The mailbox workspace is the current
// admin shell; legacy tabbed panels remain mounted only as module work areas.
export async function createAdminDelivery(sourceHtml, readAsset) {
  const shellEnabled = sourceHtml.includes('window.MMWorkspaceEnabled = true');
  const shellScript = /src=["']\/admin\/workspace\/shell\.mjs(?:\?[^"']*)?["']/.test(sourceHtml);
  const shellCss = /href=["']\/admin\/workspace\/workspace\.css(?:\?[^"']*)?["']/.test(sourceHtml);
  if (!shellEnabled || !shellScript || !shellCss) {
    throw new Error('Deployment requires the current mailbox workspace shell. The legacy tabbed admin must not become the primary entry.');
  }
  if (!sourceHtml.includes('id="mmmbc-admin-structure-js"')) {
    throw new Error('Deployment requires the intrinsic admin refinement script for legacy module panels.');
  }

  const references = [...sourceHtml.matchAll(/(?:src|href)=["'](\/admin\/[^"'?]+\.(?:js|mjs|css))(?:\?[^"']*)?["']/g)];
  const files = {};
  for (const [, url] of references) {
    if (!files[url]) files[url] = digest(await readAsset(url));
  }
  for (const url of [
    '/admin/admin.js',
    '/admin/admin-style.css',
    '/admin/admin-structure-overrides.js',
    ...WORKSPACE_ASSETS
  ]) {
    if (!files[url]) files[url] = digest(await readAsset(url));
  }

  const fingerprint = digest(sourceHtml + JSON.stringify(files));
  let html = sourceHtml.replace(/((?:src|href)=["'])(\/admin\/[^"'?]+\.(?:js|mjs|css))(?:\?[^"']*)?(["'])/g,
    (_, prefix, url, suffix) => `${prefix}${url}?v=${files[url].slice(0, 14)}${suffix}`);
  html = html.replace('</head>', `  <meta name="mmmbc-admin-build" content="${fingerprint}" />\n</head>`);
  return { html, manifest: { layout: 'mailbox-workspace', fingerprint, files, htmlSha256: digest(html) } };
}

export async function verifyAdminDelivery(readSource, readOutput) {
  const expected = await createAdminDelivery(await readSource('/admin/index.html'), readSource);
  const manifest = JSON.parse(await readOutput('/admin/build-info.json'));
  if (JSON.stringify(manifest) !== JSON.stringify(expected.manifest) ||
      await readOutput('/admin/index.html') !== expected.html) {
    throw new Error('Admin deployment output is stale or does not match the current source. Rebuild before deploying.');
  }
  for (const [url, hash] of Object.entries(manifest.files)) {
    if (digest(await readOutput(url)) !== hash) throw new Error(`Stale admin deployment asset: ${url}`);
  }
  return manifest;
}
