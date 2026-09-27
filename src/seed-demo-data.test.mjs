import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdminSql, buildData, buildSiteSql, buildStaticAssets, submitDemoForms } from '../scripts/seed_demo_data.mjs';
import { PAGE_KEYS } from './site-editor-schema.js';
import { validatePageFields } from './site-editor-validate.js';

test('demo data creates at least ten records for every profile section and schedule', () => {
  const data = buildData({ count: 10, asOf: '2026-09-25T12:00:00.000Z' });
  for (const page of ['leadership', 'associate_ministers', 'deacons', 'deaconesses', 'official_team_trustees', 'ministries']) {
    const demoProfiles = data.pages[page].profiles.filter((profile) => profile.id.startsWith('demo-'));
    assert.equal(demoProfiles.length, 10, `${page} should contain ten demo profiles`);
    const validated = validatePageFields(page, data.pages[page], { partial: false });
    assert.equal(validated.errors.length, 0, `${page} should validate: ${validated.errors.join('; ')}`);
  }
  assert.equal(data.pages.home['worship.schedule'].filter((item) => item.id.startsWith('demo-')).length, 10);
  assert.equal(data.pages.home['ministries.weeklySchedule'].filter((item) => item.id.startsWith('demo-')).length, 10);
  for (const page of PAGE_KEYS) assert.ok(data.pages[page], `${page} should have CMS fields`);
});

test('generated SQL includes CMS fields and separate site submission fallback records', () => {
  const data = buildData({ count: 10, asOf: '2026-09-25T12:00:00.000Z' });
  const adminSql = buildAdminSql(data);
  const siteSql = buildSiteSql(data, { includeSubmissionFallback: true });
  assert.match(adminSql, /demo-profile-leadership-01/);
  assert.match(adminSql, /demo-profile-official_team_trustees-10/);
  assert.match(adminSql, /site_page_content/);
  assert.match(siteSql, /demo-contact-message-01/);
  assert.match(siteSql, /demo-facility-rental-10/);
  assert.match(siteSql, /skipped_demo/);
});

test('submitDemoForms uses all three public submission endpoints', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, demo: true }) };
  };
  const result = await submitDemoForms({
    baseUrl: 'https://mmmbc-preview.example',
    count: 10,
    asOf: '2026-09-25T12:00:00.000Z',
    fetchImpl
  });
  assert.equal(result.newsletter.length, 10);
  assert.equal(result.contact.length, 10);
  assert.equal(result.facilityRental.length, 10);
  assert.equal(requests.length, 30);
  assert.equal(requests.filter((request) => request.url.endsWith('/newsletter/subscribe')).length, 10);
  assert.equal(requests.filter((request) => request.url.endsWith('/contact-message')).length, 10);
  assert.equal(requests.filter((request) => request.url.endsWith('/facility-rental-request')).length, 10);
  assert.equal(requests[29].body.form.synthetic, true);
});

test('static asset output has ten demo records in every static collection', () => {
  const data = buildData({ count: 10, asOf: '2026-09-25T12:00:00.000Z' });
  const assets = buildStaticAssets(data);
  assert.equal(assets['announcements.json'].posts.length, 10);
  assert.equal(assets['schedule.json'].length, 10);
  assert.equal(assets['gallery.json'].items.length, 10);
  assert.equal(assets['bulletins.json'].bulletins.length, 10);
  assert.equal(assets['documents.json'].documents.length, 10);
  assert.equal(assets['livestream.json'].recurring.length, 10);
  assert.equal(assets['profiles.json'].profiles.filter((profile) => profile.id.startsWith('demo-')).length, 60);
});
