import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const workerSource = readFileSync(path.join(ROOT, 'src', 'worker.js'), 'utf8');
const wrapperSource = readFileSync(path.join(ROOT, 'src', 'worker-admin-api-wrapper.js'), 'utf8');

const expectedWorkerFallbacks = [
  "json({ error: 'Directory endpoint not found.' }, { status: 404 })",
  "json({ error: 'API endpoint not found.' }, { status: 404 })"
];

const expectedWrapperFallbacks = [
  "return json({ error: 'API endpoint not found.' }, 404);"
];

const expectedMethodNotAllowedMarkers = [
  "json({ error: 'Method not allowed' }, { status: 405 })"
];

test('worker keeps API 404 fallback contracts', () => {
  for (const marker of expectedWorkerFallbacks) {
    assert.equal(workerSource.includes(marker), true, `Missing worker 404 fallback marker: ${marker}`);
  }
});

test('wrapper keeps API 404 fallback contract', () => {
  for (const marker of expectedWrapperFallbacks) {
    assert.equal(wrapperSource.includes(marker), true, `Missing wrapper 404 fallback marker: ${marker}`);
  }
});

test('worker preserves method-not-allowed responses in finance/public mutators', () => {
  for (const marker of expectedMethodNotAllowedMarkers) {
    assert.equal(workerSource.includes(marker), true, `Missing method-not-allowed marker: ${marker}`);
  }
});
