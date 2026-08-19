import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

function loadWorkerAdminApi() {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'worker-admin-api-wrapper.js'), 'utf8');
  const transformed = source
    .replace(/^import .*;$/gm, '')
    .replace('export default {', 'globalThis.__workerAdminApi = {');

  const authWorker = {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/me') {
        return new Response(JSON.stringify({ user: { email: 'finance-admin@example.com' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
  };

  const context = vm.createContext({
    console,
    URL,
    Request,
    Response,
    Headers,
    crypto,
    worker: authWorker,
    handleGivingRequest: async () => null,
    handleGivingPageRequest: async () => null,
    maybeHandleFinanceReconciliationRequest: async () => null,
    EmailMessage: class EmailMessage {}
  });

  vm.runInContext(transformed, context, { filename: 'worker-admin-api-wrapper.js' });
  return context.__workerAdminApi;
}

function createFinanceEnv() {
  const state = {
    metaJson: null,
    funds: [
      {
        id: 'fund-general',
        fund_name: 'General Fund',
        fund_code: 'GENERAL',
        active: 1,
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z'
      }
    ],
    entries: []
  };

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
      const sql = this.sql;
      if (sql.startsWith('INSERT INTO finance_entries')) {
        const [id, entryDate, type, category, fund, fundId, method, party, memo, amountCents, createdAt, updatedAt] = this.args;
        state.entries.push({
          id,
          entry_date: entryDate,
          type,
          category,
          fund,
          fund_id: fundId,
          method,
          party,
          memo,
          amount_cents: amountCents,
          status: 'posted',
          voided_by: '',
          voided_at: '',
          void_reason: '',
          created_at: createdAt,
          updated_at: updatedAt
        });
      }
      if (sql.startsWith('INSERT INTO finance_meta')) {
        state.metaJson = this.args[1];
      }
      return { success: true };
    }

    async first() {
      const sql = this.sql;
      if (sql.startsWith('SELECT id, fund_name FROM finance_funds WHERE id = ?')) {
        const [fundId] = this.args;
        return state.funds.find((fund) => fund.id === fundId && Number(fund.active) === 1) || null;
      }
      if (sql.startsWith('SELECT value_json FROM finance_meta WHERE key = ?')) {
        return state.metaJson ? { value_json: state.metaJson } : null;
      }
      return null;
    }

    async all() {
      const sql = this.sql;
      if (sql.startsWith('PRAGMA table_info(finance_entries)')) {
        return { results: [
          { name: 'id' },
          { name: 'entry_date' },
          { name: 'type' },
          { name: 'category' },
          { name: 'fund' },
          { name: 'fund_id' },
          { name: 'method' },
          { name: 'party' },
          { name: 'memo' },
          { name: 'amount_cents' },
          { name: 'status' },
          { name: 'voided_by' },
          { name: 'voided_at' },
          { name: 'void_reason' },
          { name: 'created_at' },
          { name: 'updated_at' }
        ] };
      }
      if (sql.startsWith('SELECT id, fund_name, fund_code, active, created_at, updated_at FROM finance_funds')) {
        return { results: state.funds };
      }
      if (sql.includes('FROM finance_entries') && sql.includes('ORDER BY entry_date DESC')) {
        return { results: [...state.entries] };
      }
      if (sql.includes('SELECT DISTINCT category')) {
        return {
          results: Array.from(new Set(state.entries.map((entry) => entry.category))).filter(Boolean).map((category) => ({ category }))
        };
      }
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
    state
  };
}

test('finance entry POST inserts into D1-compatible storage and GET returns the same entry for Review Transactions', async () => {
  const api = loadWorkerAdminApi();
  const { env, state } = createFinanceEnv();

  const postResponse = await api.fetch(new Request('https://example.test/api/finances/entries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date: '2026-08-18',
      type: 'income',
      category: 'Offering',
      fundId: 'fund-general',
      method: 'Cash',
      party: 'Jordan Brooks',
      memo: 'Sunday worship giving',
      amount: 15
    })
  }), env, { waitUntil() {} });

  assert.equal(postResponse.status, 200);
  const postPayload = await postResponse.json();
  assert.equal(postPayload.ok, true);
  assert.ok(postPayload.entryId);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].id, postPayload.entryId);
  assert.equal(state.entries[0].entry_date, '2026-08-18');
  assert.equal(postPayload.data.entries.some((entry) => entry.id === postPayload.entryId), true);

  const getResponse = await api.fetch(new Request('https://example.test/api/finances', {
    method: 'GET'
  }), env, { waitUntil() {} });
  assert.equal(getResponse.status, 200);
  const getPayload = await getResponse.json();
  assert.equal(Array.isArray(getPayload.entries), true);
  const roundTripEntry = getPayload.entries.find((entry) => entry.id === postPayload.entryId);
  assert.ok(roundTripEntry);
  assert.equal(roundTripEntry.date, '2026-08-18');
  assert.equal(roundTripEntry.amountCents, 1500);

  const adminJs = fs.readFileSync(path.join(process.cwd(), 'admin', 'public', 'admin.js'), 'utf8');
  assert.match(adminJs, /const all = Array\.isArray\(finances\?\.entries\) \? finances\.entries : \[\];/);
});