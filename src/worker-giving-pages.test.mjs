import assert from 'node:assert/strict';
import test from 'node:test';
import { ZEFFY_DONATION_URL, handleGivingPageRequest } from './worker-giving-pages.js';

test('/give redirects directly to the Zeffy donation form', async () => {
  const response = await handleGivingPageRequest(new Request('https://mmmbc.com/give'), {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), ZEFFY_DONATION_URL);
});

test('legacy branded giving routes redirect to the canonical /give route', async () => {
  for (const pathname of ['/giving', '/giving.html', '/giving-success.html']) {
    const response = await handleGivingPageRequest(new Request(`https://mmmbc.com${pathname}`), {});
    assert.equal(response.status, 301, pathname);
    assert.equal(response.headers.get('location'), 'https://mmmbc.com/give', pathname);
  }
});
