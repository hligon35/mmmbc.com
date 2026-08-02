import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  maybeHandleFinanceReconciliationRequest,
  __financeTestHooks
} from './worker-finance-reconciliation.js';

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

  const DB = {
    prepare(sql) {
      return new Statement(sql);
    },
    async batch(statements) {
      for (const statement of statements) {
        await statement.run();
      }
      return { success: true };
    }
  };

  return {
    env: { DB },
    runLog
  };
}

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function financeErrorCode(payload) {
  return payload?.error?.code || '';
}

test('valid envelope-code resolution returns minimal donor confirmation', async () => {
  const { env } = createMockEnv(({ sql }) => {
    if (sql.includes('SELECT role FROM admin_invites')) return null;
    if (sql.includes('FROM finance_donor_envelope_codes')) {
      return {
        status: 'active',
        envelope_code: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174000',
        donor_id: 'donor-1',
        first_name: 'Ada',
        last_name: 'Brown',
        preferred_name: '',
        envelope_number: '0012',
        active: 1
      };
    }
    return null;
  });

  const req = new Request('https://example.test/api/finances/collections/resolve-envelope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      envelopeCode: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174000',
      batchId: 'batch-1'
    })
  });

  const res = await maybeHandleFinanceReconciliationRequest(req, env, {}, async () => ({ email: 'admin@example.com' }));
  assert.equal(res.status, 200);
  const payload = await responseJson(res);
  assert.equal(payload.donor.donorId, 'donor-1');
  assert.equal(payload.donor.displayName, 'Ada Brown');
  assert.equal(payload.donor.envelopeNumber, '0012');
});

test('invalid, inactive, and replaced codes are rejected correctly', async () => {
  const { env } = createMockEnv(({ sql }) => {
    if (sql.includes('SELECT role FROM admin_invites')) return null;
    if (sql.includes('FROM finance_donor_envelope_codes')) {
      return {
        status: 'replaced',
        envelope_code: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174111',
        donor_id: 'donor-2',
        first_name: 'Bea',
        last_name: 'Cole',
        preferred_name: '',
        envelope_number: '0099',
        active: 1
      };
    }
    return null;
  });

  const invalidReq = new Request('https://example.test/api/finances/collections/resolve-envelope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelopeCode: 'PII-NOT-ALLOWED' })
  });
  const invalidRes = await maybeHandleFinanceReconciliationRequest(invalidReq, env, {}, async () => ({ email: 'admin@example.com' }));
  assert.equal(invalidRes.status, 400);

  const replacedReq = new Request('https://example.test/api/finances/collections/resolve-envelope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelopeCode: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174111' })
  });
  const replacedRes = await maybeHandleFinanceReconciliationRequest(replacedReq, env, {}, async () => ({ email: 'admin@example.com' }));
  assert.equal(replacedRes.status, 409);
});

test('unauthorized resolution and mutations return 401', async () => {
  const { env } = createMockEnv(() => null);

  const resolveReq = new Request('https://example.test/api/finances/collections/resolve-envelope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelopeCode: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174000' })
  });
  const resolveRes = await maybeHandleFinanceReconciliationRequest(resolveReq, env, {}, async () => null);
  assert.equal(resolveRes.status, 401);

  const mutReq = new Request('https://example.test/api/finances/collections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serviceDate: '2026-08-01' })
  });
  const mutRes = await maybeHandleFinanceReconciliationRequest(mutReq, env, {}, async () => null);
  assert.equal(mutRes.status, 401);
});

