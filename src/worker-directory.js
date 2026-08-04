function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function fail(status, message) {
  return json({ error: String(message || 'Request failed.') }, status);
}

function nowIso() {
  return new Date().toISOString();
}

async function getSchemaTables(env) {
  if (!env.DB) return new Set();
  try {
    const rows = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
    return new Set((rows?.results || []).map((row) => String(row.name || '')));
  } catch {
    return new Set();
  }
}

async function getDirectorySchemaFlags(env) {
  const tables = await getSchemaTables(env);
  return {
    tables,
    hasContacts: tables.has('directory_contacts'),
    hasNewsletterSubscribers: tables.has('newsletter_subscribers'),
    hasDirectoryGroups: tables.has('directory_groups'),
    hasDirectoryGroupMembers: tables.has('directory_group_members'),
    hasNewsletterLists: tables.has('newsletter_lists'),
    hasNewsletterListMembers: tables.has('newsletter_list_members')
  };
}

async function safeCount(env, sql, params = []) {
  if (!env.DB) return 0;
  try {
    const row = await env.DB.prepare(sql).bind(...params).first();
    return Number(row?.c || row?.total || 0);
  } catch {
    return 0;
  }
}

function normalizeRole(input) {
  const value = String(input || '').trim().toLowerCase();
  if (!value) return 'administrator';
  if (value === 'admin') return 'administrator';
  if (value === 'finance') return 'finance_entry';
  return value.replace(/\s+/g, '_');
}

function rolePermissions(roleInput) {
  const role = normalizeRole(roleInput);
  if (role === 'administrator') {
    return {
      role,
      canReadBasic: true,
      canReadPrivate: true,
      canManageContacts: true,
      canArchiveContacts: true,
      canManageSubscribers: true,
      canManageGroups: true,
      canImportExport: true
    };
  }

  if (role === 'website_editor') {
    return {
      role,
      canReadBasic: true,
      canReadPrivate: false,
      canManageContacts: false,
      canArchiveContacts: false,
      canManageSubscribers: false,
      canManageGroups: false,
      canImportExport: false
    };
  }

  if (role === 'finance_entry' || role === 'treasurer' || role === 'auditor') {
    return {
      role,
      canReadBasic: true,
      canReadPrivate: false,
      canManageContacts: false,
      canArchiveContacts: false,
      canManageSubscribers: false,
      canManageGroups: false,
      canImportExport: false
    };
  }

  return {
    role,
    canReadBasic: true,
    canReadPrivate: false,
    canManageContacts: false,
    canArchiveContacts: false,
    canManageSubscribers: false,
    canManageGroups: false,
    canImportExport: false
  };
}

