import assert from 'node:assert/strict';
import test from 'node:test';
import { sendResendBatch, sendResendEmail } from './email-resend.js';

test('Resend client rejects missing server configuration', async () => {
  const result = await sendResendEmail({}, { to: 'admin@example.com', subject: 'Test' });
  assert.equal(result.ok, false);
  assert.match(result.error, /RESEND_API_KEY/);
});

test('Resend client sends a normalized transactional payload', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
  };

  const result = await sendResendEmail(
    { RESEND_API_KEY: 'test-key', RESEND_FROM_EMAIL: 'no-reply@mmmbc.com', RESEND_FROM_NAME: 'MMMBC' },
    { to: 'member@example.com', subject: 'Welcome', text: 'Hello', replyTo: 'office@mmmbc.com' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.id, 'email_123');
  assert.equal(captured.url, 'https://api.resend.com/emails');
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(body.to, ['member@example.com']);
  assert.equal(body.reply_to, 'office@mmmbc.com');
  assert.equal(body.from, 'MMMBC <no-reply@mmmbc.com>');
  assert.equal(captured.options.headers['Idempotency-Key'], undefined);
});

test('Resend batch isolates recipients and chunks at 100', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const recipients = Array.from({ length: 101 }, (_, index) => `member${index}@example.com`);
  const result = await sendResendBatch(
    { RESEND_API_KEY: 'test-key', RESEND_FROM_EMAIL: 'no-reply@mmmbc.com' },
    { recipients, subject: 'News', text: 'Update' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.sent, 101);
  assert.deepEqual(payloads.map((batch) => batch.length), [100, 1]);
  assert.ok(payloads.flat().every((message) => message.to.length === 1));
});