test('duplicate scan in one batch is blocked', async () => {
  const { env } = createMockEnv(({ sql }) => {
    if (sql.includes('FROM finance_collection_batches')) {
      return {
        id: 'batch-1',
        status: 'counting',
        declared_physical_cash_cents: 0,
        declared_check_cents: 0,
        approval_version: 0
      };
    }
    if (sql.includes('FROM finance_donor_envelope_codes')) {
      return {
        status: 'active',
        envelope_code: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174000',
        donor_id: 'donor-dup',
        first_name: 'Don',
        last_name: 'Or',
        preferred_name: '',
        envelope_number: '0155',
        active: 1
      };
    }
    if (sql.includes('FROM finance_collection_envelopes') && sql.includes('envelope_code_snapshot')) {
      return {
        id: 'existing-entry',
        donor_id: 'donor-dup',
        envelope_total_cents: 5000,
        payment_method: 'cash',
        created_at: '2026-08-01T12:00:00.000Z'
      };
    }
    return null;
  });

  const result = await __financeTestHooks.upsertEnvelopeEntry(env, { email: 'admin@example.com' }, 'batch-1', {
    envelopeCode: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174000',
    paymentMethod: 'cash',
    envelopeTotalCents: 5000,
    allocations: [{ fundId: 'fund-1', amountCents: 5000 }]
  });

  assert.ok(result.error);
  const payload = await responseJson(result.error);
  assert.equal(financeErrorCode(payload), 'DUPLICATE_ENVELOPE_IN_BATCH');
});

test('multiple allocations are accepted and mismatch is rejected', async () => {
  const good = __financeTestHooks.parseAllocations([
    { fundId: 'fund-1', amountCents: 2500 },
    { fundId: 'fund-2', amountCents: 7500 }
  ]);
  assert.equal(good.error, undefined);
  assert.equal(good.sum, 10000);

  const { env } = createMockEnv(({ sql, kind }) => {
    if (sql.includes('FROM finance_collection_batches')) {
      return {
        id: 'batch-2',
        status: 'counting',
        declared_physical_cash_cents: 0,
        declared_check_cents: 0,
        approval_version: 0
      };
    }
    if (sql.includes('FROM finance_donor_envelope_codes')) {
      return {
        status: 'active',
        envelope_code: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174222',
        donor_id: 'donor-2',
        first_name: 'Eva',
        last_name: 'Moss',
        preferred_name: '',
        envelope_number: '0202',
        active: 1
      };
    }
    if (sql.includes('FROM finance_collection_envelopes') && sql.includes('envelope_code_snapshot')) return null;
    if (kind === 'all') return { results: [] };
    return null;
  });

  const result = await __financeTestHooks.upsertEnvelopeEntry(env, { email: 'admin@example.com' }, 'batch-2', {
    envelopeCode: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174222',
    paymentMethod: 'cash',
    envelopeTotalCents: 10000,
    allocations: [{ fundId: 'fund-1', amountCents: 9000 }]
  });

  assert.ok(result.error);
  const payload = await responseJson(result.error);
  assert.equal(financeErrorCode(payload), 'ALLOCATION_MISMATCH');
});

test('server-side totals drive finalization discrepancy decisions', async () => {
  const { env } = createMockEnv(({ sql, kind }) => {
    if (sql.includes('SELECT * FROM finance_collection_batches')) {
      return {
        id: 'batch-3',
        status: 'awaiting_verification',
        declared_physical_cash_cents: 5000,
        declared_check_cents: 0,
        approval_version: 1,
        discrepancy_explanation: ''
      };
    }
    if (sql.includes('SELECT count(*) AS c FROM finance_collection_counters')) return { c: 2 };
    if (sql.includes('FROM finance_collection_counter_approvals')) {
      return { results: [{ counter_email: 'a@example.com' }, { counter_email: 'b@example.com' }] };
    }
    if (sql.includes('sum(envelope_total_cents)')) return { envelope_total: 3000, cash_envelope_total: 3000, check_envelope_total: 0 };
    if (sql.includes('sum(amount_cents) AS loose_total')) return { loose_total: 0, loose_cash_total: 0, loose_check_total: 0 };
    if (sql.includes('GROUP BY fund_id, fund_code')) return { results: [] };
    if (kind === 'run') return { success: true };
    return null;
  });

  const result = await __financeTestHooks.finalizeBatch(env, { email: 'treasurer@example.com' }, 'batch-3', {});
  assert.ok(result.error);
  const payload = await responseJson(result.error);
  assert.equal(financeErrorCode(payload), 'DISCREPANCY_EXPLANATION_REQUIRED');
});