async function resolveDirectoryAccessContext(env, email) {
  const lowerEmail = String(email || '').trim().toLowerCase();
  let role = 'administrator';

  if (env.DB && lowerEmail) {
    try {
      const row = await env.DB.prepare(
        `SELECT role FROM admin_invites WHERE email = ? AND status = 'invited' LIMIT 1`
      ).bind(lowerEmail).first();
      if (row?.role) role = String(row.role);
    } catch {
      role = 'administrator';
    }
  }

  const permissions = rolePermissions(role);
  return {
    email: lowerEmail,
    role: permissions.role,
    permissions
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function cleanText(value, max = 255) {
  return String(value || '').trim().slice(0, max);
}

function normalizeAccountNumber(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  const alnum = raw.replace(/[^A-Z0-9]/g, '');
  if (!alnum) return '';
  if (alnum.startsWith('MM')) {
    const suffix = alnum.slice(2).slice(0, 18);
    return suffix ? `MM-${suffix}` : '';
  }
  return `MM-${alnum.slice(0, 18)}`;
}

function buildDirectoryAccountNumberSeed() {
  return `MM-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

function cleanStatus(value, fallback = 'active') {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!normalized) return fallback;
  return normalized;
}

function parseMonthDay(value, min, max) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const n = Math.floor(raw);
  if (n < min || n > max) return null;
  return n;
}

function parsePositiveInt(value, fallback, { min = 1, max = 100 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intVal = Math.floor(n);
  if (intVal < min) return min;
  if (intVal > max) return max;
  return intVal;
}

function isDirectoryContactActive(status) {
  return cleanStatus(status, 'active') !== 'archived';
}

function directoryContactDonorKind(contactType) {
  const normalized = normalizeContactType(contactType, 'member');
  return (normalized === 'visitor' || normalized === 'one_time_donor') ? 'one_time' : 'member';
}

function composeMailingAddress(payload) {
  return [
    payload.addressLine1,
    payload.addressLine2,
    [payload.city, payload.state].filter(Boolean).join(', '),
    payload.postalCode
  ].map((part) => cleanText(part, 180)).filter(Boolean).join(', ').slice(0, 500);
}

async function accountNumberExistsForContact(env, accountNumber, excludeContactId = '') {
  if (!env.DB || !accountNumber) return false;
  const row = await env.DB.prepare(
    `SELECT id FROM directory_contacts
     WHERE account_number = ? AND id <> ?
     LIMIT 1`
  ).bind(accountNumber, String(excludeContactId || '')).first().catch(() => null);
  return Boolean(row?.id);
}

async function ensureDirectoryAccountNumber(env, requestedValue, excludeContactId = '') {
  const normalized = normalizeAccountNumber(requestedValue);
  if (normalized) {
    if (await accountNumberExistsForContact(env, normalized, excludeContactId)) {
      throw new Error('That account number is already assigned to another directory contact.');
    }
    return normalized;
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = buildDirectoryAccountNumberSeed();
    if (!(await accountNumberExistsForContact(env, candidate, excludeContactId))) {
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique account number. Please try again.');
}

async function syncFinanceDonorForDirectoryContact(env, contactId, payload, actorEmail, { existingContactRow = null } = {}) {
  if (!env.DB || !contactId || !payload) return null;

  const now = nowIso();
  const accountNumber = normalizeAccountNumber(payload.accountNumber);
  const primaryEmail = normalizeEmail(payload.primaryEmail);
  const donorKind = directoryContactDonorKind(payload.contactType);
  const mailingAddress = composeMailingAddress(payload);
  const activeFlag = isDirectoryContactActive(payload.status) ? 1 : 0;
  const statementEligible = donorKind === 'one_time' ? 0 : 1;
  const phone = cleanText(payload.mobilePhone || payload.homePhone, 80);

  const linked = await env.DB.prepare(
    `SELECT * FROM finance_donors WHERE directory_contact_id = ? LIMIT 1`
  ).bind(contactId).first().catch(() => null);

  let candidate = linked;
  if (!candidate && accountNumber) {
    candidate = await env.DB.prepare(
      `SELECT * FROM finance_donors
       WHERE account_number = ?
       LIMIT 1`
    ).bind(accountNumber).first().catch(() => null);
  }

  if (!candidate && primaryEmail) {
    candidate = await env.DB.prepare(
      `SELECT * FROM finance_donors
       WHERE lower(coalesce(email, '')) = lower(?)
       LIMIT 1`
    ).bind(primaryEmail).first().catch(() => null);
  }

  if (!candidate && payload.firstName && payload.lastName) {
    const byName = await env.DB.prepare(
      `SELECT * FROM finance_donors
       WHERE lower(first_name) = lower(?)
         AND lower(last_name) = lower(?)
       ORDER BY created_at ASC`
    ).bind(payload.firstName, payload.lastName).all().catch(() => ({ results: [] }));
    if ((byName?.results || []).length === 1) candidate = byName.results[0];
  }

  if (candidate?.directory_contact_id && String(candidate.directory_contact_id) !== String(contactId)) {
    throw new Error('A linked finance donor already exists for a different directory contact. Resolve that donor link before saving this account number.');
  }

  if (candidate?.id) {
    await env.DB.prepare(
      `UPDATE finance_donors
       SET first_name = ?,
           middle_name = ?,
           last_name = ?,
           preferred_name = ?,
           mailing_address = ?,
           email = ?,
           phone = ?,
           active = ?,
           statement_eligible = ?,
           directory_contact_id = ?,
           account_number = ?,
           donor_kind = ?,
           updated_at = ?
       WHERE id = ?`
    ).bind(
      payload.firstName,
      payload.middleName || null,
      payload.lastName,
      payload.preferredName || null,
      mailingAddress || null,
      primaryEmail || null,
      phone || null,
      activeFlag,
      statementEligible,
      contactId,
      accountNumber || null,
      donorKind,
      now,
      String(candidate.id)
    ).run();

    await logDirectoryActivity(env, {
      actorEmail,
      eventType: 'finance_donor_synced',
      entityType: 'contact',
      entityId: String(contactId),
      summary: 'Linked finance donor synchronized from directory contact.',
      metadata: {
        donorId: String(candidate.id),
        accountNumber
      }
    });

    return String(candidate.id);
  }

  const donorId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO finance_donors (
      id, first_name, middle_name, last_name, preferred_name,
      household_id, mailing_address, email, phone, statement_delivery,
      active, statement_eligible, directory_contact_id, account_number,
      donor_kind, merged_into_donor_id,
      envelope_number, envelope_code, envelope_code_status,
      envelope_code_issued_at, envelope_code_updated_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mail', ?, ?, ?, ?, ?, NULL, NULL, '', 'inactive', NULL, NULL, ?, ?)`
  ).bind(
    donorId,
    payload.firstName,
    payload.middleName || null,
    payload.lastName,
    payload.preferredName || null,
    null,
    mailingAddress || null,
    primaryEmail || null,
    phone || null,
    activeFlag,
    statementEligible,
    contactId,
    accountNumber || null,
    donorKind,
    existingContactRow?.created_at || now,
    now
  ).run();

  await logDirectoryActivity(env, {
    actorEmail,
    eventType: 'finance_donor_created',
    entityType: 'contact',
    entityId: String(contactId),
    summary: 'Finance donor created from directory contact.',
    metadata: {
      donorId,
      accountNumber
    }
  });

  return donorId;
}

const DEFAULT_CONTACT_TYPES = [
  'member',
  'visitor',
  'one_time_donor',
  'repeat_donor',
  'sponsor',
  'volunteer',
  'staff',
  'ministry_leader',
  'other'
];

function normalizeContactType(value, fallback = 'member') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

async function listDirectoryContactTypes(env) {
  if (!env?.DB) return [...DEFAULT_CONTACT_TYPES];

  try {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT lower(trim(contact_type)) AS contact_type
       FROM directory_contacts
       WHERE trim(coalesce(contact_type, '')) != ''`
    ).all();

    const discovered = (rows?.results || [])
      .map((row) => normalizeContactType(row?.contact_type, ''))
      .filter(Boolean);

    const merged = [...new Set([...DEFAULT_CONTACT_TYPES, ...discovered])];
    return merged.sort((a, b) => a.localeCompare(b));
  } catch {
    return [...DEFAULT_CONTACT_TYPES];
  }
}

function paginationFromRequest(url, defaultPageSize = 25) {
  const page = parsePositiveInt(url.searchParams.get('page'), 1, { min: 1, max: 1000000 });
  const pageSize = parsePositiveInt(url.searchParams.get('pageSize'), defaultPageSize, { min: 1, max: 100 });
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

function hasSubscriberWritePermission(ctx) {
  return Boolean(ctx?.permissions?.canManageSubscribers);
}

function hasContactsWritePermission(ctx) {
  return Boolean(ctx?.permissions?.canManageContacts);
}

function hasContactsReadPermission(ctx) {
  return Boolean(ctx?.permissions?.canReadBasic);
}

function hasGroupsWritePermission(ctx) {
  return Boolean(ctx?.permissions?.canManageGroups);
}

async function logDirectoryActivity(env, {
  actorEmail,
  eventType,
  entityType,
  entityId,
  summary,
  metadata = null
} = {}) {
  if (!env.DB) return;

  const safeSummary = cleanText(summary, 280);
  const safeMetadata = metadata && typeof metadata === 'object' ? JSON.stringify(metadata).slice(0, 1400) : null;

  try {
    await env.DB.prepare(
      `INSERT INTO directory_activity_log (id, actor_email, event_type, entity_type, entity_id, summary, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      cleanText(actorEmail, 254).toLowerCase(),
      cleanText(eventType, 80),
      cleanText(entityType, 60),
      cleanText(entityId, 80),
      safeSummary,
      safeMetadata,
      nowIso()
    ).run();
  } catch {
    // Logging must never break the main API flow.
  }
}

function contactSelectColumns(includePrivate, schema = {}) {
  const cols = [
    'c.id',
    'c.first_name',
    'c.last_name',
    'c.preferred_name',
    'c.contact_type',
    'c.membership_status',
    'c.status',
    'c.account_number',
    'c.primary_email',
    'c.mobile_phone',
    'c.home_phone',
    'c.preferred_contact_method',
    'c.birth_month',
    'c.birth_day',
    'c.anniversary_month',
    'c.anniversary_day',
    'c.member_since',
    'c.created_at',
    'c.updated_at'
  ];

  if (schema.hasNewsletterSubscribers) {
    cols.push(
      `(SELECT ns.status FROM newsletter_subscribers ns WHERE ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email)) ORDER BY CASE WHEN ns.contact_id = c.id THEN 0 ELSE 1 END, ns.updated_at DESC LIMIT 1) AS newsletter_status`,
      `(SELECT ns.email FROM newsletter_subscribers ns WHERE ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email)) ORDER BY CASE WHEN ns.contact_id = c.id THEN 0 ELSE 1 END, ns.updated_at DESC LIMIT 1) AS newsletter_email`,
      `(SELECT ns.consent_source FROM newsletter_subscribers ns WHERE ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email)) ORDER BY CASE WHEN ns.contact_id = c.id THEN 0 ELSE 1 END, ns.updated_at DESC LIMIT 1) AS newsletter_consent_source`,
      `(SELECT ns.consent_date FROM newsletter_subscribers ns WHERE ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email)) ORDER BY CASE WHEN ns.contact_id = c.id THEN 0 ELSE 1 END, ns.updated_at DESC LIMIT 1) AS newsletter_consent_date`,
      `(SELECT ns.confirmed_at FROM newsletter_subscribers ns WHERE ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email)) ORDER BY CASE WHEN ns.contact_id = c.id THEN 0 ELSE 1 END, ns.updated_at DESC LIMIT 1) AS newsletter_confirmed_at`,
      `(SELECT ns.unsubscribed_at FROM newsletter_subscribers ns WHERE ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email)) ORDER BY CASE WHEN ns.contact_id = c.id THEN 0 ELSE 1 END, ns.updated_at DESC LIMIT 1) AS newsletter_unsubscribed_at`
    );
  } else {
    cols.push(
      'NULL AS newsletter_status',
      'NULL AS newsletter_email',
      'NULL AS newsletter_consent_source',
      'NULL AS newsletter_consent_date',
      'NULL AS newsletter_confirmed_at',
      'NULL AS newsletter_unsubscribed_at'
    );
  }

  if (schema.hasDirectoryGroups && schema.hasDirectoryGroupMembers) {
    cols.push(
      '(SELECT gm.role FROM directory_group_members gm WHERE gm.contact_id = c.id AND gm.ended_at IS NULL ORDER BY gm.joined_at DESC LIMIT 1) AS ministry_role',
      '(SELECT g.name FROM directory_group_members gm JOIN directory_groups g ON g.id = gm.group_id WHERE gm.contact_id = c.id AND gm.ended_at IS NULL ORDER BY gm.joined_at DESC LIMIT 1) AS ministry_group'
    );
  } else {
    cols.push('NULL AS ministry_role', 'NULL AS ministry_group');
  }

  if (includePrivate) {
    cols.push(
      'c.secondary_email',
      'c.address_line_1',
      'c.address_line_2',
      'c.city',
      'c.state',
      'c.postal_code',
      'c.notes'
    );
  }

  return cols.join(',\n    ');
}

function mapContactRow(row, { includePrivate = false } = {}) {
  const out = {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    preferredName: row.preferred_name,
    contactType: row.contact_type,
    membershipStatus: row.membership_status,
    status: row.status,
    accountNumber: row.account_number || '',
    primaryEmail: row.primary_email,
    mobilePhone: row.mobile_phone,
    homePhone: row.home_phone,
    preferredContactMethod: row.preferred_contact_method,
    birthMonth: row.birth_month,
    birthDay: row.birth_day,
    anniversaryMonth: row.anniversary_month,
    anniversaryDay: row.anniversary_day,
    memberSince: row.member_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ministry: row.ministry_group,
    leadershipRole: row.ministry_role,
    newsletterStatus: row.newsletter_status || 'not_subscribed',
    newsletter: {
      status: row.newsletter_status || 'not_subscribed',
      email: row.newsletter_email || '',
      consentSource: row.newsletter_consent_source || '',
      consentDate: row.newsletter_consent_date || '',
      confirmedAt: row.newsletter_confirmed_at || '',
      unsubscribedAt: row.newsletter_unsubscribed_at || ''
    }
  };

  if (includePrivate) {
    out.secondaryEmail = row.secondary_email || '';
    out.addressLine1 = row.address_line_1 || '';
    out.addressLine2 = row.address_line_2 || '';
    out.city = row.city || '';
    out.state = row.state || '';
    out.postalCode = row.postal_code || '';
    out.notes = row.notes || '';
    out.address = [row.address_line_1, row.address_line_2, row.city, row.state, row.postal_code]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(', ');
  }

  return out;
}

function buildContactsWhere(url, schema = {}) {
  const clauses = [];
  const params = [];

  const status = cleanStatus(url.searchParams.get('status'), 'all');
  if (status === 'archived') {
    clauses.push('c.archived_at IS NOT NULL');
  } else {
    clauses.push('c.archived_at IS NULL');
    if (status !== 'all') {
      clauses.push('lower(c.status) = ?');
      params.push(status);
    }
  }

  const contactType = normalizeContactType(url.searchParams.get('contactType'), 'all');
  if (contactType !== 'all') {
    clauses.push('lower(c.contact_type) = ?');
    params.push(contactType);
  }

  const q = cleanText(url.searchParams.get('q'), 120).toLowerCase();
  if (q) {
    const like = `%${q}%`;
    clauses.push(`(
      lower(c.first_name) LIKE ?
      OR lower(c.last_name) LIKE ?
      OR lower(c.preferred_name) LIKE ?
      OR lower(c.primary_email) LIKE ?
      OR lower(c.secondary_email) LIKE ?
      OR lower(coalesce(c.account_number, '')) LIKE ?
      OR replace(replace(replace(replace(coalesce(c.mobile_phone, ''), '-', ''), '(', ''), ')', ''), ' ', '') LIKE ?
      OR replace(replace(replace(replace(coalesce(c.home_phone, ''), '-', ''), '(', ''), ')', ''), ' ', '') LIKE ?
    )`);
    params.push(like, like, like, like, like, like, `%${normalizePhone(q)}%`, `%${normalizePhone(q)}%`);
  }

  const newsletterStatus = cleanStatus(url.searchParams.get('newsletterStatus'), 'all');
  if (schema.hasNewsletterSubscribers && newsletterStatus === 'subscribed') {
    clauses.push(`EXISTS (
      SELECT 1 FROM newsletter_subscribers ns
      WHERE (ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email)))
      AND lower(ns.status) = 'active'
    )`);
  } else if (schema.hasNewsletterSubscribers && newsletterStatus === 'pending') {
    clauses.push(`EXISTS (
      SELECT 1 FROM newsletter_subscribers ns
      WHERE (ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email)))
      AND lower(ns.status) = 'pending'
    )`);
  } else if (schema.hasNewsletterSubscribers && newsletterStatus === 'unsubscribed') {
    clauses.push(`EXISTS (
      SELECT 1 FROM newsletter_subscribers ns
      WHERE (ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email)))
      AND lower(ns.status) IN ('unsubscribed','suppressed','complained','bounced')
    )`);
  } else if (schema.hasNewsletterSubscribers && newsletterStatus === 'not_subscribed') {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM newsletter_subscribers ns
      WHERE ns.contact_id = c.id OR (ns.contact_id IS NULL AND lower(ns.email) = lower(c.primary_email))
    )`);
  }

  const missing = cleanStatus(url.searchParams.get('missing'), 'all');
  if (missing === 'missing_email') {
    clauses.push(`(trim(coalesce(c.primary_email, '')) = '')`);
  } else if (missing === 'missing_phone') {
    clauses.push(`(trim(coalesce(c.mobile_phone, '')) = '' AND trim(coalesce(c.home_phone, '')) = '')`);
  } else if (missing === 'missing_both') {
    clauses.push(`(trim(coalesce(c.primary_email, '')) = '' AND trim(coalesce(c.mobile_phone, '')) = '' AND trim(coalesce(c.home_phone, '')) = '')`);
  }

  const groupId = cleanText(url.searchParams.get('groupId'), 80);
  if (schema.hasDirectoryGroupMembers && groupId && groupId !== 'all') {
    clauses.push(`EXISTS (
      SELECT 1 FROM directory_group_members gm
      WHERE gm.contact_id = c.id AND gm.group_id = ? AND gm.ended_at IS NULL
    )`);
    params.push(groupId);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

async function handleDirectoryOverview(request, env, authCtx) {
  if (!hasContactsReadPermission(authCtx)) return fail(403, 'Directory access is not allowed for this role.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const monthPrefix = nowIso().slice(0, 7);
  const schema = await getDirectorySchemaFlags(env);

  const activeContacts = schema.hasContacts
    ? await safeCount(env, `SELECT COUNT(*) AS c FROM directory_contacts WHERE archived_at IS NULL AND lower(status) = 'active'`)
    : 0;
  const activeSubscribers = schema.hasNewsletterSubscribers
    ? await safeCount(env, `SELECT COUNT(*) AS c FROM newsletter_subscribers WHERE lower(status) = 'active'`)
    : 0;
  const missingInfo = schema.hasContacts
    ? await safeCount(env, `
        SELECT COUNT(*) AS c
        FROM directory_contacts
        WHERE archived_at IS NULL
          AND (
            trim(coalesce(primary_email, '')) = ''
            OR (trim(coalesce(mobile_phone, '')) = '' AND trim(coalesce(home_phone, '')) = '')
          )
      `)
    : 0;
  const newThisMonth = schema.hasContacts
    ? await safeCount(env, `SELECT COUNT(*) AS c FROM directory_contacts WHERE substr(created_at, 1, 7) = ?`, [monthPrefix])
    : 0;

  return json({
    summary: {
      activeContacts,
      activeSubscribers,
      missingInfo,
      newContactsThisMonth: newThisMonth
    },
    permissions: authCtx.permissions
  });
}

async function handleDirectoryContactsList(request, env, authCtx) {
  if (!hasContactsReadPermission(authCtx)) return fail(403, 'Directory access is not allowed for this role.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const url = new URL(request.url);
  const pagination = paginationFromRequest(url, 25);
  const schema = await getDirectorySchemaFlags(env);
  if (!schema.hasContacts) {
    const fallbackTypes = [...DEFAULT_CONTACT_TYPES];
    return json({
      items: [],
      pagination: { page: pagination.page, pageSize: pagination.pageSize, total: 0, totalPages: 0 },
      filters: {
        statuses: ['active', 'inactive', 'archived'],
        types: fallbackTypes,
        groups: []
      }
    });
  }

  const whereData = buildContactsWhere(url, schema);
  const includePrivate = Boolean(authCtx.permissions.canReadPrivate);

  try {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM directory_contacts c ${whereData.where}`
    ).bind(...whereData.params).first();

    const rows = await env.DB.prepare(
      `SELECT ${contactSelectColumns(includePrivate)}
       FROM directory_contacts c
       ${whereData.where}
       ORDER BY c.updated_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...whereData.params, pagination.pageSize, pagination.offset).all();

    const groupRows = schema.hasDirectoryGroups
      ? await env.DB.prepare(
        `SELECT id, name FROM directory_groups WHERE lower(status) != 'archived' ORDER BY name ASC`
      ).all()
      : { results: [] };

    const total = Number(countRow?.total || 0);
    const totalPages = total > 0 ? Math.ceil(total / pagination.pageSize) : 0;

    const contactTypes = await listDirectoryContactTypes(env);

    return json({
      items: (rows?.results || []).map((row) => mapContactRow(row, { includePrivate })),
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
        totalPages
      },
      filters: {
        statuses: ['active', 'inactive', 'archived'],
        types: contactTypes,
        groups: (groupRows?.results || []).map((row) => ({ id: row.id, name: row.name }))
      }
    });
  } catch {
    return fail(500, 'Unable to load directory contacts.');
  }
}

async function handleDirectoryContactGet(request, env, authCtx, contactId) {
  if (!hasContactsReadPermission(authCtx)) return fail(403, 'Directory access is not allowed for this role.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const includePrivate = Boolean(authCtx.permissions.canReadPrivate);

  try {
    const row = await env.DB.prepare(
      `SELECT ${contactSelectColumns(includePrivate)}
       FROM directory_contacts c
       WHERE c.id = ?
       LIMIT 1`
    ).bind(String(contactId || '')).first();

    if (!row) return fail(404, 'Contact not found.');

    const item = mapContactRow(row, { includePrivate });

    if (includePrivate) {
      const activityRows = await env.DB.prepare(
        `SELECT event_type, summary, created_at
         FROM directory_activity_log
         WHERE entity_type = 'contact' AND entity_id = ?
         ORDER BY created_at DESC
         LIMIT 8`
      ).bind(String(contactId || '')).all();

      item.recentActivity = (activityRows?.results || []).map((entry) => ({
        title: entry.summary || entry.event_type || 'Update',
        at: entry.created_at || ''
      }));
    } else {
      item.notes = '';
      item.address = '';
      item.recentActivity = [];
    }

    return json({ item });
  } catch {
    return fail(500, 'Unable to load contact details.');
  }
}

function validateContactPayload(body) {
  const firstName = cleanText(body?.firstName || body?.first_name, 120);
  const lastName = cleanText(body?.lastName || body?.last_name, 120);
  const contactType = normalizeContactType(body?.contactType || body?.contact_type, 'member');
  const status = cleanStatus(body?.status, 'active');

  if (!firstName) return { ok: false, error: 'First name is required.' };
  if (!lastName) return { ok: false, error: 'Last name is required.' };
  if (!contactType) return { ok: false, error: 'Contact type is required.' };
  if (!status) return { ok: false, error: 'Status is required.' };

  const newsletterStatus = cleanStatus(body?.newsletter?.status || body?.newsletterStatus, 'not_subscribed');
  if (newsletterStatus === 'subscribed') {
    const email = normalizeEmail(body?.primaryEmail || body?.primary_email);
    const consentSource = cleanStatus(body?.newsletter?.consentSource || body?.consentSource, '');
    const consentDate = cleanText(body?.newsletter?.consentDate || body?.consentDate, 40);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: 'Subscribed with recorded consent requires a valid email.' };
    }
    if (!consentSource) return { ok: false, error: 'Consent source is required for subscribed contacts.' };
    if (!consentDate) return { ok: false, error: 'Consent date is required for subscribed contacts.' };
  }

  return {
    ok: true,
    payload: {
      firstName,
      middleName: cleanText(body?.middleName || body?.middle_name, 120),
      lastName,
      preferredName: cleanText(body?.preferredName || body?.preferred_name, 120),
      suffix: cleanText(body?.suffix, 32),
      contactType,
      membershipStatus: cleanText(body?.membershipStatus || body?.membership_status, 80),
      status,
      accountNumber: normalizeAccountNumber(body?.accountNumber || body?.account_number || body?.member_number || body?.donor_number || body?.account_id),
      primaryEmail: normalizeEmail(body?.primaryEmail || body?.primary_email),
      secondaryEmail: normalizeEmail(body?.secondaryEmail || body?.secondary_email),
      mobilePhone: cleanText(body?.mobilePhone || body?.mobile_phone, 40),
      homePhone: cleanText(body?.homePhone || body?.home_phone, 40),
      preferredContactMethod: cleanStatus(body?.preferredContactMethod || body?.preferred_contact_method, ''),
      addressLine1: cleanText(body?.addressLine1 || body?.address_line_1, 180),
      addressLine2: cleanText(body?.addressLine2 || body?.address_line_2, 180),
      city: cleanText(body?.city, 120),
      state: cleanText(body?.state, 120),
      postalCode: cleanText(body?.postalCode || body?.postal_code, 30),
      birthMonth: parseMonthDay(body?.birthMonth || body?.birth_month, 1, 12),
      birthDay: parseMonthDay(body?.birthDay || body?.birth_day, 1, 31),
      anniversaryMonth: parseMonthDay(body?.anniversaryMonth || body?.anniversary_month, 1, 12),
      anniversaryDay: parseMonthDay(body?.anniversaryDay || body?.anniversary_day, 1, 31),
      memberSince: cleanText(body?.memberSince || body?.member_since, 30),
      notes: cleanText(body?.notes, 2500),
      newsletter: {
        status: cleanStatus(body?.newsletter?.status || body?.newsletterStatus, 'not_subscribed'),
        consentSource: cleanStatus(body?.newsletter?.consentSource || body?.consentSource, ''),
        consentDate: cleanText(body?.newsletter?.consentDate || body?.consentDate, 30)
      }
    }
  };
}

async function upsertNewsletterFromContact(env, contactId, payload, actorEmail, { isCreate = false, allowReactivate = false } = {}) {
  if (!env.DB) return;

  const newsletterStatus = cleanStatus(payload?.newsletter?.status, 'not_subscribed');
  if (newsletterStatus === 'not_subscribed') return;

  const now = nowIso();
  const email = normalizeEmail(payload?.primaryEmail);
  if (!email) {
    if (newsletterStatus === 'subscribed') {
      throw new Error('Subscribed contacts require an email address.');
    }
    return;
  }

  const existing = await env.DB.prepare(
    `SELECT id, status FROM newsletter_subscribers WHERE lower(email) = ? LIMIT 1`
  ).bind(email).first();

  const suppressStates = new Set(['unsubscribed', 'suppressed', 'bounced', 'complained']);
  const desiredMap = {
    subscribed: 'active',
    pending: 'pending',
    unsubscribed: 'unsubscribed'
  };
  const desired = desiredMap[newsletterStatus] || 'pending';

  if (existing && suppressStates.has(cleanStatus(existing.status)) && (desired === 'active' || desired === 'pending') && !allowReactivate) {
    throw new Error('This subscriber is currently unsubscribed or suppressed and cannot be reactivated without confirmation.');
  }

  const consentSource = cleanStatus(payload?.newsletter?.consentSource, '');
  const consentDate = cleanText(payload?.newsletter?.consentDate, 30);
  const confirmedAt = desired === 'active' ? now : null;
  const unsubscribedAt = desired === 'unsubscribed' ? now : null;

  if (existing) {
    await env.DB.prepare(
      `UPDATE newsletter_subscribers
       SET contact_id = ?,
           status = ?,
           consent_source = ?,
           consent_date = ?,
           confirmed_at = CASE WHEN ? = 'active' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
           unsubscribed_at = CASE WHEN ? = 'unsubscribed' THEN COALESCE(unsubscribed_at, ?) ELSE unsubscribed_at END,
           suppression_reason = CASE WHEN ? IN ('suppressed','bounced','complained') THEN COALESCE(suppression_reason, ?) ELSE suppression_reason END,
           updated_at = ?
       WHERE id = ?`
    ).bind(
      contactId,
      desired,
      consentSource || null,
      consentDate || null,
      desired,
      confirmedAt,
      desired,
      unsubscribedAt,
      desired,
      desired,
      now,
      existing.id
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO newsletter_subscribers (
        id, contact_id, email, status, consent_source, consent_date, confirmed_at, unsubscribed_at, suppression_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      contactId,
      email,
      desired,
      consentSource || null,
      consentDate || null,
      confirmedAt,
      unsubscribedAt,
      desired,
      now,
      now
    ).run();
  }

  await logDirectoryActivity(env, {
    actorEmail,
    eventType: isCreate ? 'subscriber_added' : 'subscriber_updated',
    entityType: 'subscriber',
    entityId: contactId,
    summary: desired === 'active' ? 'Subscriber active' : `Subscriber status set to ${desired}`,
    metadata: { status: desired }
  });
}

async function handleDirectoryContactCreate(request, env, authCtx) {
  if (!hasContactsWritePermission(authCtx)) return fail(403, 'You do not have permission to create contacts.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail(400, 'Invalid contact payload.');

  const validated = validateContactPayload(body);
  if (!validated.ok) return fail(400, validated.error);
  const payload = validated.payload;

  const id = crypto.randomUUID();
  const now = nowIso();

  try {
    const accountNumber = await ensureDirectoryAccountNumber(env, payload.accountNumber, '');
    await env.DB.prepare(
      `INSERT INTO directory_contacts (
        id, first_name, middle_name, last_name, preferred_name, suffix,
        contact_type, membership_status, status,
        account_number,
        primary_email, secondary_email, mobile_phone, home_phone, preferred_contact_method,
        address_line_1, address_line_2, city, state, postal_code,
        birth_month, birth_day, anniversary_month, anniversary_day,
        member_since, notes,
        created_by, updated_by, created_at, updated_at, archived_at,
        normalized_primary_phone, normalized_home_phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      payload.firstName,
      payload.middleName || null,
      payload.lastName,
      payload.preferredName || null,
      payload.suffix || null,
      payload.contactType,
      payload.membershipStatus || null,
      payload.status,
      accountNumber,
      payload.primaryEmail || null,
      payload.secondaryEmail || null,
      payload.mobilePhone || null,
      payload.homePhone || null,
      payload.preferredContactMethod || null,
      payload.addressLine1 || null,
      payload.addressLine2 || null,
      payload.city || null,
      payload.state || null,
      payload.postalCode || null,
      payload.birthMonth,
      payload.birthDay,
      payload.anniversaryMonth,
      payload.anniversaryDay,
      payload.memberSince || null,
      payload.notes || null,
      authCtx.email || null,
      authCtx.email || null,
      now,
      now,
      payload.status === 'archived' ? now : null,
      normalizePhone(payload.mobilePhone) || null,
      normalizePhone(payload.homePhone) || null
    ).run();

    payload.accountNumber = accountNumber;

    await upsertNewsletterFromContact(env, id, payload, authCtx.email, {
      isCreate: true,
      allowReactivate: Boolean(body?.reactivateConfirmed)
    });

    await syncFinanceDonorForDirectoryContact(env, id, payload, authCtx.email, {
      existingContactRow: { created_at: now }
    });

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'contact_created',
      entityType: 'contact',
      entityId: id,
      summary: 'Directory contact created',
      metadata: {
        status: payload.status,
        contactType: payload.contactType
      }
    });

    return json({ ok: true, id }, 201);
  } catch (error) {
    const message = String(error?.message || 'Unable to save contact.');
    if (message.toLowerCase().includes('suppressed') || message.toLowerCase().includes('reactivate')) {
      return fail(409, message);
    }
    return fail(500, 'Unable to save contact.');
  }
}

