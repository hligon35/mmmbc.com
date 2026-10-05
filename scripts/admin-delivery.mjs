import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');

// The checked-in entry is authoritative. Do not inject a second admin shell or
// move deferred scripts: their order is part of the application boot contract.
export async function createAdminDelivery(sourceHtml, readAsset) {
  if (!sourceHtml.includes('window.MMWorkspaceEnabled = false') ||
      /(?:src|href)=["']\/admin\/workspace\/(?:shell\.mjs|workspace\.css)/.test(sourceHtml)) {
    throw new Error('Deployment requires the current tabbed admin, not the retired mailbox shell.');
  }
  if (!sourceHtml.includes('id="mmmbc-admin-structure-js"')) {
    throw new Error('Deployment requires the intrinsic admin refinement script; Worker fallback injection is not a current entry.');
  }
  const references = [...sourceHtml.matchAll(/(?:src|href)=["'](\/admin\/[^"'?]+\.(?:js|mjs|css))(?:\?[^"']*)?["']/g)];
  const files = {};
  for (const [, url] of references) {
    if (!files[url]) files[url] = digest(await readAsset(url));
  }
  for (const url of ['/admin/admin.js', '/admin/admin-style.css', '/admin/admin-structure-overrides.js']) {
    if (!files[url]) throw new Error(`Missing required admin entry asset: ${url}`);
  }
  const fingerprint = digest(sourceHtml + JSON.stringify(files));
  let html = sourceHtml.replace(/((?:src|href)=["'])(\/admin\/[^"'?]+\.(?:js|mjs|css))(?:\?[^"']*)?(["'])/g,
    (_, prefix, url, suffix) => `${prefix}${url}?v=${files[url].slice(0, 14)}${suffix}`);
  html = html.replace('</head>', `  <meta name="mmmbc-admin-build" content="${fingerprint}" />\n</head>`);
  return { html, manifest: { layout: 'tabbed', fingerprint, files, htmlSha256: digest(html) } };
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