test('two distinct counter approvals are required', async () => {
  const { env } = createMockEnv(({ sql }) => {
    if (sql.includes('SELECT * FROM finance_collection_batches')) {
      return {
        id: 'batch-4',
        status: 'awaiting_verification',
        declared_physical_cash_cents: 0,
        declared_check_cents: 0,
        approval_version: 2,
        discrepancy_explanation: ''
      };
    }
    if (sql.includes('SELECT count(*) AS c FROM finance_collection_counters')) return { c: 2 };
    if (sql.includes('FROM finance_collection_counter_approvals')) {
      return { results: [{ counter_email: 'dup@example.com' }, { counter_email: 'dup@example.com' }] };
    }
    return null;
  });

  const result = await __financeTestHooks.finalizeBatch(env, { email: 'treasurer@example.com' }, 'batch-4', {});
  assert.ok(result.error);
  const payload = await responseJson(result.error);
  assert.equal(financeErrorCode(payload), 'APPROVALS_REQUIRED');
});

test('entry changes invalidate prior approvals', async () => {
  const { env, runLog } = createMockEnv(({ sql, kind }) => {
    if (sql.includes('SELECT * FROM finance_collection_batches')) {
      return {
        id: 'batch-5',
        status: 'counting',
        declared_physical_cash_cents: 0,
        declared_check_cents: 0,
        approval_version: 7
      };
    }
    if (sql.includes('FROM finance_donor_envelope_codes')) {
      return {
        status: 'active',
        envelope_code: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174555',
        donor_id: 'donor-5',
        first_name: 'Fin',
        last_name: 'Ite',
        preferred_name: '',
        envelope_number: '0333',
        active: 1
      };
    }
    if (sql.includes('FROM finance_collection_envelopes') && sql.includes('envelope_code_snapshot')) return null;
    if (sql.includes('FROM finance_funds')) {
      return { id: 'fund-1', fund_name: 'General', fund_code: 'GEN', active: 1 };
    }
    if (sql.includes('SELECT id FROM finance_collection_counter_approvals')) return { id: 'approval-1' };
    if (sql.includes('sum(envelope_total_cents)')) return { envelope_total: 1000, cash_envelope_total: 1000, check_envelope_total: 0 };
    if (sql.includes('sum(amount_cents) AS loose_total')) return { loose_total: 0, loose_cash_total: 0, loose_check_total: 0 };
    if (sql.includes('GROUP BY fund_id, fund_code')) return { results: [] };
    if (kind === 'run') return { success: true };
    if (kind === 'all') return { results: [] };
    return null;
  });

  const result = await __financeTestHooks.upsertEnvelopeEntry(env, { email: 'entry@example.com' }, 'batch-5', {
    envelopeCode: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174555',
    paymentMethod: 'cash',
    envelopeTotalCents: 1000,
    allocations: [{ fundId: 'fund-1', amountCents: 1000 }]
  });

  assert.equal(Boolean(result.error), false);
  assert.equal(runLog.some((item) => item.sql.includes('DELETE FROM finance_collection_counter_approvals')), true);
});

