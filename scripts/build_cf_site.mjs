import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'cf_site');
const assetVersion = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

const rootFiles = [
  'index.html', 'robots.txt', 'sitemap.xml',
  'public-base.css', 'public-components.css', 'public-responsive.css',
  'theme.css', 'schedule_app.css', 'home-layout-updates.css', 'schedule_app.js', 'script.js',
  'announcements_ticker.js', 'bulletins_widget.js', 'facility_rental_form.js', 'facility_rental_nonmembers_form.js',
  'site-content-loader.js', 'scan.html', 'scan.css', 'scan.js',
  'announcements.json', 'bulletins.json', 'documents.json', 'gallery.json', 'livestream.json', 'schedule.json', 'site-settings.json'
];

const rootDirs = ['Pages', 'Icons', 'ConImg', 'bulletins', 'rental'];
const adminRemove = new Set(['login.html', 'login.js', 'login_legacy.html']);
const structureCssTag = `  <link id="mmmbc-admin-structure-css" rel="stylesheet" href="/admin/admin-structure-overrides.css?v=${assetVersion}" />`;
const structureScriptTag = `  <script id="mmmbc-admin-structure-js" src="/admin/admin-structure-overrides.js?v=${assetVersion}" defer></script>`;
const xlsxVendorSrc = path.join(root, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function recreateDir(target) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
}

async function copyDirRecursive(srcDir, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const out = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(src, out);
    } else if (entry.isFile()) {
      await fs.copyFile(src, out);
    }
  }
}

async function copyRootFiles() {
  for (const relativePath of rootFiles) {
    const src = path.join(root, relativePath);
    if (!(await exists(src))) continue;
    const out = path.join(dest, relativePath);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.copyFile(src, out);
  }
}

async function copyRootDirs() {
  for (const dirName of rootDirs) {
    const src = path.join(root, dirName);
    if (!(await exists(src))) continue;
    await copyDirRecursive(src, path.join(dest, dirName));
  }
}

function stripLineById(html, idValue) {
  return html
    .split('\n')
    .filter((line) => !line.includes(`id="${idValue}"`))
    .join('\n');
}

async function mirrorAdmin() {
  const adminSrc = path.join(root, 'admin', 'public');
  const adminDest = path.join(dest, 'admin');
  if (!(await exists(adminSrc))) return;

  await copyDirRecursive(adminSrc, adminDest);

  for (const fileName of adminRemove) {
    const target = path.join(adminDest, fileName);
    if (await exists(target)) await fs.rm(target, { force: true });
  }

  const maybeServer = path.join(adminDest, 'server.js');
  if (await exists(maybeServer)) await fs.rm(maybeServer, { force: true });
  const maybeData = path.join(adminDest, 'data');
  if (await exists(maybeData)) await fs.rm(maybeData, { recursive: true, force: true });

  const indexPath = path.join(adminDest, 'index.html');
  if (!(await exists(indexPath))) return;
  let html = await fs.readFile(indexPath, 'utf8');
  html = stripLineById(html, 'mmmbc-admin-structure-css');
  html = stripLineById(html, 'mmmbc-admin-structure-js');
  html = html.replace('</head>', `${structureCssTag}\n</head>`);
  html = html.replace('</body>', `${structureScriptTag}\n</body>`);
  await fs.writeFile(indexPath, html, 'utf8');

  if (await exists(xlsxVendorSrc)) {
    const vendorDest = path.join(adminDest, 'vendor', 'xlsx.full.min.js');
    await fs.mkdir(path.dirname(vendorDest), { recursive: true });
    await fs.copyFile(xlsxVendorSrc, vendorDest);
  }
}

async function main() {
  await recreateDir(dest);
  await copyRootFiles();
  await copyRootDirs();
  await mirrorAdmin();
  console.log(`Built cf_site at: ${dest}`);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