async function handleDirectoryContactUpdate(request, env, authCtx, contactId) {
  if (!hasContactsWritePermission(authCtx)) return fail(403, 'You do not have permission to update contacts.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail(400, 'Invalid contact payload.');

  const validated = validateContactPayload(body);
  if (!validated.ok) return fail(400, validated.error);
  const payload = validated.payload;

  const now = nowIso();

  try {
    const existing = await env.DB.prepare(
      `SELECT id, created_at FROM directory_contacts WHERE id = ? LIMIT 1`
    ).bind(String(contactId || '')).first();
    if (!existing) return fail(404, 'Contact not found.');

    const accountNumber = await ensureDirectoryAccountNumber(env, payload.accountNumber, String(contactId || ''));

    await env.DB.prepare(
      `UPDATE directory_contacts
       SET first_name = ?,
           middle_name = ?,
           last_name = ?,
           preferred_name = ?,
           suffix = ?,
           contact_type = ?,
           membership_status = ?,
           status = ?,
           account_number = ?,
           primary_email = ?,
           secondary_email = ?,
           mobile_phone = ?,
           home_phone = ?,
           preferred_contact_method = ?,
           address_line_1 = ?,
           address_line_2 = ?,
           city = ?,
           state = ?,
           postal_code = ?,
           birth_month = ?,
           birth_day = ?,
           anniversary_month = ?,
           anniversary_day = ?,
           member_since = ?,
           notes = ?,
           updated_by = ?,
           updated_at = ?,
           archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, ?) ELSE archived_at END,
           normalized_primary_phone = ?,
           normalized_home_phone = ?
       WHERE id = ?`
    ).bind(
      payload.firstName,
      payload.middleName || null,
      payload.lastName,
      payload.preferredName || null,
      payload.suffix || null,
      payload.contactType,
      payload.membershipStatus || null,
      payload.status,
      accountNumber,
      payload.primaryEmail || null,
      payload.secondaryEmail || null,
      payload.mobilePhone || null,
      payload.homePhone || null,
      payload.preferredContactMethod || null,
      payload.addressLine1 || null,
      payload.addressLine2 || null,
      payload.city || null,
      payload.state || null,
      payload.postalCode || null,
      payload.birthMonth,
      payload.birthDay,
      payload.anniversaryMonth,
      payload.anniversaryDay,
      payload.memberSince || null,
      payload.notes || null,
      authCtx.email || null,
      now,
      payload.status,
      now,
      normalizePhone(payload.mobilePhone) || null,
      normalizePhone(payload.homePhone) || null,
      String(contactId || '')
    ).run();

    payload.accountNumber = accountNumber;

    await upsertNewsletterFromContact(env, String(contactId || ''), payload, authCtx.email, {
      isCreate: false,
      allowReactivate: Boolean(body?.reactivateConfirmed)
    });

    await syncFinanceDonorForDirectoryContact(env, String(contactId || ''), payload, authCtx.email, {
      existingContactRow: existing
    });

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'contact_updated',
      entityType: 'contact',
      entityId: String(contactId || ''),
      summary: 'Directory contact updated',
      metadata: {
        status: payload.status,
        contactType: payload.contactType
      }
    });

    return json({ ok: true, id: String(contactId || '') });
  } catch (error) {
    const message = String(error?.message || 'Unable to update contact.');
    if (message.toLowerCase().includes('suppressed') || message.toLowerCase().includes('reactivate')) {
      return fail(409, message);
    }
    return fail(500, 'Unable to update contact.');
  }
}

