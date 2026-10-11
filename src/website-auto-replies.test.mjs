import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker-admin-api-wrapper.js';
import { sqliteD1 } from './test-support/workspace-db.mjs';
import { retrySubmissionEmails } from './submission-delivery.js';
import { websiteAutoReply } from './website-email-templates.js';
import { tokenEmail } from './newsletter-preferences.js';

function environment() {
  const db = sqliteD1('migrations');
  return { DB: db, SITE_DB: db, ENVIRONMENT: 'development', PUBLIC_SITE_URL: 'https://mmmbc.com',
    RESEND_API_KEY: 'mock', RESEND_FROM_EMAIL: 'no-reply@mmmbc.com', RESEND_FROM_NAME: 'Mount Moriah Missionary Baptist Church',
    WEBSITE_REPLY_TO_EMAIL: 'mtmoriahmbc1201@gmail.com', SUPPORT_TO_EMAIL: 'staff@example.com',
    NEWSLETTER_UNSUBSCRIBE_SECRET: 's'.repeat(40) };
}
function captureEmails(t, fail = () => false) {
  const original = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    const payload = JSON.parse(options.body);
    messages.push({ ...payload, key: options.headers['Idempotency-Key'] });
    return fail(payload) ? Response.json({ message: 'Provider unavailable' }, { status: 503 }) : Response.json({ id: 'accepted-' + messages.length });
  };
  t.after(() => { globalThis.fetch = original; });
  return messages;
}
function submit(path, body, env) {
  return worker.fetch(new Request('https://mmmbc.com/api/public/' + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, {});
}
const contact = { firstName: 'Ada', lastName: 'Church', email: 'visitor@example.com', message: 'A private pastoral question.' };
const rental = { firstName: 'Ada', lastName: 'Church', contactEmail: 'visitor@example.com', phone: '2705550100', eventGroup: 'Community Choir',
  purpose: 'Rehearsal', dateOfUse: '2026-12-10', timeFrom: '10:00', timeTo: '12:00', facilities: ['Fellowship Hall'],
  responsibleSignature: 'Ada Church', responsibleSignatureDate: '2026-10-11' };

test('contact and both rental forms send personalized branded receipts after saving', async t => {
  const env = environment();
  const emails = captureEmails(t);
  for (const [path, body] of [['contact-message', contact],
    ['facility-rental-request', { audience: 'member', form: rental }],
    ['facility-rental-request', { audience: 'non_member', form: rental }]]) {
    const response = await submit(path, body, env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  const receipts = emails.filter(email => email.to[0] === 'visitor@example.com');
  assert.equal(receipts.length, 3);
  for (const email of receipts) {
    assert.equal(email.reply_to, 'mtmoriahmbc1201@gmail.com');
    assert.equal(email.from, 'Mount Moriah Missionary Baptist Church <no-reply@mmmbc.com>');
    assert.match(email.html, /https:\/\/mmmbc\.com\/ConImg\/MtMoriahLogo-1\.png/);
    assert.match(email.html, /#c46123/);
    assert.match(email.text, /Hello Ada Church,/);
    assert.match(email.text, /1201 South 8th Street/);
    assert.match(email.text, /Reference:/);
  }
  assert.doesNotMatch(receipts[0].html, /private pastoral question/);
  assert.match(receipts[1].text, /Member rental/);
  assert.match(receipts[2].text, /Non-member rental/);
  assert.match(receipts[1].text, /Community Choir/);
  assert.match(receipts[1].text, /does not confirm a reservation/);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM contact_messages WHERE auto_reply_status='sent'").get().count, 1);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM facility_rental_requests WHERE auto_reply_status='sent'").get().count, 2);
  assert.equal(emails.filter(email => email.to[0] === 'staff@example.com').length, 3);
});

test('a new newsletter signup gets a branded welcome and signed unsubscribe link only once', async t => {
  const env = environment();
  const emails = captureEmails(t);
  const signup = { firstName: 'Ada', lastName: 'Church', email: 'member@example.com' };
  assert.equal((await submit('newsletter/subscribe', signup, env)).status, 200);
  assert.equal(emails.length, 1);
  assert.match(emails[0].text, /Your subscription is active/);
  const link = emails[0].text.match(/Unsubscribe: (\S+)/)[1];
  assert.equal(await tokenEmail(env, new URL(link).searchParams.get('token')), 'member@example.com');
  assert.equal((await submit('newsletter/subscribe', signup, env)).status, 200);
  assert.equal(emails.length, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM newsletter_subscribers').get().count, 1);
});

test('failed receipt queues independently of staff mail and retries the same branded payload', async t => {
  const env = environment();
  let unavailable = true;
  const emails = captureEmails(t, payload => unavailable && payload.to[0] === 'visitor@example.com');
  const response = await submit('contact-message', contact, env);
  assert.equal(response.status, 200);
  assert.match((await response.json()).warning, /confirmation email/);
  assert.equal(emails.length, 2);
  assert.equal(env.DB.sqlite.prepare('SELECT auto_reply_status FROM contact_messages').get().auto_reply_status, 'retrying');
  const job = env.DB.sqlite.prepare('SELECT * FROM email_delivery_jobs').get();
  assert.equal(job.status, 'pending');
  assert.equal(JSON.parse(job.payload_json).replyTo, 'mtmoriahmbc1201@gmail.com');
  unavailable = false;
  env.DB.sqlite.exec("UPDATE email_delivery_jobs SET next_attempt_at='2000-01-01'");
  await retrySubmissionEmails(env);
  assert.equal(emails[2].key, emails[0].key);
  assert.equal(emails[2].html, emails[0].html);
  assert.equal(env.DB.sqlite.prepare('SELECT auto_reply_status FROM contact_messages').get().auto_reply_status, 'sent');
  assert.equal(env.DB.sqlite.prepare('SELECT status FROM email_delivery_jobs').get().status, 'sent');
});

test('a queued newsletter welcome is cancelled after unsubscribe', async t => {
  const env = environment();
  const emails = captureEmails(t, () => true);
  const response = await submit('newsletter/subscribe', { firstName: 'Ada', lastName: 'Church', email: 'member@example.com' }, env);
  assert.equal(response.status, 200);
  assert.match((await response.json()).warning, /will be retried/);
  env.DB.sqlite.exec("UPDATE subscribers SET status='unsubscribed'; UPDATE email_delivery_jobs SET next_attempt_at='2000-01-01'");
  await retrySubmissionEmails(env);
  assert.equal(emails.length, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT status FROM email_delivery_jobs').get().status, 'cancelled');
});

test('staff notification failure does not change the successful visitor confirmation', async t => {
  const env = environment();
  let unavailable = true;
  const emails = captureEmails(t, payload => unavailable && payload.to[0] === 'staff@example.com');
  const response = await submit('contact-message', contact, env);
  assert.equal(response.status, 200);
  const saved = env.DB.sqlite.prepare('SELECT auto_reply_status, status FROM contact_messages').get();
  assert.equal(saved.auto_reply_status, 'sent');
  assert.equal(saved.status, 'email_retrying');
  unavailable = false;
  env.DB.sqlite.exec("UPDATE email_delivery_jobs SET next_attempt_at='2000-01-01'");
  await retrySubmissionEmails(env);
  assert.equal(emails.filter(email => email.to[0] === 'visitor@example.com').length, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT status FROM contact_messages').get().status, 'emailed');
});

test('confirmation retry stops at the attempt limit and reports the final failure', async t => {
  const env = environment();
  captureEmails(t, payload => payload.to[0] === 'visitor@example.com');
  await submit('contact-message', contact, env);
  env.DB.sqlite.exec("UPDATE email_delivery_jobs SET attempts=4,next_attempt_at='2000-01-01'");
  await retrySubmissionEmails(env);
  const job = env.DB.sqlite.prepare('SELECT status, attempts FROM email_delivery_jobs').get();
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 5);
  assert.equal(env.DB.sqlite.prepare('SELECT auto_reply_status FROM contact_messages').get().auto_reply_status, 'failed');
});

test('missing retry storage retains the contact and still sends staff notification', async t => {
  const env = environment();
  env.DB.sqlite.exec('DROP TABLE email_delivery_jobs');
  const emails = captureEmails(t, payload => payload.to[0] === 'visitor@example.com');
  const response = await submit('contact-message', contact, env);
  assert.equal(response.status, 200);
  assert.equal(emails.length, 2);
  assert.equal(env.DB.sqlite.prepare('SELECT auto_reply_status FROM contact_messages').get().auto_reply_status, 'failed');
});

test('templates escape visitor content and do not turn requested facilities into HTML', () => {
  const payload = websiteAutoReply({}, { kind: 'facility_rental', name: '<img src=x onerror=alert(1)>',
    rental: { eventGroup: '<script>alert(1)</script>', facilities: ['<b>Hall</b>'] } });
  assert.doesNotMatch(payload.html, /<script>|<img src=x|<b>Hall/);
  assert.match(payload.html, /&lt;script&gt;/);
  assert.match(payload.html, /&lt;b&gt;Hall/);
});

test('preview, invalid, and suppressed newsletter submissions send no confirmation', async t => {
  const env = environment();
  const emails = captureEmails(t);
  assert.equal((await submit('newsletter/subscribe', { firstName: 'Ada', lastName: 'Church', email: 'demo@example.com' },
    { ...env, ENVIRONMENT: 'preview', DEMO_MODE: 'true' })).status, 200);
  assert.equal((await submit('contact-message', { ...contact, email: 'invalid' }, env)).status, 400);
  env.DB.sqlite.prepare("INSERT INTO newsletter_suppressions(email,reason,created_at) VALUES('suppressed@example.com','unsubscribed','2026-10-11')").run();
  assert.equal((await submit('newsletter/subscribe', { firstName: 'Ada', lastName: 'Church', email: 'suppressed@example.com' }, env)).status, 409);
  assert.equal(emails.length, 0);
});
