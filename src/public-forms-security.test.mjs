import assert from 'node:assert/strict';
import test from 'node:test';
import { honeypotTripped, verifyTurnstile } from './public-forms-security.js';

test('production forms fail closed when Turnstile is not configured', async () => {
  const result = await verifyTurnstile({ ENVIRONMENT: 'production' }, '', '127.0.0.1');
  assert.equal(result.ok, false);
  assert.match(result.error, /temporarily unavailable/i);
});

test('local forms may run without Turnstile configuration', async () => {
  const result = await verifyTurnstile({ ENVIRONMENT: 'development' }, '', '127.0.0.1');
  assert.deepEqual(result, { ok: true, skipped: true });
});

test('honeypot rejects filled bot fields', () => {
  assert.equal(honeypotTripped({ website: 'spam' }), true);
  assert.equal(honeypotTripped({ website: '' }), false);
});