async function handleDirectoryContactArchive(request, env, authCtx, contactId) {
  if (!authCtx?.permissions?.canArchiveContacts) return fail(403, 'You do not have permission to archive contacts.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  try {
    const existing = await env.DB.prepare(`SELECT id FROM directory_contacts WHERE id = ? LIMIT 1`)
      .bind(String(contactId || '')).first();
    if (!existing) return fail(404, 'Contact not found.');

    const now = nowIso();
    await env.DB.prepare(
      `UPDATE directory_contacts
       SET status = 'archived', archived_at = COALESCE(archived_at, ?), updated_at = ?, updated_by = ?
       WHERE id = ?`
    ).bind(now, now, authCtx.email || null, String(contactId || '')).run();

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'contact_archived',
      entityType: 'contact',
      entityId: String(contactId || ''),
      summary: 'Directory contact archived'
    });

    return json({ ok: true, id: String(contactId || '') });
  } catch {
    return fail(500, 'Unable to archive contact.');
  }
}

async function handleDirectoryContactDuplicateCheck(request, env, authCtx) {
  if (!hasContactsReadPermission(authCtx)) return fail(403, 'Directory access is not allowed for this role.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail(400, 'Invalid duplicate-check request.');

  const firstName = cleanText(body?.firstName || body?.first_name, 120).toLowerCase();
  const lastName = cleanText(body?.lastName || body?.last_name, 120).toLowerCase();
  const email = normalizeEmail(body?.primaryEmail || body?.primary_email || body?.email);
  const postal = cleanText(body?.postalCode || body?.postal_code, 30).toLowerCase();
  const mobileNorm = normalizePhone(body?.mobilePhone || body?.mobile_phone || body?.phone);
  const homeNorm = normalizePhone(body?.homePhone || body?.home_phone);

  const matches = new Map();

  try {
    if (email) {
      const rows = await env.DB.prepare(
        `SELECT id, first_name, last_name, preferred_name, primary_email, mobile_phone
         FROM directory_contacts
         WHERE archived_at IS NULL
           AND (lower(primary_email) = ? OR lower(secondary_email) = ?)
         LIMIT 8`
      ).bind(email, email).all();

      for (const row of (rows?.results || [])) {
        const key = String(row.id);
        if (!matches.has(key)) {
          matches.set(key, { row, reasons: new Set() });
        }
        matches.get(key).reasons.add('Exact email match');
      }
    }

    const phones = [mobileNorm, homeNorm].filter(Boolean);
    if (phones.length) {
      for (const phone of phones) {
        const rows = await env.DB.prepare(
          `SELECT id, first_name, last_name, preferred_name, primary_email, mobile_phone
           FROM directory_contacts
           WHERE archived_at IS NULL
             AND (normalized_primary_phone = ? OR normalized_home_phone = ?)
           LIMIT 8`
        ).bind(phone, phone).all();

        for (const row of (rows?.results || [])) {
          const key = String(row.id);
          if (!matches.has(key)) {
            matches.set(key, { row, reasons: new Set() });
          }
          matches.get(key).reasons.add('Exact normalized phone match');
        }
      }
    }

    if (firstName && lastName) {
      const rows = await env.DB.prepare(
        `SELECT id, first_name, last_name, preferred_name, primary_email, mobile_phone, postal_code
         FROM directory_contacts
         WHERE archived_at IS NULL
           AND lower(first_name) = ?
           AND lower(last_name) = ?
         LIMIT 10`
      ).bind(firstName, lastName).all();

      for (const row of (rows?.results || [])) {
        const key = String(row.id);
        if (!matches.has(key)) {
          matches.set(key, { row, reasons: new Set() });
        }
        matches.get(key).reasons.add('Same first and last name');
        if (postal && String(row.postal_code || '').trim().toLowerCase() === postal) {
          matches.get(key).reasons.add('Same name and postal code');
        }
      }
    }

    const items = Array.from(matches.values()).slice(0, 12).map((entry) => ({
      id: entry.row.id,
      displayName: `${entry.row.first_name || ''} ${entry.row.last_name || ''}`.trim(),
      preferredName: entry.row.preferred_name || '',
      primaryEmail: entry.row.primary_email || '',
      mobilePhone: entry.row.mobile_phone || '',
      reasons: Array.from(entry.reasons)
    }));

    return json({ items });
  } catch {
    return fail(500, 'Unable to check for duplicates.');
  }
}

function subscriberSelectColumns(includePrivate) {
  const privateCols = includePrivate
    ? `,
      c.first_name,
      c.last_name,
      c.preferred_name`
    : '';

  return `
    s.id,
    s.contact_id,
    s.email,
    s.status,
    s.consent_source,
    s.consent_date,
    s.confirmed_at,
    s.unsubscribed_at,
    s.suppression_reason,
    s.last_emailed_at,
    s.created_at,
    s.updated_at,
    (
      SELECT group_concat(l.name, ', ')
      FROM newsletter_list_members lm
      JOIN newsletter_lists l ON l.id = lm.list_id
      WHERE lm.subscriber_id = s.id AND lm.removed_at IS NULL
    ) AS list_names,
    (
      SELECT group_concat(l.id, ',')
      FROM newsletter_list_members lm
      JOIN newsletter_lists l ON l.id = lm.list_id
      WHERE lm.subscriber_id = s.id AND lm.removed_at IS NULL
    ) AS list_ids
    ${privateCols}
  `;
}

function mapSubscriberRow(row, includePrivate) {
  return {
    id: row.id,
    contactId: row.contact_id || '',
    email: row.email,
    status: row.status,
    consentSource: row.consent_source || '',
    consentDate: row.consent_date || '',
    confirmedAt: row.confirmed_at || '',
    unsubscribedAt: row.unsubscribed_at || '',
    suppressionReason: row.suppression_reason || '',
    lastEmailedAt: row.last_emailed_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    listNames: String(row.list_names || '').split(',').map((v) => v.trim()).filter(Boolean),
    listIds: String(row.list_ids || '').split(',').map((v) => v.trim()).filter(Boolean),
    displayName: includePrivate ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : ''
  };
}

function buildSubscribersWhere(url) {
  const clauses = [];
  const params = [];

  const status = cleanStatus(url.searchParams.get('status'), 'all');
  if (status !== 'all') {
    clauses.push('lower(s.status) = ?');
    params.push(status);
  }

  const source = cleanStatus(url.searchParams.get('source'), 'all');
  if (source !== 'all') {
    clauses.push('lower(coalesce(s.consent_source, \"\")) = ?');
    params.push(source);
  }

  const listId = cleanText(url.searchParams.get('listId'), 80);
  if (listId && listId !== 'all') {
    clauses.push(`EXISTS (
      SELECT 1 FROM newsletter_list_members lm
      WHERE lm.subscriber_id = s.id AND lm.list_id = ? AND lm.removed_at IS NULL
    )`);
    params.push(listId);
  }

  const q = cleanText(url.searchParams.get('q'), 120).toLowerCase();
  if (q) {
    clauses.push(`(
      lower(s.email) LIKE ?
      OR EXISTS (
        SELECT 1 FROM directory_contacts c
        WHERE c.id = s.contact_id
          AND (
            lower(c.first_name) LIKE ?
            OR lower(c.last_name) LIKE ?
            OR lower(c.preferred_name) LIKE ?
          )
      )
    )`);
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

async function handleDirectorySubscribersList(request, env, authCtx) {
  if (!hasContactsReadPermission(authCtx)) return fail(403, 'Directory access is not allowed for this role.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const url = new URL(request.url);
  const pagination = paginationFromRequest(url, 25);
  const includePrivate = Boolean(authCtx.permissions.canReadPrivate);
  const schema = await getDirectorySchemaFlags(env);
  if (!schema.hasNewsletterSubscribers) {
    return json({
      items: [],
      pagination: { page: pagination.page, pageSize: pagination.pageSize, total: 0, totalPages: 0 },
      counters: { active: 0, pending: 0, unsubscribed: 0, suppressedOrBounced: 0 },
      filters: { lists: [] }
    });
  }

  const whereData = buildSubscribersWhere(url, schema);

  try {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM newsletter_subscribers s ${whereData.where}`
    ).bind(...whereData.params).first();

    const rows = await env.DB.prepare(
      `SELECT ${subscriberSelectColumns(includePrivate)}
       FROM newsletter_subscribers s
       LEFT JOIN directory_contacts c ON c.id = s.contact_id
       ${whereData.where}
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...whereData.params, pagination.pageSize, pagination.offset).all();

    const listRows = schema.hasNewsletterLists
      ? await env.DB.prepare(`SELECT id, name FROM newsletter_lists WHERE lower(status) != 'archived' ORDER BY name ASC`).all()
      : { results: [] };

    const countersRow = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN lower(status) = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN lower(status) = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN lower(status) = 'unsubscribed' THEN 1 ELSE 0 END) AS unsubscribed,
        SUM(CASE WHEN lower(status) IN ('suppressed', 'bounced', 'complained') THEN 1 ELSE 0 END) AS suppressed_or_bounced
      FROM newsletter_subscribers
    `).first();

    const total = Number(countRow?.total || 0);
    const totalPages = total > 0 ? Math.ceil(total / pagination.pageSize) : 0;

    return json({
      items: (rows?.results || []).map((row) => mapSubscriberRow(row, includePrivate)),
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
        totalPages
      },
      counters: {
        active: Number(countersRow?.active || 0),
        pending: Number(countersRow?.pending || 0),
        unsubscribed: Number(countersRow?.unsubscribed || 0),
        suppressedOrBounced: Number(countersRow?.suppressed_or_bounced || 0)
      },
      filters: {
        lists: (listRows?.results || []).map((row) => ({ id: row.id, name: row.name }))
      }
    });
  } catch {
    return fail(500, 'Unable to load subscribers.');
  }
}

async function handleDirectorySubscriberGet(request, env, authCtx, subscriberId) {
  if (!hasContactsReadPermission(authCtx)) return fail(403, 'Directory access is not allowed for this role.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  try {
    const row = await env.DB.prepare(
      `SELECT ${subscriberSelectColumns(true)}
       FROM newsletter_subscribers s
       LEFT JOIN directory_contacts c ON c.id = s.contact_id
       WHERE s.id = ?
       LIMIT 1`
    ).bind(String(subscriberId || '')).first();

    if (!row) return fail(404, 'Subscriber not found.');
    return json({ item: mapSubscriberRow(row, true) });
  } catch {
    return fail(500, 'Unable to load subscriber details.');
  }
}

function validateSubscriberPayload(body) {
  const email = normalizeEmail(body?.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'A valid email is required.' };
  }

  const status = cleanStatus(body?.status, 'pending');
  const allowed = new Set(['active', 'pending', 'unsubscribed', 'bounced', 'complained', 'suppressed']);
  if (!allowed.has(status)) {
    return { ok: false, error: 'Subscriber status is invalid.' };
  }

  return {
    ok: true,
    payload: {
      contactId: cleanText(body?.contactId, 80) || null,
      email,
      status,
      consentSource: cleanStatus(body?.consentSource, ''),
      consentDate: cleanText(body?.consentDate, 30),
      suppressionReason: cleanText(body?.suppressionReason, 120),
      listIds: Array.isArray(body?.listIds) ? body.listIds.map((id) => cleanText(id, 80)).filter(Boolean) : [],
      reactivateConfirmed: Boolean(body?.reactivateConfirmed)
    }
  };
}

async function applySubscriberListMembership(env, subscriberId, listIds) {
  if (!env.DB) return;

  const currentRows = await env.DB.prepare(
    `SELECT list_id FROM newsletter_list_members WHERE subscriber_id = ? AND removed_at IS NULL`
  ).bind(subscriberId).all();

  const currentSet = new Set((currentRows?.results || []).map((row) => String(row.list_id || '')));
  const nextSet = new Set(listIds || []);

  const now = nowIso();

  for (const listId of nextSet) {
    if (currentSet.has(listId)) continue;
    await env.DB.prepare(
      `INSERT INTO newsletter_list_members (id, list_id, subscriber_id, added_at, removed_at)
       VALUES (?, ?, ?, ?, NULL)`
    ).bind(crypto.randomUUID(), listId, subscriberId, now).run();
  }

  for (const existingId of currentSet) {
    if (nextSet.has(existingId)) continue;
    await env.DB.prepare(
      `UPDATE newsletter_list_members
       SET removed_at = COALESCE(removed_at, ?)
       WHERE subscriber_id = ? AND list_id = ? AND removed_at IS NULL`
    ).bind(now, subscriberId, existingId).run();
  }
}

async function handleDirectorySubscriberCreate(request, env, authCtx) {
  if (!hasSubscriberWritePermission(authCtx)) return fail(403, 'You do not have permission to create subscribers.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail(400, 'Invalid subscriber payload.');

  const validated = validateSubscriberPayload(body);
  if (!validated.ok) return fail(400, validated.error);

  const payload = validated.payload;
  const existing = await env.DB.prepare(`SELECT id, status FROM newsletter_subscribers WHERE lower(email) = ? LIMIT 1`)
    .bind(payload.email).first();

  const suppressStates = new Set(['unsubscribed', 'suppressed', 'bounced', 'complained']);
  if (existing && suppressStates.has(cleanStatus(existing.status)) && (payload.status === 'active' || payload.status === 'pending') && !payload.reactivateConfirmed) {
    return fail(409, 'This subscriber is unsubscribed or suppressed and cannot be reactivated silently.');
  }

  const now = nowIso();

  try {
    let subscriberId = existing?.id ? String(existing.id) : crypto.randomUUID();

    if (existing) {
      await env.DB.prepare(
        `UPDATE newsletter_subscribers
         SET contact_id = ?,
             status = ?,
             consent_source = ?,
             consent_date = ?,
             suppression_reason = ?,
             confirmed_at = CASE WHEN ? = 'active' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
             unsubscribed_at = CASE WHEN ? = 'unsubscribed' THEN COALESCE(unsubscribed_at, ?) ELSE unsubscribed_at END,
             updated_at = ?
         WHERE id = ?`
      ).bind(
        payload.contactId,
        payload.status,
        payload.consentSource || null,
        payload.consentDate || null,
        payload.suppressionReason || null,
        payload.status,
        now,
        payload.status,
        now,
        now,
        subscriberId
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO newsletter_subscribers (
           id, contact_id, email, status, consent_source, consent_date,
           confirmed_at, unsubscribed_at, suppression_reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        subscriberId,
        payload.contactId,
        payload.email,
        payload.status,
        payload.consentSource || null,
        payload.consentDate || null,
        payload.status === 'active' ? now : null,
        payload.status === 'unsubscribed' ? now : null,
        payload.suppressionReason || null,
        now,
        now
      ).run();
    }

    await applySubscriberListMembership(env, subscriberId, payload.listIds);

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'subscriber_added',
      entityType: 'subscriber',
      entityId: subscriberId,
      summary: 'Subscriber added',
      metadata: { status: payload.status }
    });

    return json({ ok: true, id: subscriberId }, existing ? 200 : 201);
  } catch {
    return fail(500, 'Unable to save subscriber.');
  }
}

async function handleDirectorySubscriberUpdate(request, env, authCtx, subscriberId) {
  if (!hasSubscriberWritePermission(authCtx)) return fail(403, 'You do not have permission to update subscribers.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail(400, 'Invalid subscriber payload.');

  const validated = validateSubscriberPayload(body);
  if (!validated.ok) return fail(400, validated.error);

  const payload = validated.payload;

  const existing = await env.DB.prepare(
    `SELECT id, status FROM newsletter_subscribers WHERE id = ? LIMIT 1`
  ).bind(String(subscriberId || '')).first();
  if (!existing) return fail(404, 'Subscriber not found.');

  const suppressStates = new Set(['unsubscribed', 'suppressed', 'bounced', 'complained']);
  if (suppressStates.has(cleanStatus(existing.status)) && (payload.status === 'active' || payload.status === 'pending') && !payload.reactivateConfirmed) {
    return fail(409, 'This subscriber is unsubscribed or suppressed and cannot be reactivated silently.');
  }

  const now = nowIso();

  try {
    await env.DB.prepare(
      `UPDATE newsletter_subscribers
       SET contact_id = ?,
           email = ?,
           status = ?,
           consent_source = ?,
           consent_date = ?,
           suppression_reason = ?,
           confirmed_at = CASE WHEN ? = 'active' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
           unsubscribed_at = CASE WHEN ? = 'unsubscribed' THEN COALESCE(unsubscribed_at, ?) ELSE unsubscribed_at END,
           updated_at = ?
       WHERE id = ?`
    ).bind(
      payload.contactId,
      payload.email,
      payload.status,
      payload.consentSource || null,
      payload.consentDate || null,
      payload.suppressionReason || null,
      payload.status,
      now,
      payload.status,
      now,
      now,
      String(subscriberId || '')
    ).run();

    await applySubscriberListMembership(env, String(subscriberId || ''), payload.listIds);

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'subscriber_updated',
      entityType: 'subscriber',
      entityId: String(subscriberId || ''),
      summary: 'Subscriber updated',
      metadata: { status: payload.status }
    });

    return json({ ok: true, id: String(subscriberId || '') });
  } catch {
    return fail(500, 'Unable to update subscriber.');
  }
}

async function handleDirectorySubscriberUnsubscribe(request, env, authCtx, subscriberId) {
  if (!hasSubscriberWritePermission(authCtx)) return fail(403, 'You do not have permission to update subscribers.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const now = nowIso();

  try {
    const existing = await env.DB.prepare(`SELECT id FROM newsletter_subscribers WHERE id = ? LIMIT 1`)
      .bind(String(subscriberId || '')).first();
    if (!existing) return fail(404, 'Subscriber not found.');

    await env.DB.prepare(
      `UPDATE newsletter_subscribers
       SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, ?), updated_at = ?
       WHERE id = ?`
    ).bind(now, now, String(subscriberId || '')).run();

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'subscriber_unsubscribed',
      entityType: 'subscriber',
      entityId: String(subscriberId || ''),
      summary: 'Subscriber unsubscribed'
    });

    return json({ ok: true, id: String(subscriberId || '') });
  } catch {
    return fail(500, 'Unable to unsubscribe subscriber.');
  }
}

async function handleDirectorySubscriberResendConfirmation(request, env, authCtx, subscriberId) {
  if (!hasSubscriberWritePermission(authCtx)) return fail(403, 'You do not have permission to update subscribers.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  try {
    const existing = await env.DB.prepare(`SELECT id, email, status FROM newsletter_subscribers WHERE id = ? LIMIT 1`)
      .bind(String(subscriberId || '')).first();
    if (!existing) return fail(404, 'Subscriber not found.');

    const status = cleanStatus(existing.status, 'pending');
    const now = nowIso();
    if (status !== 'active' && status !== 'pending') {
      await env.DB.prepare(
        `UPDATE newsletter_subscribers
         SET status = 'pending', updated_at = ?
         WHERE id = ?`
      ).bind(now, String(subscriberId || '')).run();
    } else {
      await env.DB.prepare(
        `UPDATE newsletter_subscribers
         SET updated_at = ?
         WHERE id = ?`
      ).bind(now, String(subscriberId || '')).run();
    }

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'subscriber_confirmation_resent',
      entityType: 'subscriber',
      entityId: String(subscriberId || ''),
      summary: 'Confirmation resend requested',
      metadata: {
        email: existing.email || '',
        priorStatus: status
      }
    });

    return json({
      ok: true,
      id: String(subscriberId || ''),
      message: 'Confirmation resend request recorded.'
    });
  } catch {
    return fail(500, 'Unable to process resend request.');
  }
}

async function handleDirectoryGroupsGet(request, env, authCtx) {
  if (!hasContactsReadPermission(authCtx)) return fail(403, 'Directory access is not allowed for this role.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const schema = await getDirectorySchemaFlags(env);
  if (!schema.hasDirectoryGroups) {
    return json({ items: [] });
  }

  try {
    const rows = (schema.hasDirectoryGroupMembers && schema.hasContacts)
      ? await env.DB.prepare(`
        SELECT
          g.id,
          g.name,
          g.category,
          g.description,
          g.status,
          g.created_at,
          g.updated_at,
          (
            SELECT COUNT(*)
            FROM directory_group_members gm
            JOIN directory_contacts c ON c.id = gm.contact_id
            WHERE gm.group_id = g.id
              AND gm.ended_at IS NULL
              AND c.archived_at IS NULL
          ) AS active_member_count
        FROM directory_groups g
        ORDER BY g.name ASC
      `).all()
      : await env.DB.prepare(`
        SELECT
          g.id,
          g.name,
          g.category,
          g.description,
          g.status,
          g.created_at,
          g.updated_at,
          0 AS active_member_count
        FROM directory_groups g
        ORDER BY g.name ASC
      `).all();

    return json({
      items: (rows?.results || []).map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        description: row.description,
        status: row.status,
        activeMemberCount: Number(row.active_member_count || 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
  } catch {
    return fail(500, 'Unable to load directory groups.');
  }
}

async function handleDirectoryGroupsCreate(request, env, authCtx) {
  if (!hasGroupsWritePermission(authCtx)) return fail(403, 'You do not have permission to manage groups.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const body = await request.json().catch(() => null);
  const name = cleanText(body?.name, 120);
  if (!name) return fail(400, 'Group name is required.');

  const id = crypto.randomUUID();
  const now = nowIso();

  try {
    await env.DB.prepare(
      `INSERT INTO directory_groups (id, name, category, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      name,
      cleanText(body?.category, 80) || 'ministry',
      cleanText(body?.description, 500) || null,
      cleanStatus(body?.status, 'active'),
      now,
      now
    ).run();

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'group_created',
      entityType: 'group',
      entityId: id,
      summary: 'Directory group created',
      metadata: { name }
    });

    return json({ ok: true, id }, 201);
  } catch {
    return fail(500, 'Unable to create directory group.');
  }
}

