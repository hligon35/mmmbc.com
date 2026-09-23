// Targeted regression tests for the Site Editor's newest functionality:
// - the 'number' scalar field type (validation + clamping)
// - the Home page's new schedule collections (worship.schedule / ministries.weeklySchedule)
// - mergeWithSeed(), which backfills newly-added schema fields onto existing D1 rows
//
// Run with: node --test src/site-editor.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { validatePageFields } from './site-editor-validate.js';
import { getPageSchema, INITIAL_PUBLISHED_CONTENT } from './site-editor-schema.js';

test('home page schema exposes the two new schedule collections', () => {
  const schema = getPageSchema('home');
  assert.ok(schema, 'home schema should exist');
  assert.equal(schema.fields['worship.schedule'].type, 'collection');
  assert.equal(schema.fields['ministries.weeklySchedule'].type, 'collection');
  assert.equal(schema.fields['worship.schedule'].itemFields.sortOrder.type, 'number');
});

test('validatePageFields accepts a well-formed schedule collection', () => {
  const items = INITIAL_PUBLISHED_CONTENT.home['worship.schedule'];
  const { ok, fields, errors } = validatePageFields('home', { 'worship.schedule': items }, { partial: true });
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  assert.ok(ok);
  assert.equal(fields['worship.schedule'].length, items.length);
  assert.equal(fields['worship.schedule'][0].day, 'Sunday');
});

test('validatePageFields clamps out-of-range sortOrder to schema min/max', () => {
  const items = [
    { id: 'abc-1', day: 'Sunday', time: '09:00', title: 'Test', details: '', sortOrder: -5 },
    { id: 'abc-2', day: 'Sunday', time: '10:00', title: 'Test 2', details: '', sortOrder: 99999 }
  ];
  const { fields, errors } = validatePageFields('home', { 'worship.schedule': items }, { partial: true });
  assert.equal(errors.length, 0);
  assert.equal(fields['worship.schedule'][0].sortOrder, 0);
  assert.equal(fields['worship.schedule'][1].sortOrder, 999);
});

test('validatePageFields rejects duplicate collection item ids', () => {
  const items = [
    { id: 'dup', day: 'Sunday', time: '09:00', title: 'A', details: '', sortOrder: 0 },
    { id: 'dup', day: 'Monday', time: '10:00', title: 'B', details: '', sortOrder: 1 }
  ];
  const { errors } = validatePageFields('home', { 'worship.schedule': items }, { partial: true });
  assert.ok(errors.some((e) => /duplicate item id/i.test(e)));
});

test('validatePageFields rejects invalid item ids', () => {
  const items = [{ id: 'not a valid id!', day: 'Sunday', time: '09:00', title: 'A', details: '', sortOrder: 0 }];
  const { errors } = validatePageFields('home', { 'worship.schedule': items }, { partial: true });
  assert.ok(errors.some((e) => /invalid/i.test(e)));
});

test('validatePageFields requires non-number to fall back to 0 with an error', () => {
  const items = [{ id: 'x-1', day: 'Sunday', time: '09:00', title: 'A', details: '', sortOrder: 'not-a-number' }];
  const { fields, errors } = validatePageFields('home', { 'worship.schedule': items }, { partial: true });
  assert.ok(errors.some((e) => /must be a number/i.test(e)));
  assert.equal(fields['worship.schedule'][0].sortOrder, 0);
});

test('publish-time validation enforces required page.title on ministries page', () => {
  const { ok, errors } = validatePageFields('ministries', {}, { partial: false });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /page.title.*required/i.test(e)));
});

test('ministries editor seed exposes the fourteen ministry profiles', () => {
  const profiles = INITIAL_PUBLISHED_CONTENT.ministries.profiles;
  assert.equal(profiles.length, 14);
  assert.deepEqual(profiles.map((profile) => profile.id), [
    'ministries-1', 'ministries-2', 'ministries-3',
    'ministries-4', 'ministries-5', 'ministries-6',
    'ministries-7', 'ministries-8', 'ministries-9',
    'ministries-10', 'ministries-11', 'ministries-12',
    'ministries-13', 'ministries-14'
  ]);
  assert.ok(profiles.every((profile) => profile.name && profile.image.url && profile.bio));

  const { ok, fields, errors } = validatePageFields('ministries', {
    'page.title': INITIAL_PUBLISHED_CONTENT.ministries['page.title'],
    'page.intro': INITIAL_PUBLISHED_CONTENT.ministries['page.intro'],
    profiles
  }, { partial: false });
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  assert.ok(ok);
  assert.equal(fields.profiles.length, profiles.length);
});

test('leadership editor seed contains the staff profiles', () => {
  const profiles = INITIAL_PUBLISHED_CONTENT.leadership.profiles;
  assert.deepEqual(profiles.map((profile) => profile.name), [
    'Rev. Stephen Harvey', 'Marsha Roundtree', 'Weldon Stokes', 'John Burnett'
  ]);
  assert.ok(profiles.every((profile) => profile.group === 'staff' && profile.image.url && profile.bio));

  const { ok, errors } = validatePageFields('leadership', {
    ...INITIAL_PUBLISHED_CONTENT.leadership,
    profiles
  }, { partial: false });
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  assert.ok(ok);
});

test('profile editor exposes every leadership subpage with seeded profiles', () => {
  const pages = [
    ['leadership', 4],
    ['associate_ministers', 6],
    ['deacons', 6],
    ['deaconesses', 7],
    ['official_team_trustees', 8]
  ];
  pages.forEach(([page, count]) => {
    const schema = getPageSchema(page);
    assert.ok(schema, `${page} schema should exist`);
    assert.equal(schema.fields.profiles.type, 'collection');
    const profiles = INITIAL_PUBLISHED_CONTENT[page].profiles;
    assert.equal(profiles.length, count);
    const { ok, errors } = validatePageFields(page, {
      ...INITIAL_PUBLISHED_CONTENT[page],
      profiles
    }, { partial: false });
    assert.equal(errors.length, 0, `${page} should validate: ${JSON.stringify(errors)}`);
    assert.ok(ok);
  });
});

test('public profile pages keep their corrected assignments', () => {
  const leadership = fs.readFileSync(new URL('../Pages/leadership.html', import.meta.url), 'utf8');
  const associates = fs.readFileSync(new URL('../Pages/associate_ministers.html', import.meta.url), 'utf8');
  const deacons = fs.readFileSync(new URL('../Pages/deacons.html', import.meta.url), 'utf8');
  const deaconesses = fs.readFileSync(new URL('../Pages/deaconesses.html', import.meta.url), 'utf8');
  const officialTeam = fs.readFileSync(new URL('../Pages/official_team_trustees.html', import.meta.url), 'utf8');
  const ministries = fs.readFileSync(new URL('../Pages/ministries.html', import.meta.url), 'utf8');

  assert.match(leadership, /Rev\. Stephen Harvey/);
  assert.match(leadership, /Marsha Roundtree/);
  assert.doesNotMatch(leadership, /meta http-equiv="refresh"/i);
  assert.match(associates, /Evangelist Melanie Nunn/);
  assert.match(associates, /Rev\. Dennis Gray/);
  assert.match(deacons, /data-cms-page="deacons"/);
  assert.match(deaconesses, /data-cms-page="deaconesses"/);
  assert.match(officialTeam, /data-cms-page="official_team_trustees"/);
  assert.match(ministries, /Music Department/);
  assert.match(ministries, /Video \/ Audio Ministry/);
  assert.doesNotMatch(ministries, /Evangelist Melanie Nunn/);
});
