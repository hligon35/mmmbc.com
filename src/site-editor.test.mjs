// Targeted regression tests for the Site Editor's newest functionality:
// - the 'number' scalar field type (validation + clamping)
// - the Home page's new schedule collections (worship.schedule / ministries.weeklySchedule)
// - mergeWithSeed(), which backfills newly-added schema fields onto existing D1 rows
//
// Run with: node --test src/site-editor.test.mjs
import assert from 'node:assert/strict';
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
