import QRCode from 'qrcode';

const BATCH_STATUSES = new Set(['draft', 'counting', 'awaiting_verification', 'verified', 'deposited', 'voided']);
const CODE_STATUSES = new Set(['active', 'replaced', 'inactive']);
const PAYMENT_METHODS = new Set(['cash', 'check']);
const MAX_AMOUNT_CENTS = 500_000_000;
const ENVELOPE_CODE_PREFIX = 'MMMBC-ENV-V1:';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function normalizeText(value, max = 240) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeEmail(value) {
  const email = normalizeText(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const t = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(t) ? raw : '';
}

function toIsoDate(value) {
  const date = normalizeDate(value);
  if (!date) return '';
  return new Date(`${date}T00:00:00Z`).toISOString();
}

function normalizeCode(value) {
  const code = normalizeText(value, 120);
  if (!code) return '';
  const upper = code.toUpperCase();
  if (!upper.startsWith(ENVELOPE_CODE_PREFIX)) return '';
  const suffix = upper.slice(ENVELOPE_CODE_PREFIX.length);
  if (!/^[0-9A-F-]{36}$/.test(suffix)) return '';
  return `${ENVELOPE_CODE_PREFIX}${suffix.toLowerCase()}`;
}

function toCents(value, { allowZero = false } = {}) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < 0) return Number.NaN;
    if (!allowZero && value === 0) return Number.NaN;
    if (value > MAX_AMOUNT_CENTS) return Number.NaN;
    return value;
  }

  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return Number.NaN;
  const num = Number(raw);
  if (!Number.isFinite(num)) return Number.NaN;
  const cents = Math.round(num * 100);
  if (cents < 0) return Number.NaN;
  if (!allowZero && cents === 0) return Number.NaN;
  if (cents > MAX_AMOUNT_CENTS) return Number.NaN;
  return cents;
}

function financeError(status, code, message, details = null) {
  return json({
    error: {
      code,
      message,
      details
    }
  }, status);
}

