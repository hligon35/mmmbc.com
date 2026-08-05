const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = readFileSync(path.join(__dirname, 'server.js'), 'utf8');

const requiredRouteMarkers = [
  "app.post('/api/auth/google'",
  "app.post('/api/auth/logout'",
  "app.get('/api/me'",
  "app.post('/api/support/message'",
  "app.post('/api/users/invite'",
  "app.get('/api/admin/health'",
  "app.get('/api/gallery/r2tree'",
  "app.post('/api/gallery/sync'",
  "app.post('/api/announcements'",
  "app.post('/api/events'",
  "app.post('/api/bulletins/upload'",
  "app.post('/api/newsletter/send'",
  "app.get('/api/subscribers'",
  "app.put('/api/subscribers'",
  "app.use('/api/directory'",
  "app.post('/api/finances/entries'",
  "app.post('/api/finances/funds/transfers'",
  "app.post('/api/finances/statements/generate'",
  "app.post('/api/finances/controls/collections'",
  "app.get('/api/finances/clergy-housing'"
];

const requiredSecurityMarkers = [
  "requireAuth, csrfProtection",
  "requirePermission(PERMISSIONS.USERS_MANAGE)",
  "requirePermission(PERMISSIONS.FINANCE_WRITE)",
  "requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE)",
  "requirePermission(PERMISSIONS.WEBSITE_WRITE)",
  "hasValidSupportApiToken(req)",
  "app.post('/api/auth/login', loginLimiter"
];

test('admin server keeps critical API route markers', () => {
  for (const marker of requiredRouteMarkers) {
    assert.equal(source.includes(marker), true, `Missing critical route marker: ${marker}`);
  }
});

test('admin server keeps critical auth and permission markers', () => {
  for (const marker of requiredSecurityMarkers) {
    assert.equal(source.includes(marker), true, `Missing critical security marker: ${marker}`);
  }
});
