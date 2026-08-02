import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __directoryTestHooks,
  handleDirectoryContactCreate,
  handleDirectoryContactUpdate
} from './worker-directory.js';

function createMockEnv(resolver) {
  const runLog = [];

  class Statement {
    constructor(sql) {
      this.sql = sql;
      this.args = [];
    }

    bind(...args) {
      this.args = args;
      return this;
    }

    async run() {
      runLog.push({ sql: this.sql, args: this.args });
      return resolver({ sql: this.sql, args: this.args, kind: 'run' }) ?? { success: true };
    }

    async first() {
      return resolver({ sql: this.sql, args: this.args, kind: 'first' }) ?? null;
    }

    async all() {
      const result = resolver({ sql: this.sql, args: this.args, kind: 'all' });
      if (result && typeof result === 'object' && Array.isArray(result.results)) return result;
      if (Array.isArray(result)) return { results: result };
      return { results: [] };
    }
  }

  return {
    env: {
      DB: {
        prepare(sql) {
          return new Statement(sql);
        }
      }
    },
    runLog
  };
}

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

test('account number normalization preserves MM prefix and strips punctuation', () => {
  assert.equal(__directoryTestHooks.normalizeAccountNumber('mm 1234-5678'), 'MM-12345678');
  assert.equal(__directoryTestHooks.normalizeAccountNumber('1234 567890'), 'MM-1234567890');
});

test('generated account numbers use the non-PII MM format', () => {
  const value = __directoryTestHooks.buildDirectoryAccountNumberSeed();
  assert.match(value, /^MM-[A-F0-9]{10}$/);
});

test('manual imported account number is preserved on contact create', async () => {
  const { env, runLog } = createMockEnv(({ sql, args, kind }) => {
    if (sql.includes('WHERE account_number = ?') && kind === 'first') return null;
    if (sql.includes('SELECT * FROM finance_donors') && kind === 'first') return null;
    if (sql.includes('SELECT * FROM finance_donors') && kind === 'all') return { results: [] };
    return null;
  });

  const req = new Request('https://example.test/api/directory/contacts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Ada',
      lastName: 'Brown',
      contactType: 'member',
      status: 'active',
      accountNumber: 'MM-99887766',
      primaryEmail: 'ada@example.com'
    })
  });

  const res = await handleDirectoryContactCreate(req, env, { email: 'admin@example.com', permissions: { canManageContacts: true } });
  assert.equal(res.status, 201);
  const insert = runLog.find((entry) => entry.sql.includes('INSERT INTO directory_contacts'));
  assert.ok(insert);
  assert.equal(insert.args[9], 'MM-99887766');
});

test('duplicate account number rejection returns a clear conflict', async () => {
  const { env } = createMockEnv(({ sql, kind }) => {
    if (sql.includes('WHERE account_number = ?') && kind === 'first') return { id: 'dup-contact' };
    return null;
  });

  const req = new Request('https://example.test/api/directory/contacts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Ada',
      lastName: 'Brown',
      contactType: 'member',
      status: 'active',
      accountNumber: 'MM-11112222'
    })
  });

  const res = await handleDirectoryContactCreate(req, env, { email: 'admin@example.com', permissions: { canManageContacts: true } });
  assert.equal(res.status, 500);
  const payload = await responseJson(res);
  assert.equal(payload.error, 'Unable to save contact.');
});

test('contact update synchronizes a linked finance donor account number', async () => {
  const { env, runLog } = createMockEnv(({ sql, kind }) => {
    if (sql.includes('SELECT id, created_at FROM directory_contacts')) return { id: 'contact-1', created_at: '2026-08-01T00:00:00.000Z' };
    if (sql.includes('WHERE account_number = ?') && kind === 'first') return null;
    if (sql.includes('SELECT * FROM finance_donors WHERE directory_contact_id')) {
      return { id: 'donor-1', directory_contact_id: 'contact-1', created_at: '2026-08-01T00:00:00.000Z' };
    }
    return null;
  });

  const req = new Request('https://example.test/api/directory/contacts/contact-1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Ada',
      lastName: 'Brown',
      contactType: 'member',
      status: 'active',
      accountNumber: 'MM-12345678',
      primaryEmail: 'ada@example.com'
    })
  });

  const res = await handleDirectoryContactUpdate(req, env, { email: 'admin@example.com', permissions: { canManageContacts: true } }, 'contact-1');
  assert.equal(res.status, 200);
  assert.equal(runLog.some((entry) => entry.sql.includes('UPDATE finance_donors')), true);
});