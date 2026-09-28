import assert from 'node:assert/strict';
import test from 'node:test';
import { honeypotTripped, verifyTurnstile } from './public-forms-security.js';
import worker from './worker-admin-api-wrapper.js';

test('production forms fail closed when Turnstile is not configured', async () => {
  const result = await verifyTurnstile({ ENVIRONMENT: 'production' }, '', '127.0.0.1');
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.error, /temporarily unavailable/i);
  const incomplete = await verifyTurnstile({ ENVIRONMENT: 'production', TURNSTILE_SECRET_KEY: 'configured' }, '', '127.0.0.1');
  assert.equal(incomplete.status, 503);
});

test('local forms may run without Turnstile configuration', async () => {
  const result = await verifyTurnstile({ ENVIRONMENT: 'development' }, '', '127.0.0.1');
  assert.deepEqual(result, { ok: true, skipped: true });
});

test('Turnstile failures distinguish a bad secret from a used token without logging credentials', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  let code = 'invalid-input-secret';
  globalThis.fetch = async () => Response.json({ success: false, 'error-codes': [code] });
  console.warn = (...args) => warnings.push(args);
  try {
    const env = { ENVIRONMENT: 'production', TURNSTILE_SITE_KEY: 'public-key', TURNSTILE_SECRET_KEY: 'private-secret' };
    const badSecret = await verifyTurnstile(env, 'visitor-token', '127.0.0.1');
    assert.equal(badSecret.status, 503);
    assert.match(badSecret.error, /temporarily unavailable/i);
    code = 'timeout-or-duplicate';
    const expired = await verifyTurnstile(env, 'visitor-token', '127.0.0.1');
    assert.equal(expired.status, 403);
    assert.match(expired.error, /expired|already used/i);
    assert.doesNotMatch(JSON.stringify(warnings), /private-secret|visitor-token|127\.0\.0\.1/);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('production rejects a valid Turnstile token from a different hostname', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, hostname: 'another-site.example' });
  try {
    const result = await verifyTurnstile({
      ENVIRONMENT: 'production', PUBLIC_SITE_URL: 'https://mmmbc.alphazonelabs.com',
      TURNSTILE_SITE_KEY: 'public-key', TURNSTILE_SECRET_KEY: 'private-key'
    }, 'visitor-token', '127.0.0.1');
    assert.equal(result.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('honeypot rejects filled bot fields', () => {
  assert.equal(honeypotTripped({ website: 'spam' }), true);
  assert.equal(honeypotTripped({ website: '' }), false);
});

function mockSiteDb({ oldSchema = false } = {}) {
  const calls = [];
  const binds = [];
  return {
    calls,
    binds,
    prepare(sql) {
      calls.push(sql);
      return {
        bind(...args) {
          binds.push({ sql, args });
          return {
            all: async () => ({ results: [] }),
            run: async () => {
              if (oldSchema && /INSERT INTO (contact_messages|facility_rental_requests)/.test(sql) && /first_name/.test(sql)) {
                throw new Error('table has no column named first_name: SQLITE_ERROR');
              }
              if (oldSchema && /UPDATE (contact_messages|facility_rental_requests)/.test(sql) && /auto_reply_status/.test(sql)) {
                throw new Error('no such column: auto_reply_status');
              }
              return { success: true };
            }
          };
        }
      };
    }
  };
}

test('contact and rental forms save on the original site schema', async () => {
  const db = mockSiteDb({ oldSchema: true });
  const env = { ENVIRONMENT: 'preview', DEMO_MODE: 'true', SITE_DB: db };
  const contact = await worker.fetch(new Request('https://preview.example/api/public/contact-message', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ firstName: 'Ada', lastName: 'Church', email: 'ada@example.com', message: 'Please call me.' })
  }), env, {});
  const rental = await worker.fetch(new Request('https://preview.example/api/public/facility-rental-request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audience: 'member', form: {
      eventGroup: 'Choir', firstName: 'Ada', lastName: 'Church', phone: '(270) 555-0100', purpose: 'Meeting', contactEmail: 'ada@example.com',
      dateOfUse: '2026-10-10', timeFrom: '10:00', timeTo: '12:00', facilities: ['Hall'],
      responsibleSignature: 'Ada Church', responsibleSignatureDate: '2026-09-27'
    } })
  }), env, {});
  assert.equal(contact.status, 200);
  assert.equal(rental.status, 200);
  assert.ok(db.calls.some((sql) => /INSERT INTO contact_messages \(id, name, email/.test(sql)));
  assert.ok(db.calls.some((sql) => /INSERT INTO facility_rental_requests\s+\(id, audience, person_responsible, phone/.test(sql)));
});