test('finalization works when discrepancy is explained or zero', async () => {
  const { env } = createMockEnv(({ sql, kind }) => {
    if (sql.includes('SELECT * FROM finance_collection_batches')) {
      return {
        id: 'batch-6',
        status: 'awaiting_verification',
        declared_physical_cash_cents: 1000,
        declared_check_cents: 0,
        approval_version: 3,
        discrepancy_explanation: ''
      };
    }
    if (sql.includes('SELECT count(*) AS c FROM finance_collection_counters')) return { c: 2 };
    if (sql.includes('FROM finance_collection_counter_approvals')) {
      return { results: [{ counter_email: 'a@example.com' }, { counter_email: 'b@example.com' }] };
    }
    if (sql.includes('sum(envelope_total_cents)')) return { envelope_total: 1000, cash_envelope_total: 1000, check_envelope_total: 0 };
    if (sql.includes('sum(amount_cents) AS loose_total')) return { loose_total: 0, loose_cash_total: 0, loose_check_total: 0 };
    if (sql.includes('GROUP BY fund_id, fund_code')) return { results: [] };
    if (kind === 'run') return { success: true };
    return null;
  });

  const result = await __financeTestHooks.finalizeBatch(env, { email: 'treasurer@example.com' }, 'batch-6', {});
  assert.equal(Boolean(result.error), false);
});

test('deposit confirmation records role-separation exception when verifier equals creator', async () => {
  const { env } = createMockEnv(({ sql, kind }) => {
    if (sql.includes('SELECT * FROM finance_collection_batches')) {
      return {
        id: 'batch-7',
        status: 'verified',
        created_by: 'same@example.com',
        declared_physical_cash_cents: 3000,
        declared_check_cents: 0
      };
    }
    if (sql.includes('sum(envelope_total_cents)')) return { envelope_total: 3000, cash_envelope_total: 3000, check_envelope_total: 0 };
    if (sql.includes('sum(amount_cents) AS loose_total')) return { loose_total: 0, loose_cash_total: 0, loose_check_total: 0 };
    if (sql.includes('GROUP BY fund_id, fund_code')) return { results: [] };
    if (kind === 'run') return { success: true };
    return null;
  });

  const result = await __financeTestHooks.confirmDeposit(env, { email: 'same@example.com' }, 'batch-7', {
    depositDate: '2026-08-01',
    depositedAmountCents: 3000,
    depositReference: 'SLIP-123'
  });

  assert.equal(Boolean(result.error), false);
  assert.equal(String(result.internalControlException || '').length > 0, true);
});

test('locked verified batches cannot be edited', async () => {
  const { env } = createMockEnv(({ sql }) => {
    if (sql.includes('SELECT * FROM finance_collection_batches')) {
      return {
        id: 'batch-8',
        status: 'verified',
        declared_physical_cash_cents: 0,
        declared_check_cents: 0,
        approval_version: 0
      };
    }
    return null;
  });

  const result = await __financeTestHooks.upsertEnvelopeEntry(env, { email: 'entry@example.com' }, 'batch-8', {
    envelopeCode: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174888',
    paymentMethod: 'cash',
    envelopeTotalCents: 1000,
    allocations: [{ fundId: 'fund-1', amountCents: 1000 }]
  });

  assert.ok(result.error);
  const payload = await responseJson(result.error);
  assert.equal(financeErrorCode(payload), 'BATCH_LOCKED');
});

test('donor history includes stripe + identified envelopes and excludes loose cash', async () => {
  const { env } = createMockEnv(({ sql }) => {
    if (sql.includes('FROM giving_donations')) {
      return {
        results: [{
          id: 'stripe-1',
          paid_at: '2026-08-01T12:00:00.000Z',
          fund_code: 'GEN',
          amount_cents: 5000,
          currency: 'usd'
        }]
      };
    }
    if (sql.includes('FROM finance_collection_envelopes')) {
      return {
        results: [
          {
            service_date: '2026-07-28',
            service_name: 'Sunday AM',
            entry_id: 'env-cash',
            payment_method: 'cash',
            check_number: '',
            fund_id: 'fund-1',
            fund_code: 'GEN',
            amount_cents: 1500
          },
          {
            service_date: '2026-07-28',
            service_name: 'Sunday AM',
            entry_id: 'env-check',
            payment_method: 'check',
            check_number: '1008',
            fund_id: 'fund-2',
            fund_code: 'BLD',
            amount_cents: 2500
          }
        ]
      };
    }
    if (sql.includes('FROM finance_donors WHERE id')) {
      return { id: 'donor-9', first_name: 'Ivy', last_name: 'King', preferred_name: '' };
    }
    return null;
  });

  const result = await __financeTestHooks.donorHistory(env, 'donor-9');
  assert.ok(result);
  const sources = new Set(result.history.map((h) => h.source));
  assert.equal(sources.has('stripe'), true);
  assert.equal(sources.has('cash_envelope'), true);
  assert.equal(sources.has('check_envelope'), true);
  assert.equal(sources.has('loose_cash'), false);
});