async function handleDirectoryGroupsUpdate(request, env, authCtx, groupId) {
  if (!hasGroupsWritePermission(authCtx)) return fail(403, 'You do not have permission to manage groups.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const body = await request.json().catch(() => null);
  const name = cleanText(body?.name, 120);
  if (!name) return fail(400, 'Group name is required.');

  const now = nowIso();

  try {
    await env.DB.prepare(
      `UPDATE directory_groups
       SET name = ?, category = ?, description = ?, status = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      name,
      cleanText(body?.category, 80) || 'ministry',
      cleanText(body?.description, 500) || null,
      cleanStatus(body?.status, 'active'),
      now,
      String(groupId || '')
    ).run();

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'group_updated',
      entityType: 'group',
      entityId: String(groupId || ''),
      summary: 'Directory group updated',
      metadata: { name }
    });

    return json({ ok: true, id: String(groupId || '') });
  } catch {
    return fail(500, 'Unable to update directory group.');
  }
}

async function handleDirectoryListsGet(request, env, authCtx) {
  if (!hasContactsReadPermission(authCtx)) return fail(403, 'Directory access is not allowed for this role.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const schema = await getDirectorySchemaFlags(env);
  if (!schema.hasNewsletterLists) {
    return json({ items: [] });
  }

  try {
    const rows = await env.DB.prepare(
      `SELECT id, name, description, status, created_at, updated_at FROM newsletter_lists ORDER BY name ASC`
    ).all();

    return json({
      items: (rows?.results || []).map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
  } catch {
    return fail(500, 'Unable to load newsletter lists.');
  }
}

async function handleDirectoryListsCreate(request, env, authCtx) {
  if (!hasGroupsWritePermission(authCtx)) return fail(403, 'You do not have permission to manage lists.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const body = await request.json().catch(() => null);
  const name = cleanText(body?.name, 120);
  if (!name) return fail(400, 'List name is required.');

  const id = crypto.randomUUID();
  const now = nowIso();

  try {
    await env.DB.prepare(
      `INSERT INTO newsletter_lists (id, name, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      name,
      cleanText(body?.description, 500) || null,
      cleanStatus(body?.status, 'active'),
      now,
      now
    ).run();

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'list_created',
      entityType: 'list',
      entityId: id,
      summary: 'Newsletter list created',
      metadata: { name }
    });

    return json({ ok: true, id }, 201);
  } catch {
    return fail(500, 'Unable to create newsletter list.');
  }
}

