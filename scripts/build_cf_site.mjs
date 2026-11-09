import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminDelivery } from './admin-delivery.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'cf_site');

const rootFiles = [
  'index.html', 'robots.txt', 'sitemap.xml',
  'static-style.css',
  'theme.css', 'schedule_app.js', 'script.js',
  'public-form-utils.js', 'facility_rental_form_shared.js',
  'announcements_ticker.js', 'bulletins_widget.js',
  'site-content-loader.js', '_headers',
  'announcements.json', 'bulletins.json', 'documents.json', 'gallery.json', 'livestream.json', 'schedule.json', 'site-settings.json', 'profiles.json',
  'pastorHarvey.jpeg'
];

const rootDirs = ['Pages', 'Icons', 'ConImg', 'bulletins', 'rental'];

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

async function mirrorAdmin(delivery) {
  const adminSrc = path.join(root, 'admin', 'public');
  const adminDest = path.join(dest, 'admin');
  if (!(await exists(adminSrc))) return;

  await copyDirRecursive(adminSrc, adminDest);


  const maybeServer = path.join(adminDest, 'server.js');
  if (await exists(maybeServer)) await fs.rm(maybeServer, { force: true });
  const maybeData = path.join(adminDest, 'data');
  if (await exists(maybeData)) await fs.rm(maybeData, { recursive: true, force: true });

  const indexPath = path.join(adminDest, 'index.html');
  if (!(await exists(indexPath))) return;
  await fs.writeFile(indexPath, delivery.html, 'utf8');
  await fs.writeFile(path.join(adminDest, 'build-info.json'), JSON.stringify(delivery.manifest, null, 2) + '\n', 'utf8');


}

async function main() {
  for (const required of ['index.html', '_headers', 'public-form-utils.js', 'facility_rental_form_shared.js', 'Pages/facility_rental_members_form.html', 'Pages/facility_rental_nonmembers_form.html', 'admin/public/index.html', 'admin/public/admin.js']) {
    if (!(await exists(path.join(root, required)))) throw new Error(`Missing required deployment source: ${required}`);
  }
  // Validate the entry and read every required asset before replacing output.
  const delivery = await createAdminDelivery(await fs.readFile(path.join(root, 'admin/public/index.html'), 'utf8'),
    url => fs.readFile(path.join(root, 'admin/public', url.slice('/admin/'.length))));
  await recreateDir(dest);
  await copyRootFiles();
  await copyRootDirs();
  await mirrorAdmin(delivery);
  console.log(`Built cf_site at: ${dest}`);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
