// Measures request count, response bytes, and timing for the admin against isolated in-memory
// stores. Usage: node scripts/measure_admin_performance.mjs [repoRoot]. Never touches production.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(process.argv[2] || '.');
process.chdir(root);
const worker = (await import(pathToFileURL(path.join(root, 'src/worker-admin-api-wrapper.js')))).default;
const { workspaceEnv } = await import(pathToFileURL(path.join(root, 'src/test-support/workspace-db.mjs')));
const env = workspaceEnv();
env.GALLERY_BUCKET = { get: async () => null, put: async () => {}, list: async () => ({ objects: [], truncated: false }) };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
env.ASSETS = { async fetch(request) {
  const pathname = new URL(request.url).pathname;
  const filename = path.resolve('cf_site', '.' + (pathname === '/admin' || pathname === '/admin/' ? '/admin/index.html' : pathname));
  try { return new Response(await fs.readFile(filename), { headers: { 'Content-Type': types[path.extname(filename)] || 'text/plain' } }); } catch { return new Response('Missing', { status: 404 }); }
} };

const seed = env.DB.sqlite;
seed.exec('BEGIN');
const msg = seed.prepare('INSERT INTO contact_messages(id,name,email,subject,message,created_at) VALUES(?,?,?,?,?,?)');
for (let i = 0; i < 354; i++) msg.run('m' + i, 'Sender ' + i, 's' + i + '@example.com', 'Subject ' + i, 'Body text '.repeat(40), new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
const gal = seed.prepare('INSERT INTO gallery_items(id,album,label,tags_json,file_key,thumb_key,original_name,created_at,position) VALUES(?,?,?,?,?,?,?,?,?)');
for (let i = 0; i < 1200; i++) gal.run('g' + i, i % 2 ? 'Easter' : 'Choir', 'Label ' + i, '[]', 'k' + i + '.jpg', null, 'img' + i + '.jpg', new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), i);
seed.exec('COMMIT');

const server = http.createServer(async (incoming, outgoing) => {
  let body = ''; for await (const chunk of incoming) body += chunk;
  const request = new Request('http://127.0.0.1:' + server.address().port + incoming.url, { method: incoming.method, headers: incoming.headers, ...(!['GET', 'HEAD'].includes(incoming.method) ? { body } : {}) });
  const response = await worker.fetch(request, env, { waitUntil() {} });
  outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 960 } })).newPage();
await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }));
await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
let stats = { requests: 0, api: 0, bytes: 0 };
const pending = [];
page.on('response', (response) => {
  stats.requests++;
  if (new URL(response.url()).pathname.startsWith('/api/')) stats.api++;
  pending.push(response.body().then((buffer) => { stats.bytes += buffer.length; }).catch(() => {}));
});
const measure = async (label, action) => {
  stats = { requests: 0, api: 0, bytes: 0 };
  const started = performance.now();
  await action();
  await page.waitForLoadState('networkidle');
  await Promise.all(pending.splice(0));
  console.log(JSON.stringify({ label, ms: Math.round(performance.now() - started), requests: stats.requests, apiRequests: stats.api, kb: Math.round(stats.bytes / 1024) }));
};
const open = async () => { if (await page.locator('#adminSideNav').getAttribute('aria-hidden') !== 'false') await page.locator('#navDrawerToggle').click(); };
await measure('cold boot to usable dashboard', async () => { await page.goto(origin + '/admin/'); await page.locator('#dashboardCard:not([hidden])').waitFor(); await page.locator('#dashboardSummaryGrid .dashboardSummaryCard').first().waitFor(); });
await measure('warm reload', async () => { await page.reload(); await page.locator('#dashboardSummaryGrid .dashboardSummaryCard').first().waitFor(); });
await measure('navigate to Messages (354 rows)', async () => { await open(); await page.locator('#tabBtn-submissions').click(); await page.locator('#submissionsTableBody tr').first().waitFor(); });
await measure('navigate to Photos (1200 items)', async () => { await open(); await page.locator('#tabBtn-photos').click(); await page.locator('#photoGrid > *').first().waitFor(); });
await measure('navigate to Announcements & Events', async () => { await open(); await page.locator('#tabBtn-content').click(); await page.locator('#tab-content:not([hidden])').waitFor(); });
await measure('navigate back to Home', async () => { await open(); await page.locator('#tabBtn-home').click(); await page.locator('#tab-home:not([hidden])').waitFor(); });
await browser.close(); server.close();