async function handleDirectoryListsUpdate(request, env, authCtx, listId) {
  if (!hasGroupsWritePermission(authCtx)) return fail(403, 'You do not have permission to manage lists.');
  if (!env.DB) return fail(503, 'Database is not configured.');

  const body = await request.json().catch(() => null);
  const name = cleanText(body?.name, 120);
  if (!name) return fail(400, 'List name is required.');

  const now = nowIso();

  try {
    await env.DB.prepare(
      `UPDATE newsletter_lists
       SET name = ?, description = ?, status = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      name,
      cleanText(body?.description, 500) || null,
      cleanStatus(body?.status, 'active'),
      now,
      String(listId || '')
    ).run();

    await logDirectoryActivity(env, {
      actorEmail: authCtx.email,
      eventType: 'list_updated',
      entityType: 'list',
      entityId: String(listId || ''),
      summary: 'Newsletter list updated',
      metadata: { name }
    });

    return json({ ok: true, id: String(listId || '') });
  } catch {
    return fail(500, 'Unable to update newsletter list.');
  }
}

export {
  resolveDirectoryAccessContext,
  handleDirectoryOverview,
  handleDirectoryContactsList,
  handleDirectoryContactGet,
  handleDirectoryContactCreate,
  handleDirectoryContactUpdate,
  handleDirectoryContactArchive,
  handleDirectoryContactDuplicateCheck,
  handleDirectorySubscribersList,
  handleDirectorySubscriberGet,
  handleDirectorySubscriberCreate,
  handleDirectorySubscriberUpdate,
  handleDirectorySubscriberUnsubscribe,
  handleDirectorySubscriberResendConfirmation,
  handleDirectoryGroupsGet,
  handleDirectoryGroupsCreate,
  handleDirectoryGroupsUpdate,
  handleDirectoryListsGet,
  handleDirectoryListsCreate,
  handleDirectoryListsUpdate
};

export const __directoryTestHooks = {
  normalizeAccountNumber,
  buildDirectoryAccountNumberSeed,
  ensureDirectoryAccountNumber,
  directoryContactDonorKind,
  composeMailingAddress,
  validateContactPayload,
  syncFinanceDonorForDirectoryContact
};
