import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const workerSource = readFileSync(path.join(ROOT, 'src', 'worker.js'), 'utf8');
const authWrapperSource = readFileSync(path.join(ROOT, 'src', 'worker-auth-wrapper.js'), 'utf8');

const requiredWorkerRouteChecks = [
  "url.pathname === '/api/public/announcements'",
  "url.pathname === '/api/public/events'",
  "url.pathname === '/api/public/bulletins'",
  "url.pathname === '/api/public/gallery'",
  "url.pathname === '/api/public/youtube'",
  "url.pathname === '/api/public/site-settings'",
  "url.pathname === '/api/public/livestream'",
  "url.pathname === '/api/public/newsletter/subscribe'",
  "url.pathname === '/api/public/contact-message'",
  "url.pathname === '/api/public/facility-rental-request'",
  "url.pathname.startsWith('/api/site-content/')",
  "url.pathname === '/api/admin/integration-health'",
  "url.pathname === '/api/support/message'",
  "usersPath === '/api/users/invite'",
  "url.pathname === '/api/newsletter/send'",
  "url.pathname.startsWith('/cdn/gallery/')",
  "url.pathname.startsWith('/api/')"
];

const requiredAuthWrapperChecks = [
  "url.pathname === '/api/auth/providers'",
  "url.pathname === '/api/csrf'",
  "url.pathname === '/api/auth/google'",
  "url.pathname === '/api/auth/logout'",
  "url.pathname === '/api/me'",
  "url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')"
];

test('worker route manifest guards critical endpoints', () => {
  for (const pattern of requiredWorkerRouteChecks) {
    assert.equal(
      workerSource.includes(pattern),
      true,
      `Expected worker route pattern to exist: ${pattern}`
    );
  }
});

test('worker auth wrapper keeps expected auth/public boundaries', () => {
  for (const pattern of requiredAuthWrapperChecks) {
    assert.equal(
      authWrapperSource.includes(pattern),
      true,
      `Expected auth wrapper guard to exist: ${pattern}`
    );
  }
});