test('production contact submission completes after Turnstile on an older site database', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/siteverify')) return Response.json({ success: true, hostname: 'mmmbc.alphazonelabs.com' });
    throw new Error('Unexpected external request');
  };
  try {
    const db = mockSiteDb({ oldSchema: true });
    const response = await worker.fetch(new Request('https://mmmbc.alphazonelabs.com/api/public/contact-message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firstName: 'Ada', lastName: 'Church', email: 'ada@example.com', message: 'Please call me.', turnstileToken: 'sample-token' })
    }), {
      ENVIRONMENT: 'production', SITE_DB: db, PUBLIC_SITE_URL: 'https://mmmbc.alphazonelabs.com',
      TURNSTILE_SITE_KEY: 'public-key', TURNSTILE_SECRET_KEY: 'private-key'
    }, {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.ok(db.calls.some((sql) => /INSERT INTO contact_messages \(id, name, email/.test(sql)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('contact form reports a failed auto-reply while keeping the saved submission', async () => {
  const originalFetch = globalThis.fetch;
  const db = mockSiteDb();
  const recipients = [];
  globalThis.fetch = async (_url, options) => {
    const [recipient] = JSON.parse(options.body).to;
    recipients.push(recipient);
    return recipient === 'visitor@example.com'
      ? Response.json({ message: 'Sending domain is not verified.' }, { status: 403 })
      : Response.json({ id: 'email-123' });
  };
  try {
    const response = await worker.fetch(new Request('https://preview.example/api/public/contact-message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firstName: 'Ada', lastName: 'Church', email: 'visitor@example.com', message: 'Please call me.' })
    }), { ENVIRONMENT: 'development', SITE_DB: db, RESEND_API_KEY: 'test-key', RESEND_FROM_EMAIL: 'no-reply@mmmbc.com', SUPPORT_TO_EMAIL: 'team@example.com' }, {});
    assert.equal(response.status, 200);
    assert.match((await response.json()).warning, /confirmation email could not be sent/i);
    assert.deepEqual(recipients, ['visitor@example.com', 'team@example.com']);
    const recordedFailure = db.binds.find(({ sql }) => /UPDATE contact_messages SET auto_reply_status/.test(sql));
    assert.equal(recordedFailure.args[0], 'failed');
    assert.match(recordedFailure.args[2], /not verified/);
    assert.ok(db.calls.some((sql) => /INSERT INTO contact_messages/.test(sql)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('newsletter signup stores first and last name with its email', async () => {
  const db = mockSiteDb();
  const env = { ENVIRONMENT: 'preview', DEMO_MODE: 'true', SITE_DB: db };
  const response = await worker.fetch(new Request('https://preview.example/api/public/newsletter/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ firstName: 'Ada', lastName: 'Church', email: 'ada@example.com' })
  }), env, {});
  assert.equal(response.status, 200);
  assert.equal(db.binds.find(({ sql }) => /INSERT INTO subscribers/.test(sql)).args[2], 'Ada Church');
  const missingName = await worker.fetch(new Request('https://preview.example/api/public/newsletter/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ firstName: 'Ada', email: 'ada@example.com' })
  }), env, {});
  assert.equal(missingName.status, 400);
});

test('contact save failures return JSON rather than a Worker exception', async () => {
  const db = mockSiteDb();
  db.prepare = () => { throw new Error('D1 temporarily unavailable'); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await worker.fetch(new Request('https://preview.example/api/public/contact-message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada Church', email: 'ada@example.com', message: 'Please call me.' })
    }), { ENVIRONMENT: 'preview', DEMO_MODE: 'true', SITE_DB: db }, {});
    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type'), /application\/json/);
  } finally {
    console.error = originalError;
  }
});

test('preview demo mode stores public submissions without invoking email or anti-abuse checks', async () => {
  const db = mockSiteDb();
  const env = { ENVIRONMENT: 'preview', DEMO_MODE: 'true', SITE_DB: db };
  const contact = await worker.fetch(new Request('https://preview.example/api/public/contact-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Demo Contact', email: 'demo-contact@example.com', message: 'Synthetic message.' })
  }), env, {});
  const rental = await worker.fetch(new Request('https://preview.example/api/public/facility-rental-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audience: 'member', form: { eventGroup: 'Demo Event', firstName: 'Demo', lastName: 'Renter', personResponsible: 'Demo Renter', phone: '(270) 555-0100', purpose: 'Synthetic rental', dateOfUse: '2026-10-10', timeFrom: '10:00', timeTo: '12:00', contactEmail: 'demo-renter@example.com', facilities: ['Fellowship Hall'], responsibleSignature: 'Demo Renter', responsibleSignatureDate: '2026-09-27' } })
  }), env, {});
  assert.equal(contact.status, 200);
  assert.equal((await contact.json()).demo, true);
  assert.equal(rental.status, 200);
  assert.equal((await rental.json()).demo, true);
  assert.ok(db.calls.some((sql) => /UPDATE contact_messages/.test(sql)));
  assert.ok(db.calls.some((sql) => /UPDATE facility_rental_requests/.test(sql)));
  const contactInsert = db.binds.find(({ sql }) => /INSERT INTO contact_messages/.test(sql));
  assert.equal(contactInsert.args[2], 'Demo');
  assert.equal(contactInsert.args[3], 'Contact');
  assert.equal(contactInsert.args[5], '');
  const rentalInsert = db.binds.find(({ sql }) => /INSERT INTO facility_rental_requests/.test(sql));
  assert.equal(rentalInsert.args[2], 'Demo Renter');
  assert.equal(rentalInsert.args[5], '(270) 555-0100');
});