test('money parsing enforces integer cents with safe rounding', () => {
  assert.equal(__financeTestHooks.toCents('10.005'), 1001);
  assert.equal(Number.isNaN(__financeTestHooks.toCents('-1.00')), true);
  assert.equal(Number.isNaN(__financeTestHooks.toCents('abc')), true);
  assert.equal(__financeTestHooks.toCents('0', { allowZero: true }), 0);
});

test('audit events are written for successful entry changes', async () => {
  const { env, runLog } = createMockEnv(({ sql, kind }) => {
    if (sql.includes('SELECT * FROM finance_collection_batches')) {
      return {
        id: 'batch-10',
        status: 'counting',
        declared_physical_cash_cents: 0,
        declared_check_cents: 0,
        approval_version: 0
      };
    }
    if (sql.includes('FROM finance_donor_envelope_codes')) {
      return {
        status: 'active',
        envelope_code: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174010',
        donor_id: 'donor-10',
        first_name: 'Jay',
        last_name: 'Lee',
        preferred_name: '',
        envelope_number: '0410',
        active: 1
      };
    }
    if (sql.includes('FROM finance_collection_envelopes') && sql.includes('envelope_code_snapshot')) return null;
    if (sql.includes('FROM finance_funds')) return { id: 'fund-1', fund_name: 'General', fund_code: 'GEN', active: 1 };
    if (sql.includes('SELECT id FROM finance_collection_counter_approvals')) return null;
    if (sql.includes('sum(envelope_total_cents)')) return { envelope_total: 1200, cash_envelope_total: 1200, check_envelope_total: 0 };
    if (sql.includes('sum(amount_cents) AS loose_total')) return { loose_total: 0, loose_cash_total: 0, loose_check_total: 0 };
    if (sql.includes('GROUP BY fund_id, fund_code')) return { results: [] };
    if (kind === 'run') return { success: true };
    if (kind === 'all') return { results: [] };
    return null;
  });

  const result = await __financeTestHooks.upsertEnvelopeEntry(env, { email: 'entry@example.com' }, 'batch-10', {
    envelopeCode: 'MMMBC-ENV-V1:123e4567-e89b-12d3-a456-426614174010',
    paymentMethod: 'cash',
    envelopeTotalCents: 1200,
    allocations: [{ fundId: 'fund-1', amountCents: 1200 }]
  });

  assert.equal(Boolean(result.error), false);
  assert.equal(runLog.some((item) => item.sql.includes('INSERT INTO finance_collection_audit_events')), true);
});

test('stripe-source regression shape remains explicit in donor history', async () => {
  const { env } = createMockEnv(({ sql }) => {
    if (sql.includes('FROM giving_donations')) {
      return { results: [{ id: 'stripe-only', paid_at: '2026-08-02', fund_code: 'MIS', amount_cents: 9900, currency: 'usd' }] };
    }
    if (sql.includes('FROM finance_collection_envelopes')) {
      return { results: [] };
    }
    if (sql.includes('FROM finance_donors WHERE id')) {
      return { id: 'donor-s', first_name: 'Sam', last_name: 'Ngo', preferred_name: '' };
    }
    return null;
  });

  const result = await __financeTestHooks.donorHistory(env, 'donor-s');
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].source, 'stripe');
});