async function ensureSchema(env) {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finance_donors (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      middle_name TEXT,
      last_name TEXT NOT NULL,
      preferred_name TEXT,
      household_id TEXT,
      mailing_address TEXT,
      email TEXT,
      phone TEXT,
      statement_delivery TEXT NOT NULL DEFAULT 'mail',
      active INTEGER NOT NULL DEFAULT 1,
      statement_eligible INTEGER NOT NULL DEFAULT 1,
      envelope_number TEXT UNIQUE,
      envelope_code TEXT UNIQUE,
      envelope_code_status TEXT NOT NULL DEFAULT 'inactive',
      envelope_code_issued_at TEXT,
      envelope_code_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finance_donor_envelope_codes (
      id TEXT PRIMARY KEY,
      donor_id TEXT NOT NULL REFERENCES finance_donors(id) ON DELETE CASCADE,
      envelope_code TEXT NOT NULL UNIQUE,
      envelope_number_snapshot TEXT,
      status TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      replaced_by_code TEXT,
      note TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finance_collection_batches (
      id TEXT PRIMARY KEY,
      service_date TEXT NOT NULL,
      service_name TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      declared_physical_cash_cents INTEGER NOT NULL DEFAULT 0,
      declared_check_cents INTEGER NOT NULL DEFAULT 0,
      calculated_envelope_total_cents INTEGER NOT NULL DEFAULT 0,
      calculated_loose_cash_total_cents INTEGER NOT NULL DEFAULT 0,
      calculated_batch_total_cents INTEGER NOT NULL DEFAULT 0,
      discrepancy_cents INTEGER NOT NULL DEFAULT 0,
      discrepancy_explanation TEXT,
      count_sheet_attachment_ref TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finalized_at TEXT,
      voided_at TEXT,
      voided_by TEXT,
      void_reason TEXT,
      deposit_date TEXT,
      deposit_reference TEXT,
      deposited_amount_cents INTEGER,
      deposit_confirmed_at TEXT,
      deposit_verified_by TEXT,
      deposit_internal_control_exception TEXT,
      approval_version INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finance_collection_counters (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES finance_collection_batches(id) ON DELETE CASCADE,
      counter_email TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      UNIQUE(batch_id, counter_email)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finance_collection_counter_approvals (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES finance_collection_batches(id) ON DELETE CASCADE,
      counter_email TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      batch_version INTEGER NOT NULL,
      UNIQUE(batch_id, counter_email, batch_version)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finance_collection_envelopes (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES finance_collection_batches(id) ON DELETE CASCADE,
      donor_id TEXT NOT NULL REFERENCES finance_donors(id),
      envelope_code_snapshot TEXT,
      envelope_number_snapshot TEXT,
      payment_method TEXT NOT NULL,
      check_number TEXT,
      envelope_total_cents INTEGER NOT NULL,
      entry_status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finance_collection_allocations (
      id TEXT PRIMARY KEY,
      envelope_entry_id TEXT NOT NULL REFERENCES finance_collection_envelopes(id) ON DELETE CASCADE,
      fund_id TEXT,
      fund_code TEXT,
      amount_cents INTEGER NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finance_collection_loose_giving (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES finance_collection_batches(id) ON DELETE CASCADE,
      fund_id TEXT,
      fund_code TEXT,
      payment_method TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      note TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finance_collection_audit_events (
      id TEXT PRIMARY KEY,
      batch_id TEXT,
      donor_id TEXT,
      envelope_entry_id TEXT,
      event_type TEXT NOT NULL,
      event_action TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_envelope_unique_batch_code ON finance_collection_envelopes(batch_id, envelope_code_snapshot)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_donors_name ON finance_donors(last_name, first_name)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_donors_envelope_number ON finance_donors(envelope_number)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_donor_codes_code ON finance_donor_envelope_codes(envelope_code)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_batch_service_date ON finance_collection_batches(service_date)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_batch_status ON finance_collection_batches(status)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_envelope_batch ON finance_collection_envelopes(batch_id, created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_envelope_donor ON finance_collection_envelopes(donor_id, created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_alloc_fund ON finance_collection_allocations(fund_id, fund_code)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_loose_batch ON finance_collection_loose_giving(batch_id, created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_finance_audit_batch_time ON finance_collection_audit_events(batch_id, created_at)')
  ]);
}

async function resolveFinanceAccess(env, email) {
  const normalizedEmail = normalizeEmail(email);
  let role = 'administrator';

  if (env.DB && normalizedEmail) {
    const row = await env.DB.prepare(
      `SELECT role FROM admin_invites WHERE email = ? AND status = 'invited' LIMIT 1`
    ).bind(normalizedEmail).first().catch(() => null);
    if (row?.role) role = normalizeText(row.role, 40).toLowerCase();
  }

  const permissions = {
    canRead: true,
    canWrite: false,
    canAssignCounters: false,
    canApprove: false,
    canFinalize: false,
    canReopenOrVoid: false,
    canConfirmDeposit: false,
    canManageEnvelopeCodes: false,
    canViewSensitiveChecks: false
  };

  if (role === 'administrator' || role === 'treasurer') {
    permissions.canWrite = true;
    permissions.canAssignCounters = true;
    permissions.canApprove = true;
    permissions.canFinalize = true;
    permissions.canReopenOrVoid = true;
    permissions.canConfirmDeposit = true;
    permissions.canManageEnvelopeCodes = true;
    permissions.canViewSensitiveChecks = true;
  } else if (role === 'finance_entry') {
    permissions.canWrite = true;
    permissions.canAssignCounters = true;
    permissions.canApprove = true;
    permissions.canManageEnvelopeCodes = true;
    permissions.canViewSensitiveChecks = true;
  } else if (role === 'auditor') {
    permissions.canApprove = true;
    permissions.canFinalize = true;
    permissions.canViewSensitiveChecks = true;
  }

  return {
    email: normalizedEmail,
    role,
    permissions
  };
}

async function requireFinanceUser(env, user, { mutation = false, permission = 'canRead' } = {}) {
  if (!user?.email) {
    return { error: financeError(401, 'UNAUTHORIZED', 'Sign-in is required for finance operations.') };
  }
  const access = await resolveFinanceAccess(env, user.email);
  if (!access.permissions[permission]) {
    const message = mutation ? 'You do not have permission to change finance records.' : 'You do not have permission to access finance records.';
    return { error: financeError(403, 'FORBIDDEN', message) };
  }
  return { access };
}

async function writeAudit(env, {
  batchId = null,
  donorId = null,
  envelopeEntryId = null,
  eventType,
  eventAction,
  actorEmail,
  reason = '',
  metadata = null
} = {}) {
  const metadataJson = metadata && typeof metadata === 'object' ? JSON.stringify(metadata).slice(0, 4000) : null;
  await env.DB.prepare(
    `INSERT INTO finance_collection_audit_events (
      id, batch_id, donor_id, envelope_entry_id, event_type, event_action, actor_email, reason, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    batchId,
    donorId,
    envelopeEntryId,
    normalizeText(eventType, 80),
    normalizeText(eventAction, 120),
    normalizeEmail(actorEmail),
    normalizeText(reason, 500),
    metadataJson,
    new Date().toISOString()
  ).run();
}

async function getActiveFund(env, { fundId = '', fundCode = '' } = {}) {
  const cleanId = normalizeText(fundId, 80);
  const cleanCode = normalizeText(fundCode, 80);

  if (cleanId) {
    const byId = await env.DB.prepare(
      'SELECT id, fund_name, fund_code, active FROM finance_funds WHERE id = ? LIMIT 1'
    ).bind(cleanId).first().catch(() => null);
    if (!byId?.id || Number(byId.active || 0) !== 1) return null;
    return {
      id: String(byId.id),
      fundName: normalizeText(byId.fund_name, 120),
      fundCode: normalizeText(byId.fund_code, 80)
    };
  }

  if (cleanCode) {
    const byCode = await env.DB.prepare(
      `SELECT id, fund_name, fund_code, active
       FROM finance_funds
       WHERE lower(coalesce(fund_code, '')) = lower(?)
       LIMIT 1`
    ).bind(cleanCode).first().catch(() => null);
    if (!byCode?.id || Number(byCode.active || 0) !== 1) return null;
    return {
      id: String(byCode.id),
      fundName: normalizeText(byCode.fund_name, 120),
      fundCode: normalizeText(byCode.fund_code, 80)
    };
  }

  return null;
}

async function getBatch(env, batchId) {
  return env.DB.prepare('SELECT * FROM finance_collection_batches WHERE id = ? LIMIT 1').bind(batchId).first().catch(() => null);
}

function batchIsLocked(status) {
  const s = String(status || '').toLowerCase();
  return s === 'verified' || s === 'deposited' || s === 'voided';
}

async function recalcBatch(env, batchId) {
  const envelopeTotals = await env.DB.prepare(
    `SELECT
       coalesce(sum(envelope_total_cents), 0) AS envelope_total,
       coalesce(sum(CASE WHEN payment_method = 'cash' THEN envelope_total_cents ELSE 0 END), 0) AS cash_envelope_total,
       coalesce(sum(CASE WHEN payment_method = 'check' THEN envelope_total_cents ELSE 0 END), 0) AS check_envelope_total
     FROM finance_collection_envelopes
     WHERE batch_id = ? AND entry_status = 'active'`
  ).bind(batchId).first().catch(() => ({ envelope_total: 0, cash_envelope_total: 0, check_envelope_total: 0 }));

  const looseTotals = await env.DB.prepare(
    `SELECT
       coalesce(sum(amount_cents), 0) AS loose_total,
       coalesce(sum(CASE WHEN payment_method = 'cash' THEN amount_cents ELSE 0 END), 0) AS loose_cash_total,
       coalesce(sum(CASE WHEN payment_method = 'check' THEN amount_cents ELSE 0 END), 0) AS loose_check_total
     FROM finance_collection_loose_giving
     WHERE batch_id = ?`
  ).bind(batchId).first().catch(() => ({ loose_total: 0, loose_cash_total: 0, loose_check_total: 0 }));

  const batch = await getBatch(env, batchId);
  if (!batch) return null;

  const envelopeTotal = Number(envelopeTotals?.envelope_total || 0);
  const looseTotal = Number(looseTotals?.loose_total || 0);
  const calculatedBatchTotal = envelopeTotal + looseTotal;
  const declaredPhysicalCash = Number(batch.declared_physical_cash_cents || 0);
  const declaredCheck = Number(batch.declared_check_cents || 0);
  const discrepancy = (declaredPhysicalCash + declaredCheck) - calculatedBatchTotal;

  await env.DB.prepare(
    `UPDATE finance_collection_batches
     SET calculated_envelope_total_cents = ?,
         calculated_loose_cash_total_cents = ?,
         calculated_batch_total_cents = ?,
         discrepancy_cents = ?,
         updated_at = ?
     WHERE id = ?`
  ).bind(
    envelopeTotal,
    looseTotal,
    calculatedBatchTotal,
    discrepancy,
    new Date().toISOString(),
    batchId
  ).run();

  const byFund = await env.DB.prepare(
    `SELECT
       coalesce(a.fund_id, l.fund_id) AS fund_id,
       coalesce(nullif(a.fund_code, ''), nullif(l.fund_code, '')) AS fund_code,
       coalesce(sum(coalesce(a.amount_cents, 0)), 0) + coalesce(sum(coalesce(l.amount_cents, 0)), 0) AS total_cents
     FROM finance_collection_batches b
     LEFT JOIN finance_collection_envelopes e ON e.batch_id = b.id AND e.entry_status = 'active'
     LEFT JOIN finance_collection_allocations a ON a.envelope_entry_id = e.id
     LEFT JOIN finance_collection_loose_giving l ON l.batch_id = b.id
     WHERE b.id = ?
     GROUP BY fund_id, fund_code
     HAVING total_cents > 0`
  ).bind(batchId).all().catch(() => ({ results: [] }));

  return {
    batchId,
    calculatedEnvelopeTotalCents: envelopeTotal,
    calculatedLooseCashTotalCents: looseTotal,
    calculatedBatchTotalCents: calculatedBatchTotal,
    discrepancyCents: discrepancy,
    cashEnvelopeTotalCents: Number(envelopeTotals?.cash_envelope_total || 0),
    checkEnvelopeTotalCents: Number(envelopeTotals?.check_envelope_total || 0),
    looseCashTotalCents: Number(looseTotals?.loose_cash_total || 0),
    looseCheckTotalCents: Number(looseTotals?.loose_check_total || 0),
    byFund: (byFund?.results || []).map((row) => ({
      fundId: normalizeText(row.fund_id, 80),
      fundCode: normalizeText(row.fund_code, 80),
      totalCents: Number(row.total_cents || 0)
    }))
  };
}

async function invalidateApprovals(env, batchId, actorEmail, reason) {
  const existing = await env.DB.prepare(
    'SELECT id FROM finance_collection_counter_approvals WHERE batch_id = ? LIMIT 1'
  ).bind(batchId).first().catch(() => null);
  if (!existing?.id) return;

  await env.DB.batch([
    env.DB.prepare('DELETE FROM finance_collection_counter_approvals WHERE batch_id = ?').bind(batchId),
    env.DB.prepare('UPDATE finance_collection_batches SET approval_version = approval_version + 1, updated_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), batchId)
  ]);

  await writeAudit(env, {
    batchId,
    eventType: 'batch',
    eventAction: 'approvals_invalidated',
    actorEmail,
    reason,
    metadata: { batchId }
  });
}

async function listBatches(env, url) {
  const status = normalizeText(url.searchParams.get('status'), 40).toLowerCase();
  const from = normalizeDate(url.searchParams.get('from'));
  const to = normalizeDate(url.searchParams.get('to'));

  const filters = [];
  const binds = [];

  if (status && BATCH_STATUSES.has(status)) {
    filters.push('status = ?');
    binds.push(status);
  }
  if (from) {
    filters.push('service_date >= ?');
    binds.push(from);
  }
  if (to) {
    filters.push('service_date <= ?');
    binds.push(to);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `SELECT * FROM finance_collection_batches ${where}
     ORDER BY service_date DESC, created_at DESC LIMIT 200`
  ).bind(...binds).all().catch(() => ({ results: [] }));

  return (rows?.results || []).map((row) => ({
    id: String(row.id || ''),
    serviceDate: String(row.service_date || ''),
    serviceName: normalizeText(row.service_name, 120),
    status: String(row.status || 'draft'),
    declaredPhysicalCashCents: Number(row.declared_physical_cash_cents || 0),
    declaredCheckCents: Number(row.declared_check_cents || 0),
    calculatedEnvelopeTotalCents: Number(row.calculated_envelope_total_cents || 0),
    calculatedLooseCashTotalCents: Number(row.calculated_loose_cash_total_cents || 0),
    calculatedBatchTotalCents: Number(row.calculated_batch_total_cents || 0),
    discrepancyCents: Number(row.discrepancy_cents || 0),
    createdBy: normalizeEmail(row.created_by),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    finalizedAt: String(row.finalized_at || ''),
    depositDate: String(row.deposit_date || ''),
    depositedAmountCents: Number(row.deposited_amount_cents || 0)
  }));
}

async function getBatchDetails(env, batchId, access) {
  const batch = await getBatch(env, batchId);
  if (!batch) return null;

  const countersRows = await env.DB.prepare(
    'SELECT counter_email, assigned_by, assigned_at FROM finance_collection_counters WHERE batch_id = ? ORDER BY assigned_at ASC'
  ).bind(batchId).all().catch(() => ({ results: [] }));

  const approvalRows = await env.DB.prepare(
    'SELECT counter_email, approved_by, approved_at, batch_version FROM finance_collection_counter_approvals WHERE batch_id = ? ORDER BY approved_at ASC'
  ).bind(batchId).all().catch(() => ({ results: [] }));

  const entriesRows = await env.DB.prepare(
    `SELECT e.*, d.first_name, d.last_name, d.preferred_name
     FROM finance_collection_envelopes e
     LEFT JOIN finance_donors d ON d.id = e.donor_id
     WHERE e.batch_id = ?
     ORDER BY e.created_at DESC`
  ).bind(batchId).all().catch(() => ({ results: [] }));

  const entryIds = (entriesRows?.results || []).map((row) => String(row.id || '')).filter(Boolean);
  const allocationsByEntry = new Map();
  if (entryIds.length) {
    const placeholders = entryIds.map(() => '?').join(',');
    const allocRows = await env.DB.prepare(
      `SELECT envelope_entry_id, fund_id, fund_code, amount_cents, note
       FROM finance_collection_allocations
       WHERE envelope_entry_id IN (${placeholders})
       ORDER BY created_at ASC`
    ).bind(...entryIds).all().catch(() => ({ results: [] }));

    for (const row of (allocRows?.results || [])) {
      const key = String(row.envelope_entry_id || '');
      if (!allocationsByEntry.has(key)) allocationsByEntry.set(key, []);
      allocationsByEntry.get(key).push({
        fundId: normalizeText(row.fund_id, 80),
        fundCode: normalizeText(row.fund_code, 80),
        amountCents: Number(row.amount_cents || 0),
        note: normalizeText(row.note, 240)
      });
    }
  }

  const looseRows = await env.DB.prepare(
    `SELECT id, fund_id, fund_code, payment_method, amount_cents, note, created_by, created_at
     FROM finance_collection_loose_giving
     WHERE batch_id = ?
     ORDER BY created_at DESC`
  ).bind(batchId).all().catch(() => ({ results: [] }));

  const reconciliation = await recalcBatch(env, batchId);

  return {
    batch: {
      id: String(batch.id || ''),
      serviceDate: String(batch.service_date || ''),
      serviceName: normalizeText(batch.service_name, 120),
      status: String(batch.status || 'draft'),
      declaredPhysicalCashCents: Number(batch.declared_physical_cash_cents || 0),
      declaredCheckCents: Number(batch.declared_check_cents || 0),
      discrepancyExplanation: normalizeText(batch.discrepancy_explanation, 500),
      countSheetAttachmentRef: normalizeText(batch.count_sheet_attachment_ref, 300),
      createdBy: normalizeEmail(batch.created_by),
      createdAt: String(batch.created_at || ''),
      updatedAt: String(batch.updated_at || ''),
      finalizedAt: String(batch.finalized_at || ''),
      voidedAt: String(batch.voided_at || ''),
      voidedBy: normalizeEmail(batch.voided_by),
      voidReason: normalizeText(batch.void_reason, 500),
      depositDate: String(batch.deposit_date || ''),
      depositReference: normalizeText(batch.deposit_reference, 140),
      depositedAmountCents: Number(batch.deposited_amount_cents || 0),
      depositConfirmedAt: String(batch.deposit_confirmed_at || ''),
      depositVerifiedBy: normalizeEmail(batch.deposit_verified_by),
      depositInternalControlException: normalizeText(batch.deposit_internal_control_exception, 500),
      approvalVersion: Number(batch.approval_version || 0)
    },
    counters: (countersRows?.results || []).map((row) => ({
      counterEmail: normalizeEmail(row.counter_email),
      assignedBy: normalizeEmail(row.assigned_by),
      assignedAt: String(row.assigned_at || '')
    })),
    approvals: (approvalRows?.results || []).map((row) => ({
      counterEmail: normalizeEmail(row.counter_email),
      approvedBy: normalizeEmail(row.approved_by),
      approvedAt: String(row.approved_at || ''),
      batchVersion: Number(row.batch_version || 0)
    })),
    entries: (entriesRows?.results || []).map((row) => {
      const donorDisplayName = normalizeText(row.preferred_name, 120) || `${normalizeText(row.first_name, 120)} ${normalizeText(row.last_name, 120)}`.trim();
      return {
        id: String(row.id || ''),
        donorId: String(row.donor_id || ''),
        donorDisplayName,
        envelopeCodeSnapshot: normalizeText(row.envelope_code_snapshot, 120),
        envelopeNumberSnapshot: normalizeText(row.envelope_number_snapshot, 60),
        paymentMethod: normalizeText(row.payment_method, 20),
        checkNumber: access.permissions.canViewSensitiveChecks ? normalizeText(row.check_number, 60) : '',
        envelopeTotalCents: Number(row.envelope_total_cents || 0),
        entryStatus: normalizeText(row.entry_status, 20) || 'active',
        createdAt: String(row.created_at || ''),
        updatedAt: String(row.updated_at || ''),
        allocations: allocationsByEntry.get(String(row.id || '')) || []
      };
    }),
    looseGiving: (looseRows?.results || []).map((row) => ({
      id: String(row.id || ''),
      fundId: normalizeText(row.fund_id, 80),
      fundCode: normalizeText(row.fund_code, 80),
      paymentMethod: normalizeText(row.payment_method, 20),
      amountCents: Number(row.amount_cents || 0),
      note: normalizeText(row.note, 240),
      createdBy: normalizeEmail(row.created_by),
      createdAt: String(row.created_at || '')
    })),
    reconciliation
  };
}

async function resolveEnvelope(env, envelopeCode) {
  const code = normalizeCode(envelopeCode);
  if (!code) return { status: 400, error: 'Envelope code format is invalid.' };

  const row = await env.DB.prepare(
    `SELECT c.status, c.envelope_code, d.id AS donor_id, d.first_name, d.last_name, d.preferred_name,
            d.envelope_number, d.active
     FROM finance_donor_envelope_codes c
     INNER JOIN finance_donors d ON d.id = c.donor_id
     WHERE c.envelope_code = ?
     LIMIT 1`
  ).bind(code).first().catch(() => null);

  if (!row) return { status: 404, error: 'Envelope code was not recognized.' };

  const status = normalizeText(row.status, 20).toLowerCase();
  if (status !== 'active') {
    return {
      status: 409,
      error: `Envelope code is ${status}.`,
      donor: {
        donorId: String(row.donor_id || ''),
        displayName: normalizeText(row.preferred_name, 120) || `${normalizeText(row.first_name, 120)} ${normalizeText(row.last_name, 120)}`.trim(),
        envelopeNumber: normalizeText(row.envelope_number, 60),
        active: Number(row.active || 0) === 1,
        envelopeCodeStatus: status
      }
    };
  }

  return {
    status: 200,
    donor: {
      donorId: String(row.donor_id || ''),
      displayName: normalizeText(row.preferred_name, 120) || `${normalizeText(row.first_name, 120)} ${normalizeText(row.last_name, 120)}`.trim(),
      envelopeNumber: normalizeText(row.envelope_number, 60),
      active: Number(row.active || 0) === 1,
      envelopeCodeStatus: status,
      envelopeCode: normalizeText(row.envelope_code, 120)
    }
  };
}

async function donorList(env, query) {
  const q = normalizeText(query, 140);
  const like = `%${q.toLowerCase()}%`;

  const rows = q
    ? await env.DB.prepare(
      `SELECT * FROM finance_donors
       WHERE lower(first_name || ' ' || last_name) LIKE ?
          OR lower(coalesce(email, '')) LIKE ?
          OR lower(coalesce(phone, '')) LIKE ?
          OR lower(coalesce(household_id, '')) LIKE ?
          OR lower(coalesce(envelope_number, '')) LIKE ?
       ORDER BY last_name ASC, first_name ASC LIMIT 200`
    ).bind(like, like, like, like, like).all().catch(() => ({ results: [] }))
    : await env.DB.prepare(
      `SELECT * FROM finance_donors ORDER BY last_name ASC, first_name ASC LIMIT 200`
    ).all().catch(() => ({ results: [] }));

  const totals = await env.DB.prepare(
    `SELECT
       count(*) AS total_donors,
       coalesce(sum(CASE WHEN trim(coalesce(mailing_address, '')) = '' THEN 1 ELSE 0 END), 0) AS missing_address_count
     FROM finance_donors`
  ).first().catch(() => ({ total_donors: 0, missing_address_count: 0 }));

  return {
    donors: (rows?.results || []).map((row) => ({
      id: String(row.id || ''),
      firstName: normalizeText(row.first_name, 120),
      middleName: normalizeText(row.middle_name, 120),
      lastName: normalizeText(row.last_name, 120),
      preferredName: normalizeText(row.preferred_name, 120),
      householdId: normalizeText(row.household_id, 120),
      mailingAddress: normalizeText(row.mailing_address, 500),
      email: normalizeText(row.email, 254),
      phone: normalizeText(row.phone, 80),
      envelopeNumber: normalizeText(row.envelope_number, 60),
      envelopeCodeStatus: normalizeText(row.envelope_code_status, 20) || 'inactive',
      statementDelivery: normalizeText(row.statement_delivery, 40) || 'mail',
      active: Number(row.active || 0) === 1,
      statementEligible: Number(row.statement_eligible || 0) === 1,
      envelopeCodeIssuedAt: String(row.envelope_code_issued_at || ''),
      envelopeCodeUpdatedAt: String(row.envelope_code_updated_at || '')
    })),
    totalDonors: Number(totals?.total_donors || 0),
    missingAddressCount: Number(totals?.missing_address_count || 0)
  };
}

function newEnvelopeCode() {
  return `${ENVELOPE_CODE_PREFIX}${crypto.randomUUID()}`;
}

async function setDonorEnvelopeCode(env, donorId, {
  mode,
  actorEmail,
  note = ''
} = {}) {
  const donor = await env.DB.prepare('SELECT * FROM finance_donors WHERE id = ? LIMIT 1').bind(donorId).first().catch(() => null);
  if (!donor?.id) {
    return { error: financeError(404, 'DONOR_NOT_FOUND', 'Donor was not found.') };
  }

  const now = new Date().toISOString();
  const currentCode = normalizeCode(donor.envelope_code);
  const currentNumber = normalizeText(donor.envelope_number, 60);
  const currentStatus = normalizeText(donor.envelope_code_status, 20).toLowerCase() || 'inactive';

  if (mode === 'issue' && currentStatus === 'active' && currentCode) {
    return { error: financeError(409, 'ENVELOPE_CODE_ALREADY_ACTIVE', 'Donor already has an active envelope code.') };
  }

  let nextCode = currentCode;
  let nextStatus = currentStatus;
  let replacedCode = '';

  if (mode === 'issue') {
    nextCode = newEnvelopeCode();
    nextStatus = 'active';
  } else if (mode === 'replace') {
    if (!currentCode || currentStatus !== 'active') {
      return { error: financeError(409, 'NO_ACTIVE_CODE', 'An active envelope code is required before replacement.') };
    }
    replacedCode = currentCode;
    nextCode = newEnvelopeCode();
    nextStatus = 'active';
  } else if (mode === 'deactivate') {
    if (!currentCode) {
      return { error: financeError(409, 'NO_CODE_TO_DEACTIVATE', 'Donor does not have an envelope code to deactivate.') };
    }
    nextStatus = 'inactive';
  } else {
    return { error: financeError(400, 'INVALID_MODE', 'Unsupported envelope-code operation.') };
  }

  const statements = [];

  if (mode === 'replace' && replacedCode) {
    statements.push(
      env.DB.prepare(
        `UPDATE finance_donor_envelope_codes
         SET status = 'replaced', updated_at = ?, replaced_by_code = ?
         WHERE donor_id = ? AND envelope_code = ?`
      ).bind(now, nextCode, donorId, replacedCode)
    );
  }

  if (mode === 'deactivate' && currentCode) {
    statements.push(
      env.DB.prepare(
        `UPDATE finance_donor_envelope_codes
         SET status = 'inactive', updated_at = ?, note = ?
         WHERE donor_id = ? AND envelope_code = ? AND status = 'active'`
      ).bind(now, normalizeText(note, 240), donorId, currentCode)
    );
  }

  if (mode === 'issue' || mode === 'replace') {
    statements.push(
      env.DB.prepare(
        `INSERT INTO finance_donor_envelope_codes
         (id, donor_id, envelope_code, envelope_number_snapshot, status, issued_at, updated_at, replaced_by_code, note)
         VALUES (?, ?, ?, ?, 'active', ?, ?, '', ?)`
      ).bind(
        crypto.randomUUID(),
        donorId,
        nextCode,
        currentNumber,
        now,
        now,
        normalizeText(note, 240)
      )
    );
  }

  const donorEnvelopeCode = (mode === 'deactivate') ? '' : nextCode;
  statements.push(
    env.DB.prepare(
      `UPDATE finance_donors
       SET envelope_code = ?, envelope_code_status = ?,
           envelope_code_issued_at = CASE WHEN ? IN ('issue', 'replace') THEN ? ELSE envelope_code_issued_at END,
           envelope_code_updated_at = ?,
           updated_at = ?
       WHERE id = ?`
    ).bind(
      donorEnvelopeCode,
      nextStatus,
      mode,
      now,
      now,
      now,
      donorId
    )
  );

  await env.DB.batch(statements);

  await writeAudit(env, {
    donorId,
    eventType: 'donor_envelope_code',
    eventAction: `code_${mode}`,
    actorEmail,
    reason: normalizeText(note, 240),
    metadata: {
      donorId,
      envelopeNumber: currentNumber,
      previousCode: replacedCode,
      code: donorEnvelopeCode,
      status: nextStatus
    }
  });

  return {
    donorId,
    envelopeCode: donorEnvelopeCode,
    envelopeCodeStatus: nextStatus,
    envelopeCodeIssuedAt: now,
    envelopeCodeUpdatedAt: now
  };
}

function parseAllocations(input) {
  if (!Array.isArray(input) || !input.length) return { error: 'At least one allocation is required.' };
  const allocations = [];
  let sum = 0;
  for (const item of input) {
    const fundId = normalizeText(item?.fundId, 80);
    const fundCode = normalizeText(item?.fundCode, 80);
    const amountCents = toCents(item?.amountCents ?? item?.amount, { allowZero: false });
    if (!fundId && !fundCode) return { error: 'Each allocation must include fundId or fundCode.' };
    if (!Number.isInteger(amountCents) || amountCents <= 0) return { error: 'Allocation amounts must be positive integer cents.' };
    allocations.push({ fundId, fundCode, amountCents, note: normalizeText(item?.note, 240) });
    sum += amountCents;
  }
  return { allocations, sum };
}

async function upsertEnvelopeEntry(env, access, batchId, payload) {
  const batch = await getBatch(env, batchId);
  if (!batch) return { error: financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.') };
  const status = normalizeText(batch.status, 40).toLowerCase() || 'draft';
  if (batchIsLocked(status)) {
    return { error: financeError(409, 'BATCH_LOCKED', 'This batch is locked and cannot be edited.') };
  }

  const entryId = normalizeText(payload?.entryId, 80);
  const resolved = await resolveEnvelope(env, payload?.envelopeCode);
  if (resolved.status !== 200) {
    return { error: financeError(resolved.status, 'ENVELOPE_NOT_RESOLVED', resolved.error || 'Envelope lookup failed.') };
  }

  const donor = resolved.donor;
  const paymentMethod = normalizeText(payload?.paymentMethod, 20).toLowerCase();
  const checkNumber = normalizeText(payload?.checkNumber, 60);
  const envelopeTotalCents = toCents(payload?.envelopeTotalCents ?? payload?.amountCents ?? payload?.amount, { allowZero: false });
  const parsedAlloc = parseAllocations(payload?.allocations);

  if (!PAYMENT_METHODS.has(paymentMethod)) {
    return { error: financeError(400, 'INVALID_PAYMENT_METHOD', 'Payment method must be cash or check.') };
  }
  if (paymentMethod === 'check' && !checkNumber) {
    return { error: financeError(400, 'CHECK_NUMBER_REQUIRED', 'Check number is required for check envelopes.') };
  }
  if (!Number.isInteger(envelopeTotalCents) || envelopeTotalCents <= 0) {
    return { error: financeError(400, 'INVALID_AMOUNT', 'Envelope total must be a positive integer amount in cents.') };
  }
  if (parsedAlloc.error) {
    return { error: financeError(400, 'INVALID_ALLOCATIONS', parsedAlloc.error) };
  }
  if (parsedAlloc.sum !== envelopeTotalCents) {
    return { error: financeError(400, 'ALLOCATION_MISMATCH', 'Allocation totals must equal envelope total.') };
  }

  const duplicate = await env.DB.prepare(
    `SELECT id, donor_id, envelope_total_cents, payment_method, created_at
     FROM finance_collection_envelopes
     WHERE batch_id = ? AND envelope_code_snapshot = ? AND entry_status = 'active'
     LIMIT 1`
  ).bind(batchId, donor.envelopeCode).first().catch(() => null);

  if (duplicate?.id && (!entryId || String(duplicate.id) !== entryId)) {
    return {
      error: financeError(409, 'DUPLICATE_ENVELOPE_IN_BATCH', 'This envelope has already been entered for this batch.', {
        existingEntryId: String(duplicate.id || ''),
        amountCents: Number(duplicate.envelope_total_cents || 0),
        paymentMethod: normalizeText(duplicate.payment_method, 20)
      })
    };
  }

  const now = new Date().toISOString();
  const statements = [];
  const actorEmail = access.email;
  let effectiveEntryId = entryId;
  let action = 'envelope_created';

  if (entryId) {
    const existing = await env.DB.prepare(
      `SELECT id FROM finance_collection_envelopes WHERE id = ? AND batch_id = ? LIMIT 1`
    ).bind(entryId, batchId).first().catch(() => null);
    if (!existing?.id) {
      return { error: financeError(404, 'ENTRY_NOT_FOUND', 'Envelope entry was not found in this batch.') };
    }

    statements.push(
      env.DB.prepare(
        `UPDATE finance_collection_envelopes
         SET donor_id = ?, envelope_code_snapshot = ?, envelope_number_snapshot = ?, payment_method = ?,
             check_number = ?, envelope_total_cents = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`
      ).bind(
        donor.donorId,
        donor.envelopeCode,
        donor.envelopeNumber,
        paymentMethod,
        checkNumber,
        envelopeTotalCents,
        actorEmail,
        now,
        entryId
      ),
      env.DB.prepare('DELETE FROM finance_collection_allocations WHERE envelope_entry_id = ?').bind(entryId)
    );
    action = 'envelope_updated';
  } else {
    effectiveEntryId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO finance_collection_envelopes
         (id, batch_id, donor_id, envelope_code_snapshot, envelope_number_snapshot, payment_method,
          check_number, envelope_total_cents, entry_status, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      ).bind(
        effectiveEntryId,
        batchId,
        donor.donorId,
        donor.envelopeCode,
        donor.envelopeNumber,
        paymentMethod,
        checkNumber,
        envelopeTotalCents,
        actorEmail,
        actorEmail,
        now,
        now
      )
    );
  }

  for (const allocation of parsedAlloc.allocations) {
    const fund = await getActiveFund(env, allocation);
    if (!fund) {
      return { error: financeError(400, 'INVALID_FUND', 'All allocations must map to active funds.') };
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO finance_collection_allocations
         (id, envelope_entry_id, fund_id, fund_code, amount_cents, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        effectiveEntryId,
        fund.id,
        fund.fundCode,
        allocation.amountCents,
        allocation.note,
        now,
        now
      )
    );
  }

  await env.DB.batch(statements);
  await invalidateApprovals(env, batchId, actorEmail, 'Financial entries changed.');
  await recalcBatch(env, batchId);

  await writeAudit(env, {
    batchId,
    donorId: donor.donorId,
    envelopeEntryId: effectiveEntryId,
    eventType: 'envelope_entry',
    eventAction: action,
    actorEmail,
    metadata: {
      batchId,
      donorId: donor.donorId,
      envelopeCode: donor.envelopeCode,
      paymentMethod,
      envelopeTotalCents
    }
  });

  return {
    entryId: effectiveEntryId,
    donor,
    envelopeTotalCents
  };
}

async function addLooseGiving(env, access, batchId, payload) {
  const batch = await getBatch(env, batchId);
  if (!batch) return { error: financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.') };
  const status = normalizeText(batch.status, 40).toLowerCase();
  if (batchIsLocked(status)) {
    return { error: financeError(409, 'BATCH_LOCKED', 'This batch is locked and cannot be edited.') };
  }

  const fund = await getActiveFund(env, {
    fundId: payload?.fundId,
    fundCode: payload?.fundCode
  });
  if (!fund) {
    return { error: financeError(400, 'INVALID_FUND', 'Loose giving must map to an active fund.') };
  }

  const paymentMethod = normalizeText(payload?.paymentMethod, 20).toLowerCase();
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    return { error: financeError(400, 'INVALID_PAYMENT_METHOD', 'Loose-giving payment method must be cash or check.') };
  }

  const amountCents = toCents(payload?.amountCents ?? payload?.amount, { allowZero: false });
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { error: financeError(400, 'INVALID_AMOUNT', 'Loose-giving amount must be a positive integer amount in cents.') };
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO finance_collection_loose_giving
     (id, batch_id, fund_id, fund_code, payment_method, amount_cents, note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    batchId,
    fund.id,
    fund.fundCode,
    paymentMethod,
    amountCents,
    normalizeText(payload?.note, 240),
    access.email,
    now,
    now
  ).run();

  await invalidateApprovals(env, batchId, access.email, 'Loose giving changed.');
  await recalcBatch(env, batchId);
  await writeAudit(env, {
    batchId,
    eventType: 'loose_giving',
    eventAction: 'loose_added',
    actorEmail: access.email,
    metadata: {
      batchId,
      fundId: fund.id,
      fundCode: fund.fundCode,
      amountCents,
      paymentMethod
    }
  });

  return { id, amountCents };
}

async function assignCounters(env, access, batchId, payload) {
  const batch = await getBatch(env, batchId);
  if (!batch) return { error: financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.') };
  const status = normalizeText(batch.status, 40).toLowerCase();
  if (batchIsLocked(status)) {
    return { error: financeError(409, 'BATCH_LOCKED', 'This batch is locked and cannot be edited.') };
  }

  const emails = Array.from(new Set((Array.isArray(payload?.counterEmails) ? payload.counterEmails : [])
    .map((value) => normalizeEmail(value))
    .filter(Boolean)));

  if (emails.length < 2) {
    return { error: financeError(400, 'COUNTERS_REQUIRED', 'At least two distinct counters are required.') };
  }

  const now = new Date().toISOString();
  const statements = [env.DB.prepare('DELETE FROM finance_collection_counters WHERE batch_id = ?').bind(batchId)];

  for (const email of emails) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO finance_collection_counters
         (id, batch_id, counter_email, assigned_by, assigned_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), batchId, email, access.email, now)
    );
  }

  await env.DB.batch(statements);
  await invalidateApprovals(env, batchId, access.email, 'Counter assignments updated.');

  await writeAudit(env, {
    batchId,
    eventType: 'batch_counter',
    eventAction: 'counters_assigned',
    actorEmail: access.email,
    metadata: {
      batchId,
      counters: emails
    }
  });

  return { counters: emails };
}

async function submitCounterApproval(env, access, batchId) {
  const batch = await getBatch(env, batchId);
  if (!batch) return { error: financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.') };

  const status = normalizeText(batch.status, 40).toLowerCase();
  if (batchIsLocked(status)) {
    return { error: financeError(409, 'BATCH_LOCKED', 'This batch is locked and cannot be approved.') };
  }

  const counter = await env.DB.prepare(
    'SELECT counter_email FROM finance_collection_counters WHERE batch_id = ? AND counter_email = ? LIMIT 1'
  ).bind(batchId, access.email).first().catch(() => null);

  if (!counter?.counter_email) {
    return { error: financeError(403, 'NOT_ASSIGNED_COUNTER', 'Only assigned counters can submit approval.') };
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM finance_collection_counter_approvals
     WHERE batch_id = ? AND counter_email = ? AND batch_version = ? LIMIT 1`
  ).bind(batchId, access.email, Number(batch.approval_version || 0)).first().catch(() => null);

  if (existing?.id) {
    return { error: financeError(409, 'ALREADY_APPROVED', 'You already approved this batch version.') };
  }

  await env.DB.prepare(
    `INSERT INTO finance_collection_counter_approvals
     (id, batch_id, counter_email, approved_by, approved_at, batch_version)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    batchId,
    access.email,
    access.email,
    new Date().toISOString(),
    Number(batch.approval_version || 0)
  ).run();

  await env.DB.prepare(
    `UPDATE finance_collection_batches
     SET status = CASE WHEN status = 'draft' THEN 'awaiting_verification' ELSE status END,
         updated_at = ?
     WHERE id = ?`
  ).bind(new Date().toISOString(), batchId).run();

  await writeAudit(env, {
    batchId,
    eventType: 'batch_approval',
    eventAction: 'counter_approved',
    actorEmail: access.email,
    metadata: {
      batchId,
      counterEmail: access.email,
      approvalVersion: Number(batch.approval_version || 0)
    }
  });

  return { ok: true };
}

async function finalizeBatch(env, access, batchId, payload) {
  const batch = await getBatch(env, batchId);
  if (!batch) return { error: financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.') };

  const status = normalizeText(batch.status, 40).toLowerCase();
  if (status === 'deposited' || status === 'voided') {
    return { error: financeError(409, 'BATCH_LOCKED', 'Deposited or voided batches cannot be finalized.') };
  }
  if (status === 'verified') {
    return { error: financeError(409, 'ALREADY_VERIFIED', 'Batch is already finalized.') };
  }

  const countersCount = await env.DB.prepare(
    'SELECT count(*) AS c FROM finance_collection_counters WHERE batch_id = ?'
  ).bind(batchId).first().catch(() => ({ c: 0 }));
  if (Number(countersCount?.c || 0) < 2) {
    return { error: financeError(400, 'COUNTERS_REQUIRED', 'At least two counters must be assigned before finalization.') };
  }

  const activeApprovals = await env.DB.prepare(
    `SELECT counter_email FROM finance_collection_counter_approvals
     WHERE batch_id = ? AND batch_version = ?`
  ).bind(batchId, Number(batch.approval_version || 0)).all().catch(() => ({ results: [] }));

  const uniqueApprovers = new Set((activeApprovals?.results || []).map((row) => normalizeEmail(row.counter_email)).filter(Boolean));
  if (uniqueApprovers.size < 2) {
    return { error: financeError(400, 'APPROVALS_REQUIRED', 'Two distinct counter approvals are required before finalization.') };
  }

  const reconciliation = await recalcBatch(env, batchId);
  if (!reconciliation) {
    return { error: financeError(500, 'RECONCILIATION_FAILED', 'Unable to calculate reconciliation totals.') };
  }

  const discrepancyExplanation = normalizeText(payload?.discrepancyExplanation || batch.discrepancy_explanation, 500);
  if (reconciliation.discrepancyCents !== 0 && !discrepancyExplanation) {
    return { error: financeError(400, 'DISCREPANCY_EXPLANATION_REQUIRED', 'Discrepancy explanation is required before finalization.') };
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE finance_collection_batches
     SET status = 'verified', finalized_at = ?, discrepancy_explanation = ?, updated_at = ?
     WHERE id = ?`
  ).bind(now, discrepancyExplanation, now, batchId).run();

  await writeAudit(env, {
    batchId,
    eventType: 'batch',
    eventAction: 'finalized',
    actorEmail: access.email,
    metadata: {
      batchId,
      discrepancyCents: reconciliation.discrepancyCents,
      discrepancyExplanation
    }
  });

  return { ok: true };
}

async function confirmDeposit(env, access, batchId, payload) {
  const batch = await getBatch(env, batchId);
  if (!batch) return { error: financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.') };

  const status = normalizeText(batch.status, 40).toLowerCase();
  if (status !== 'verified') {
    return { error: financeError(409, 'BATCH_NOT_READY', 'Batch must be finalized before deposit confirmation.') };
  }

  const depositedAmountCents = toCents(payload?.depositedAmountCents ?? payload?.depositedAmount ?? payload?.amount, { allowZero: false });
  if (!Number.isInteger(depositedAmountCents) || depositedAmountCents <= 0) {
    return { error: financeError(400, 'INVALID_DEPOSIT_AMOUNT', 'Deposited amount must be a positive integer amount in cents.') };
  }

  const depositDateIso = toIsoDate(payload?.depositDate);
  if (!depositDateIso) {
    return { error: financeError(400, 'INVALID_DEPOSIT_DATE', 'Deposit date is required.') };
  }

  const reconciliation = await recalcBatch(env, batchId);
  if (!reconciliation) {
    return { error: financeError(500, 'RECONCILIATION_FAILED', 'Unable to calculate reconciliation totals.') };
  }

  let internalControlException = '';
  if (normalizeEmail(batch.created_by) === access.email) {
    internalControlException = normalizeText(
      payload?.internalControlException || 'Deposit verifier is the same as batch creator.',
      500
    );
  }

  await env.DB.prepare(
    `UPDATE finance_collection_batches
     SET status = 'deposited',
         deposit_date = ?,
         deposit_reference = ?,
         deposited_amount_cents = ?,
         deposit_confirmed_at = ?,
         deposit_verified_by = ?,
         deposit_internal_control_exception = ?,
         updated_at = ?
     WHERE id = ?`
  ).bind(
    depositDateIso,
    normalizeText(payload?.depositReference, 140),
    depositedAmountCents,
    new Date().toISOString(),
    access.email,
    internalControlException,
    new Date().toISOString(),
    batchId
  ).run();

  await writeAudit(env, {
    batchId,
    eventType: 'batch_deposit',
    eventAction: 'deposit_confirmed',
    actorEmail: access.email,
    metadata: {
      batchId,
      depositedAmountCents,
      expectedBatchTotalCents: reconciliation.calculatedBatchTotalCents,
      internalControlException
    }
  });

  return {
    ok: true,
    internalControlException
  };
}

async function reopenOrVoidBatch(env, access, batchId, payload, { mode }) {
  const batch = await getBatch(env, batchId);
  if (!batch) return { error: financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.') };

  const reason = normalizeText(payload?.reason, 500);
  if (!reason) return { error: financeError(400, 'REASON_REQUIRED', 'A reason is required for this operation.') };

  const status = normalizeText(batch.status, 40).toLowerCase();

  if (mode === 'reopen') {
    if (!(status === 'verified' || status === 'deposited')) {
      return { error: financeError(409, 'INVALID_STATE', 'Only verified or deposited batches can be reopened.') };
    }

    await env.DB.prepare(
      `UPDATE finance_collection_batches
       SET status = 'counting',
           finalized_at = NULL,
           deposit_date = NULL,
           deposit_reference = NULL,
           deposited_amount_cents = NULL,
           deposit_confirmed_at = NULL,
           deposit_verified_by = NULL,
           updated_at = ?
       WHERE id = ?`
    ).bind(new Date().toISOString(), batchId).run();

    await invalidateApprovals(env, batchId, access.email, 'Batch was reopened.');
    await writeAudit(env, {
      batchId,
      eventType: 'batch',
      eventAction: 'reopened',
      actorEmail: access.email,
      reason,
      metadata: { batchId }
    });
    return { ok: true };
  }

  if (mode === 'void') {
    if (status === 'voided') return { ok: true };
    await env.DB.prepare(
      `UPDATE finance_collection_batches
       SET status = 'voided',
           voided_at = ?,
           voided_by = ?,
           void_reason = ?,
           updated_at = ?
       WHERE id = ?`
    ).bind(new Date().toISOString(), access.email, reason, new Date().toISOString(), batchId).run();

    await writeAudit(env, {
      batchId,
      eventType: 'batch',
      eventAction: 'voided',
      actorEmail: access.email,
      reason,
      metadata: { batchId }
    });
    return { ok: true };
  }

  return { error: financeError(400, 'INVALID_OPERATION', 'Unsupported operation.') };
}

async function donorHistory(env, donorId) {
  const donor = await env.DB.prepare('SELECT id, first_name, last_name, preferred_name FROM finance_donors WHERE id = ? LIMIT 1')
    .bind(donorId).first().catch(() => null);
  if (!donor?.id) return null;

  const stripeRows = await env.DB.prepare(
    `SELECT id, paid_at, fund_code, amount_cents, currency
     FROM giving_donations
     WHERE lower(coalesce(donor_email, '')) = lower((SELECT email FROM finance_donors WHERE id = ?))
       AND payment_status IN ('paid', 'checkout.session.completed', 'succeeded')`
  ).bind(donorId).all().catch(() => ({ results: [] }));

  const envelopeRows = await env.DB.prepare(
    `SELECT b.service_date, b.service_name, e.id AS entry_id, e.payment_method, e.check_number,
            a.fund_id, a.fund_code, a.amount_cents
     FROM finance_collection_envelopes e
     INNER JOIN finance_collection_batches b ON b.id = e.batch_id
     INNER JOIN finance_collection_allocations a ON a.envelope_entry_id = e.id
     WHERE e.donor_id = ? AND e.entry_status = 'active' AND b.status <> 'voided'
     ORDER BY b.service_date DESC, e.created_at DESC`
  ).bind(donorId).all().catch(() => ({ results: [] }));

  const history = [];

  for (const row of (stripeRows?.results || [])) {
    history.push({
      id: String(row.id || ''),
      date: String(row.paid_at || ''),
      fundCode: normalizeText(row.fund_code, 80),
      amountCents: Number(row.amount_cents || 0),
      currency: normalizeText(row.currency, 12) || 'usd',
      source: 'stripe',
      paymentMethod: 'card',
      checkNumber: ''
    });
  }

  for (const row of (envelopeRows?.results || [])) {
    history.push({
      id: String(row.entry_id || ''),
      date: String(row.service_date || ''),
      serviceName: normalizeText(row.service_name, 120),
      fundId: normalizeText(row.fund_id, 80),
      fundCode: normalizeText(row.fund_code, 80),
      amountCents: Number(row.amount_cents || 0),
      source: String(row.payment_method || '').toLowerCase() === 'check' ? 'check_envelope' : 'cash_envelope',
      paymentMethod: normalizeText(row.payment_method, 20),
      checkNumber: normalizeText(row.check_number, 60)
    });
  }

  history.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return {
    donor: {
      id: String(donor.id || ''),
      displayName: normalizeText(donor.preferred_name, 120) || `${normalizeText(donor.first_name, 120)} ${normalizeText(donor.last_name, 120)}`.trim()
    },
    history
  };
}

async function buildLabelSvg({ churchName, envelopeNumber, envelopeCode }) {
  const safeChurch = normalizeText(churchName || 'MMMBC', 80) || 'MMMBC';
  const safeNumber = normalizeText(envelopeNumber || '', 60);
  const safeCode = normalizeCode(envelopeCode);
  if (!safeCode) return '';

  const qrSvg = await QRCode.toString(safeCode, {
    type: 'svg',
    margin: 0,
    width: 160,
    color: { dark: '#000000', light: '#ffffff' }
  });

  const stripped = qrSvg
    .replace(/<\?xml[^>]*>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '')
    .replace(/<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="384" height="192" viewBox="0 0 384 192" role="img" aria-label="Envelope label">
  <rect x="0" y="0" width="384" height="192" fill="#fff" stroke="#000" stroke-width="2" />
  <text x="14" y="26" font-size="18" font-family="Arial, sans-serif" font-weight="700">${safeChurch}</text>
  <text x="14" y="52" font-size="14" font-family="Arial, sans-serif">Envelope #${safeNumber || 'Unassigned'}</text>
  <g transform="translate(14, 62)">${stripped}</g>
  <text x="188" y="94" font-size="12" font-family="Arial, sans-serif">Scan Code</text>
  <text x="188" y="118" font-size="11" font-family="Arial, sans-serif">${safeCode}</text>
  <text x="188" y="138" font-size="10" font-family="Arial, sans-serif">No personal data encoded.</text>
</svg>`;
}

async function createBatch(env, access, payload) {
  const serviceDate = normalizeDate(payload?.serviceDate);
  if (!serviceDate) return { error: financeError(400, 'INVALID_SERVICE_DATE', 'Service date is required.') };

  const declaredPhysicalCashCents = toCents(payload?.declaredPhysicalCashCents ?? payload?.declaredPhysicalCash ?? 0, { allowZero: true });
  const declaredCheckCents = toCents(payload?.declaredCheckCents ?? payload?.declaredChecks ?? 0, { allowZero: true });
  if (!Number.isInteger(declaredPhysicalCashCents) || declaredPhysicalCashCents < 0) {
    return { error: financeError(400, 'INVALID_DECLARED_CASH', 'Declared physical cash must be a nonnegative integer cents amount.') };
  }
  if (!Number.isInteger(declaredCheckCents) || declaredCheckCents < 0) {
    return { error: financeError(400, 'INVALID_DECLARED_CHECKS', 'Declared check total must be a nonnegative integer cents amount.') };
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO finance_collection_batches (
      id, service_date, service_name, status, declared_physical_cash_cents, declared_check_cents,
      calculated_envelope_total_cents, calculated_loose_cash_total_cents, calculated_batch_total_cents,
      discrepancy_cents, discrepancy_explanation, count_sheet_attachment_ref,
      created_by, created_at, updated_at, approval_version
    ) VALUES (?, ?, ?, 'draft', ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, 0)`
  ).bind(
    id,
    serviceDate,
    normalizeText(payload?.serviceName, 120),
    declaredPhysicalCashCents,
    declaredCheckCents,
    normalizeText(payload?.discrepancyExplanation, 500),
    normalizeText(payload?.countSheetAttachmentRef ?? payload?.attachment, 300),
    access.email,
    now,
    now
  ).run();

  await writeAudit(env, {
    batchId: id,
    eventType: 'batch',
    eventAction: 'created',
    actorEmail: access.email,
    metadata: {
      batchId: id,
      serviceDate,
      serviceName: normalizeText(payload?.serviceName, 120)
    }
  });

  return { id };
}

async function setBatchStatus(env, access, batchId, status) {
  const batch = await getBatch(env, batchId);
  if (!batch) return { error: financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.') };
  if (batchIsLocked(batch.status)) {
    return { error: financeError(409, 'BATCH_LOCKED', 'This batch is locked and cannot change state.') };
  }

  const next = normalizeText(status, 40).toLowerCase();
  if (!BATCH_STATUSES.has(next)) {
    return { error: financeError(400, 'INVALID_STATUS', 'Invalid batch status transition.') };
  }

  await env.DB.prepare('UPDATE finance_collection_batches SET status = ?, updated_at = ? WHERE id = ?')
    .bind(next, new Date().toISOString(), batchId).run();

  await writeAudit(env, {
    batchId,
    eventType: 'batch',
    eventAction: `status_${next}`,
    actorEmail: access.email,
    metadata: { batchId, status: next }
  });

  return { ok: true };
}

async function updateBatchMetadata(env, access, batchId, payload) {
  const batch = await getBatch(env, batchId);
  if (!batch) return { error: financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.') };

  const status = normalizeText(batch.status, 40).toLowerCase();
  if (batchIsLocked(status)) {
    return { error: financeError(409, 'BATCH_LOCKED', 'This batch is locked and cannot be edited.') };
  }

  const serviceDate = normalizeDate(payload?.serviceDate) || String(batch.service_date || '');
  if (!serviceDate) return { error: financeError(400, 'INVALID_SERVICE_DATE', 'Service date is required.') };

  const declaredPhysicalCashCents = payload?.declaredPhysicalCashCents == null
    ? Number(batch.declared_physical_cash_cents || 0)
    : toCents(payload?.declaredPhysicalCashCents, { allowZero: true });
  const declaredCheckCents = payload?.declaredCheckCents == null
    ? Number(batch.declared_check_cents || 0)
    : toCents(payload?.declaredCheckCents, { allowZero: true });

  if (!Number.isInteger(declaredPhysicalCashCents) || declaredPhysicalCashCents < 0) {
    return { error: financeError(400, 'INVALID_DECLARED_CASH', 'Declared physical cash must be nonnegative integer cents.') };
  }
  if (!Number.isInteger(declaredCheckCents) || declaredCheckCents < 0) {
    return { error: financeError(400, 'INVALID_DECLARED_CHECKS', 'Declared checks must be nonnegative integer cents.') };
  }

  await env.DB.prepare(
    `UPDATE finance_collection_batches
     SET service_date = ?,
         service_name = ?,
         declared_physical_cash_cents = ?,
         declared_check_cents = ?,
         discrepancy_explanation = ?,
         count_sheet_attachment_ref = ?,
         updated_at = ?
     WHERE id = ?`
  ).bind(
    serviceDate,
    normalizeText(payload?.serviceName, 120),
    declaredPhysicalCashCents,
    declaredCheckCents,
    normalizeText(payload?.discrepancyExplanation, 500),
    normalizeText(payload?.countSheetAttachmentRef, 300),
    new Date().toISOString(),
    batchId
  ).run();

  await recalcBatch(env, batchId);
  await writeAudit(env, {
    batchId,
    eventType: 'batch',
    eventAction: 'metadata_updated',
    actorEmail: access.email,
    metadata: {
      serviceDate,
      declaredPhysicalCashCents,
      declaredCheckCents
    }
  });

  return { ok: true };
}

function wantsLabelSvg(url) {
  return String(url.searchParams.get('format') || '').toLowerCase() === 'svg';
}

export const __financeTestHooks = {
  normalizeCode,
  toCents,
  parseAllocations,
  batchIsLocked,
  normalizeDate,
  normalizeEmail,
  resolveEnvelope,
  upsertEnvelopeEntry,
  finalizeBatch,
  confirmDeposit,
  donorHistory
};

export async function maybeHandleFinanceReconciliationRequest(request, env, ctx, requireSession) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (!(pathname.startsWith('/api/finances/donors') || pathname.startsWith('/api/finances/collections'))) {
    return null;
  }

  if (!env.DB) {
    return financeError(500, 'DB_NOT_CONFIGURED', 'D1 database is not configured.');
  }

  await ensureSchema(env);

  const user = await requireSession(request, env, ctx);
  const mutation = !['GET', 'HEAD'].includes(request.method);
  const auth = await requireFinanceUser(env, user, {
    mutation,
    permission: mutation ? 'canWrite' : 'canRead'
  });
  if (auth.error) return auth.error;
  const access = auth.access;

  if (pathname === '/api/finances/donors' && request.method === 'GET') {
    const data = await donorList(env, url.searchParams.get('q'));
    return json(data);
  }

  if (pathname === '/api/finances/donors' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    }

    const firstName = normalizeText(body.firstName, 120);
    const lastName = normalizeText(body.lastName, 120);
    if (!firstName || !lastName) {
      return financeError(400, 'REQUIRED_FIELDS', 'First and last name are required.');
    }

    const envelopeNumber = normalizeText(body.envelopeNumber, 60);
    if (envelopeNumber) {
      const duplicate = await env.DB.prepare(
        'SELECT id FROM finance_donors WHERE lower(coalesce(envelope_number, \"\")) = lower(?) LIMIT 1'
      ).bind(envelopeNumber).first().catch(() => null);
      if (duplicate?.id) {
        return financeError(409, 'DUPLICATE_ENVELOPE_NUMBER', 'Envelope number is already assigned to another donor.');
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO finance_donors (
        id, first_name, middle_name, last_name, preferred_name, household_id,
        mailing_address, email, phone, statement_delivery, active, statement_eligible,
        envelope_number, envelope_code, envelope_code_status, envelope_code_issued_at,
        envelope_code_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'inactive', NULL, NULL, ?, ?)`
    ).bind(
      id,
      firstName,
      normalizeText(body.middleName, 120),
      lastName,
      normalizeText(body.preferredName, 120),
      normalizeText(body.householdId, 120),
      normalizeText(body.mailingAddress, 500),
      normalizeEmail(body.email),
      normalizeText(body.phone, 80),
      normalizeText(body.preferredStatementDelivery || 'mail', 40) || 'mail',
      body.active === false ? 0 : 1,
      body.statementEligible === false ? 0 : 1,
      envelopeNumber,
      now,
      now
    ).run();

    await writeAudit(env, {
      donorId: id,
      eventType: 'donor',
      eventAction: 'created',
      actorEmail: access.email,
      metadata: { donorId: id }
    });

    return json({ ok: true, donorId: id }, 201);
  }

  if (/^\/api\/finances\/donors\/[^/]+$/.test(pathname) && request.method === 'PUT') {
    const donorId = decodeURIComponent(pathname.split('/')[4] || '');
    const donor = await env.DB.prepare('SELECT id FROM finance_donors WHERE id = ? LIMIT 1').bind(donorId).first().catch(() => null);
    if (!donor?.id) return financeError(404, 'DONOR_NOT_FOUND', 'Donor was not found.');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');

    const envelopeNumber = normalizeText(body.envelopeNumber, 60);
    if (envelopeNumber) {
      const duplicate = await env.DB.prepare(
        'SELECT id FROM finance_donors WHERE lower(coalesce(envelope_number, \"\")) = lower(?) AND id <> ? LIMIT 1'
      ).bind(envelopeNumber, donorId).first().catch(() => null);
      if (duplicate?.id) {
        return financeError(409, 'DUPLICATE_ENVELOPE_NUMBER', 'Envelope number is already assigned to another donor.');
      }
    }

    await env.DB.prepare(
      `UPDATE finance_donors
       SET envelope_number = ?,
           first_name = coalesce(?, first_name),
           middle_name = coalesce(?, middle_name),
           last_name = coalesce(?, last_name),
           preferred_name = coalesce(?, preferred_name),
           household_id = coalesce(?, household_id),
           mailing_address = coalesce(?, mailing_address),
           email = coalesce(?, email),
           phone = coalesce(?, phone),
           statement_delivery = coalesce(?, statement_delivery),
           active = ?,
           statement_eligible = ?,
           updated_at = ?
       WHERE id = ?`
    ).bind(
      envelopeNumber,
      normalizeText(body.firstName, 120) || null,
      normalizeText(body.middleName, 120) || null,
      normalizeText(body.lastName, 120) || null,
      normalizeText(body.preferredName, 120) || null,
      normalizeText(body.householdId, 120) || null,
      normalizeText(body.mailingAddress, 500) || null,
      normalizeEmail(body.email) || null,
      normalizeText(body.phone, 80) || null,
      normalizeText(body.preferredStatementDelivery, 40) || null,
      body.active === false ? 0 : 1,
      body.statementEligible === false ? 0 : 1,
      new Date().toISOString(),
      donorId
    ).run();

    await writeAudit(env, {
      donorId,
      eventType: 'donor',
      eventAction: 'updated',
      actorEmail: access.email,
      metadata: { donorId }
    });

    return json({ ok: true });
  }

  if (/^\/api\/finances\/donors\/[^/]+\/envelope-code\/(issue|replace|deactivate)$/.test(pathname) && request.method === 'POST') {
    if (!access.permissions.canManageEnvelopeCodes) {
      return financeError(403, 'FORBIDDEN', 'You do not have permission to manage envelope codes.');
    }

    const parts = pathname.split('/');
    const donorId = decodeURIComponent(parts[4] || '');
    const mode = normalizeText(parts[6], 20).toLowerCase();
    const body = await request.json().catch(() => ({}));
    const result = await setDonorEnvelopeCode(env, donorId, {
      mode,
      actorEmail: access.email,
      note: body?.reason || body?.note || ''
    });
    if (result?.error) return result.error;
    return json({ ok: true, envelope: result });
  }

  if (/^\/api\/finances\/donors\/[^/]+\/envelope-label$/.test(pathname) && request.method === 'GET') {
    const donorId = decodeURIComponent(pathname.split('/')[4] || '');
    const donor = await env.DB.prepare('SELECT id, envelope_number, envelope_code FROM finance_donors WHERE id = ? LIMIT 1')
      .bind(donorId).first().catch(() => null);
    if (!donor?.id) return financeError(404, 'DONOR_NOT_FOUND', 'Donor was not found.');

    if (wantsLabelSvg(url)) {
      const svg = await buildLabelSvg({
        churchName: 'MMMBC',
        envelopeNumber: donor.envelope_number,
        envelopeCode: donor.envelope_code
      });
      if (!svg) {
        return financeError(409, 'NO_ACTIVE_ENVELOPE_CODE', 'Donor must have an active envelope code before printing labels.');
      }
      return new Response(svg, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }

    return json({
      donorId,
      envelopeNumber: normalizeText(donor.envelope_number, 60),
      envelopeCode: normalizeText(donor.envelope_code, 120)
    });
  }

  if (/^\/api\/finances\/donors\/[^/]+\/history$/.test(pathname) && request.method === 'GET') {
    const donorId = decodeURIComponent(pathname.split('/')[4] || '');
    const history = await donorHistory(env, donorId);
    if (!history) return financeError(404, 'DONOR_NOT_FOUND', 'Donor was not found.');
    return json(history);
  }

  if (pathname === '/api/finances/collections' && request.method === 'GET') {
    return json({ batches: await listBatches(env, url) });
  }

  if (pathname === '/api/finances/collections' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    const result = await createBatch(env, access, body);
    if (result?.error) return result.error;
    return json({ ok: true, batchId: result.id }, 201);
  }

  if (pathname === '/api/finances/collections/resolve-envelope' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');

    const resolved = await resolveEnvelope(env, body.envelopeCode);
    if (resolved.status !== 200) {
      return financeError(resolved.status, 'ENVELOPE_NOT_RESOLVED', resolved.error, {
        donor: resolved.donor || null
      });
    }

    let duplicateEntry = null;
    const batchId = normalizeText(body.batchId, 80);
    if (batchId) {
      const row = await env.DB.prepare(
        `SELECT id, envelope_total_cents, payment_method
         FROM finance_collection_envelopes
         WHERE batch_id = ? AND envelope_code_snapshot = ? AND entry_status = 'active' LIMIT 1`
      ).bind(batchId, resolved.donor.envelopeCode).first().catch(() => null);
      if (row?.id) {
        duplicateEntry = {
          entryId: String(row.id || ''),
          amountCents: Number(row.envelope_total_cents || 0),
          paymentMethod: normalizeText(row.payment_method, 20)
        };
      }
    }

    return json({ donor: resolved.donor, duplicateEntry });
  }

  if (/^\/api\/finances\/collections\/[^/]+$/.test(pathname) && request.method === 'GET') {
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const detail = await getBatchDetails(env, batchId, access);
    if (!detail) return financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.');
    return json(detail);
  }

  if (/^\/api\/finances\/collections\/[^/]+$/.test(pathname) && request.method === 'PUT') {
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    const result = await updateBatchMetadata(env, access, batchId, body);
    if (result?.error) return result.error;
    return json(result);
  }

  if (/^\/api\/finances\/collections\/[^/]+\/start$/.test(pathname) && request.method === 'POST') {
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const result = await setBatchStatus(env, access, batchId, 'counting');
    if (result?.error) return result.error;
    return json({ ok: true });
  }

  if (/^\/api\/finances\/collections\/[^/]+\/submit-verification$/.test(pathname) && request.method === 'POST') {
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const result = await setBatchStatus(env, access, batchId, 'awaiting_verification');
    if (result?.error) return result.error;
    return json({ ok: true });
  }

  if (/^\/api\/finances\/collections\/[^/]+\/counters$/.test(pathname) && request.method === 'POST') {
    if (!access.permissions.canAssignCounters) {
      return financeError(403, 'FORBIDDEN', 'You do not have permission to assign counters.');
    }
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    const result = await assignCounters(env, access, batchId, body);
    if (result?.error) return result.error;
    return json({ ok: true, counters: result.counters });
  }

  if (/^\/api\/finances\/collections\/[^/]+\/envelopes$/.test(pathname) && request.method === 'POST') {
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    const result = await upsertEnvelopeEntry(env, access, batchId, body);
    if (result?.error) return result.error;
    return json({ ok: true, entryId: result.entryId, donor: result.donor, envelopeTotalCents: result.envelopeTotalCents });
  }

  if (/^\/api\/finances\/collections\/[^/]+\/loose-giving$/.test(pathname) && request.method === 'POST') {
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    const result = await addLooseGiving(env, access, batchId, body);
    if (result?.error) return result.error;
    return json({ ok: true, id: result.id, amountCents: result.amountCents });
  }

  if (/^\/api\/finances\/collections\/[^/]+\/reconciliation$/.test(pathname) && request.method === 'GET') {
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const batch = await getBatch(env, batchId);
    if (!batch) return financeError(404, 'BATCH_NOT_FOUND', 'Collection batch was not found.');
    const reconciliation = await recalcBatch(env, batchId);
    return json({ batchId, reconciliation });
  }

  if (/^\/api\/finances\/collections\/[^/]+\/approvals$/.test(pathname) && request.method === 'POST') {
    if (!access.permissions.canApprove) {
      return financeError(403, 'FORBIDDEN', 'You do not have permission to approve collection batches.');
    }
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const result = await submitCounterApproval(env, access, batchId);
    if (result?.error) return result.error;
    return json(result);
  }

  if (/^\/api\/finances\/collections\/[^/]+\/finalize$/.test(pathname) && request.method === 'POST') {
    if (!access.permissions.canFinalize) {
      return financeError(403, 'FORBIDDEN', 'You do not have permission to finalize collection batches.');
    }
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const body = await request.json().catch(() => ({}));
    const result = await finalizeBatch(env, access, batchId, body);
    if (result?.error) return result.error;
    return json(result);
  }

  if (/^\/api\/finances\/collections\/[^/]+\/deposit$/.test(pathname) && request.method === 'POST') {
    if (!access.permissions.canConfirmDeposit) {
      return financeError(403, 'FORBIDDEN', 'You do not have permission to confirm deposits.');
    }
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    const result = await confirmDeposit(env, access, batchId, body);
    if (result?.error) return result.error;
    return json(result);
  }

  if (/^\/api\/finances\/collections\/[^/]+\/reopen$/.test(pathname) && request.method === 'POST') {
    if (!access.permissions.canReopenOrVoid) {
      return financeError(403, 'FORBIDDEN', 'You do not have permission to reopen batches.');
    }
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    const result = await reopenOrVoidBatch(env, access, batchId, body, { mode: 'reopen' });
    if (result?.error) return result.error;
    return json(result);
  }

  if (/^\/api\/finances\/collections\/[^/]+\/void$/.test(pathname) && request.method === 'POST') {
    if (!access.permissions.canReopenOrVoid) {
      return financeError(403, 'FORBIDDEN', 'You do not have permission to void batches.');
    }
    const batchId = decodeURIComponent(pathname.split('/')[4] || '');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return financeError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    const result = await reopenOrVoidBatch(env, access, batchId, body, { mode: 'void' });
    if (result?.error) return result.error;
    return json(result);
  }

  return financeError(404, 'NOT_FOUND', 'Finance endpoint not found.');
}
