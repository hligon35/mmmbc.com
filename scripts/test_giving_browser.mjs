import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { handleGivingPageRequest } from '../src/worker-giving-pages.js';
import { securityHeaders } from '../src/launch-security.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg' };
const assets = { fetch: async request => {
  const pathname = new URL(request.url).pathname;
  try {
    const body = await readFile(path.join(root, pathname));
    return new Response(body, { headers: { 'Content-Type': types[path.extname(pathname)] || 'application/octet-stream' } });
  } catch { return new Response('Missing', { status: 404 }); }
} };
const server = http.createServer(async (req, res) => {
  const request = new Request('http://' + req.headers.host + req.url);
  const pathname = new URL(request.url).pathname;
  const response = securityHeaders(await handleGivingPageRequest(request, { ASSETS: assets }) || await assets.fetch(request), pathname);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + '/give';
const browser = await chromium.launch({ headless: true, ...(process.env.GIVING_CHROMIUM_PATH ? { executablePath: process.env.GIVING_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-gpu'] } : {}) });
try {
  for (const scenario of ['modern', 'blocked', 'no-js']) {
    const context = await browser.newContext({ javaScriptEnabled: scenario !== 'no-js' });
    await context.route('https://www.zeffy.com/**', route => {
      if (route.request().url().endsWith('zeffy-embed.js')) {
        if (scenario === 'blocked') return route.abort();
        // Simulate the documented third-party mount; never make a real payment.
        return route.fulfill({ contentType: 'text/javascript', body: "const host=document.querySelector('[data-zeffy-embed]');const frame=document.createElement('iframe');frame.title='Zeffy test checkout';frame.src='https://www.zeffy.com'+host.dataset.formUrl;frame.style.cssText='width:100%;height:700px;border:0';host.append(frame);" });
      }
      return route.fulfill({ contentType: 'text/html', body: '<h2>Zeffy checkout test fixture</h2>' });
    });
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
    await context.route('https://fonts.gstatic.com/**', route => route.abort());
    for (const width of [1440, 390, 320]) {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (scenario === 'modern') await page.locator('#givingEmbed iframe').waitFor();
      else await page.locator('#givingEmbedFallback iframe').waitFor({ state: 'visible' });
      assert.equal(await page.locator('h1').textContent(), 'Give with purpose.');
      assert.equal(await page.locator('.givingCard input').count(), 0);
      assert.equal(await page.locator('.givingDirect a').getAttribute('href'), 'https://www.zeffy.com/en-US/donation-form/tithes-and-offering-59');
      if (scenario === 'modern') {
        assert.equal(await page.locator('#givingEmbed iframe').count(), 1);
        assert.equal(await page.locator('#givingEmbedFallback').count(), 0);
      } else {
        assert.equal(await page.locator('#givingEmbedFallback').isVisible(), true);
        assert.match(await page.locator('#givingEmbedFallback iframe').getAttribute('src'), /^https:\/\/www.zeffy.com\/embed\//);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, scenario + ' overflow at ' + width);
      if (width < 400 && scenario !== 'no-js') {
        await page.locator('#menuButton').click();
        assert.equal(await page.locator('#menuButton').getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#menuButton').getAttribute('aria-expanded'), 'false');
      }
      assert.deepEqual(errors, []);
      if (scenario === 'modern' && width === 390 && process.env.GIVING_SCREENSHOT) await page.screenshot({ path: process.env.GIVING_SCREENSHOT, fullPage: true });
      await page.close();
    }
    await context.close();
    console.log('Passed giving browser scenario:', scenario, '(1440, 390, 320 px)');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
