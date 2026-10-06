import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ZEFFY_DONATION_URL, GIVING_PAGE_PATHS, givingConfiguration, handleGivingPageRequest } from './worker-giving-pages.js';
import { securityHeaders } from './launch-security.js';
import { handleGivingRequest } from './worker-giving.js';
import worker from './worker-admin-api-wrapper.js';

const template = await readFile(new URL('../Pages/giving.html', import.meta.url), 'utf8');
const assets = { fetch: async request => {
  assert.equal(new URL(request.url).pathname, '/Pages/giving.html');
  assert.equal(request.headers.get('Accept-Encoding'), 'identity');
  return new Response(template, { headers: { ETag: 'stale', 'Content-Length': '1', 'Content-Type': 'text/html' } });
} };
const request = (path = '/give', method = 'GET') => new Request('https://mmmbc.alphazonelabs.com' + path, { method });

test('/give renders the branded Zeffy form without a custom Stripe checkout', async () => {
  const response = await handleGivingPageRequest(request(), { ASSETS: assets });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('ETag'), null);
  assert.equal(response.headers.get('Content-Length'), null);
  const html = await response.text();
  assert.ok(html.includes('Give with purpose.'));
  assert.ok(html.includes(ZEFFY_DONATION_URL));
  assert.ok(html.includes('https://www.zeffy.com/embed/donation-form/tithes-and-offering-59'));
  assert.ok(html.includes('data-zeffy-embed'));
  assert.ok(html.includes('allow="payment"'));
  assert.ok(html.includes('href="https://mmmbc.alphazonelabs.com/give"'));
  assert.ok(!html.includes('id="givingForm"'));
  assert.ok(!html.includes('<!-- ZEFFY_CHECKOUT -->'));
  assert.equal(await handleGivingRequest(request('/api/giving/checkout', 'POST'), { GIVING_PROVIDER: 'zeffy' }), null);
});

test('legacy routes redirect to /give without inventing a payment confirmation', async () => {
  for (const pathname of GIVING_PAGE_PATHS) {
    if (pathname === '/give') continue;
    const response = await handleGivingPageRequest(request(pathname), {});
    assert.equal(response.status, 302, pathname);
    assert.equal(response.headers.get('location'), 'https://mmmbc.alphazonelabs.com/give');
  }
  assert.equal(await handleGivingPageRequest(request('/unrelated'), {}), null);
  assert.equal(await handleGivingPageRequest(request('/give', 'POST'), {}), null);
});

test('HEAD returns the same page headers without a body', async () => {
  const response = await handleGivingPageRequest(request('/give', 'HEAD'), { ASSETS: assets });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(await response.text(), '');
});

test('account-specific URLs override the existing campaign and stay escaped', async () => {
  const env = { ASSETS: assets, ZEFFY_DONATION_URL: 'https://www.zeffy.com/en-US/donation-form/new-campaign', ZEFFY_EMBED_URL: 'https://www.zeffy.com/embed/en-US/donation-form/uuid?x=1&y=%22' };
  assert.equal(givingConfiguration(env).embedUrl, env.ZEFFY_EMBED_URL);
  const html = await (await handleGivingPageRequest(request(), env)).text();
  assert.ok(html.includes('donation-form/new-campaign'));
  assert.ok(!html.includes('tithes-and-offering-59'));
  assert.ok(html.includes('?x=1&amp;y=%22'));
});

test('invalid checkout URLs cannot send donors to an untrusted host', async () => {
  for (const value of ['javascript:alert(1)', 'https://www.zeffy.com.evil.test/en-US/donation-form/x', 'https://www.zeffy.com@evil.test/en-US/donation-form/x', 'http://www.zeffy.com/en-US/donation-form/x', 'https://www.zeffy.com/en-US/donation-form/x/extra', '']) {
    const config = givingConfiguration({ ZEFFY_DONATION_URL: value });
    assert.deepEqual(config, { donationUrl: '', embedUrl: '' });
    const html = await (await handleGivingPageRequest(request(), { ASSETS: assets, ZEFFY_DONATION_URL: value })).text();
    assert.ok(!html.includes('<iframe'));
    assert.ok(!html.includes('givingDirect'));
    assert.ok(html.includes('temporarily unavailable'));
  }
});

test('invalid or disabled embeds retain the supported direct checkout', async () => {
  for (const value of ['', 'https://evil.test/embed/donation-form/x', 'https://www.zeffy.com/embed/v2/zeffy-embed.js']) {
    const html = await (await handleGivingPageRequest(request(), { ASSETS: assets, ZEFFY_EMBED_URL: value })).text();
    assert.ok(!html.includes('<iframe'));
    assert.ok(html.includes(ZEFFY_DONATION_URL));
  }
});

test('missing page assets return an honest service-unavailable response', async () => {
  assert.equal((await handleGivingPageRequest(request(), {})).status, 503);
  assert.equal((await handleGivingPageRequest(request(), { ASSETS: { fetch: async () => new Response(null, { status: 404 }) } })).status, 503);
});

test('Zeffy script and payment permissions apply only to giving routes', () => {
  const giving = securityHeaders(new Response(''), '/give');
  const csp = giving.headers.get('Content-Security-Policy');
  assert.match(csp, /script-src https:\/\/www.zeffy.com /);
  assert.match(csp, /connect-src https:\/\/www.zeffy.com /);
  assert.match(giving.headers.get('Permissions-Policy'), /payment=\(self "https:\/\/www.zeffy.com"\)/);
  const admin = securityHeaders(new Response(''), '/admin/');
  assert.ok(!admin.headers.get('Content-Security-Policy').includes('script-src https://www.zeffy.com'));
  assert.equal(admin.headers.get('Permissions-Policy'), 'camera=(), microphone=(), geolocation=()');
});

test('the deployed Worker serves giving publicly with Zeffy security permissions', async () => {
  const response = await worker.fetch(request(), { ASSETS: assets, GIVING_PROVIDER: 'zeffy' }, {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Security-Policy'), /script-src https:\/\/www.zeffy.com /);
  assert.ok((await response.text()).includes('Give with purpose.'));
});