test('public form endpoints reject malformed contact details before persistence', async () => {
  const db = mockSiteDb();
  const env = { ENVIRONMENT: 'preview', DEMO_MODE: 'true', SITE_DB: db };
  const response = await worker.fetch(new Request('https://preview.example/api/public/contact-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ firstName: 'Demo', lastName: 'Contact', email: 'demo@example.com', phone: 'not-a-phone', message: 'Synthetic message.' })
  }), env, {});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /phone/i);
  assert.equal(db.calls.filter((sql) => /INSERT INTO contact_messages/.test(sql)).length, 0);
});

test('the demo flag cannot disable production form verification', async () => {
  const response = await worker.fetch(new Request('https://production.example/api/public/contact-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Demo Contact', email: 'demo-contact@example.com', message: 'Synthetic message.' })
  }), { ENVIRONMENT: 'production', DEMO_MODE: 'true', SITE_DB: mockSiteDb() }, {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /temporarily unavailable/i);
});

test('public settings disclose unavailable verification without exposing its secret', async () => {
  const response = await worker.fetch(new Request('https://production.example/api/public/site-settings'), {
    ENVIRONMENT: 'production',
    TURNSTILE_SITE_KEY: 'public-widget-key',
    SUPPORT_TO_EMAIL: 'church@example.com'
  }, {});
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.equal(settings.formVerificationUnavailable, true);
  assert.equal(settings.turnstileSiteKey, undefined);

  const configured = await worker.fetch(new Request('https://production.example/api/public/site-settings'), {
    ENVIRONMENT: 'production',
    TURNSTILE_SITE_KEY: 'public-widget-key',
    TURNSTILE_SECRET_KEY: 'private-widget-secret'
  }, {});
  const readySettings = await configured.json();
  assert.equal(readySettings.formVerificationUnavailable, false);
  assert.equal(readySettings.verificationRequired, true);
  assert.equal(readySettings.turnstileSiteKey, 'public-widget-key');
  assert.equal(JSON.stringify(readySettings).includes('private-widget-secret'), false);
});
