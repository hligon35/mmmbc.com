import assert from 'node:assert/strict';
import test from 'node:test';
import { honeypotTripped, verifyTurnstile } from './public-forms-security.js';
import worker from './worker-admin-api-wrapper.js';

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

function mockSiteDb() {
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
            run: async () => ({ success: true })
          };
        }
      };
    }
  };
}

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
  assert.equal(response.status, 403);
});
