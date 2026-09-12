import { AdminAuthError, isValidEmail, normalizeEmail, requirePermission } from './admin-auth.js';
import { normalizeRole, PERMISSIONS, publicRoleDefinitions } from './admin-rbac.js';

const USER_STATUSES = new Set(['pending', 'active', 'suspended', 'revoked']);
const USER_SELECT = `id, email, full_name, role, status, invited_by, invited_at,
  activated_at, last_login_at, created_at, updated_at`;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

function apiError(status, code, message) {
  return json({ error: { code, message } }, status);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function serializeUser(row) {
  return {
    id: String(row.id),
    email: normalizeEmail(row.email),
    fullName: String(row.full_name || ''),
    name: String(row.full_name || ''),
    role: String(row.role || ''),
    status: String(row.status || ''),
    invitedBy: normalizeEmail(row.invited_by),
    invitedAt: String(row.invited_at || ''),
    activatedAt: String(row.activated_at || ''),
    lastLoginAt: String(row.last_login_at || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    isStatic: false
  };
}

function serializeAudit(row) {
  let previousValue = null;
  let newValue = null;
  try { previousValue = row.previous_value_json ? JSON.parse(String(row.previous_value_json)) : null; } catch { previousValue = null; }
  try { newValue = row.new_value_json ? JSON.parse(String(row.new_value_json)) : null; } catch { newValue = null; }
  return {
    id: String(row.id),
    actorUserId: String(row.actor_user_id || ''),
    actorEmail: normalizeEmail(row.actor_email),
    action: String(row.action || ''),
    targetUserId: String(row.target_user_id || ''),
    targetEmail: normalizeEmail(row.target_email),
    previousValue,
    newValue,
    createdAt: String(row.created_at || '')
  };
}

async function writeAudit(env, actor, action, target, previousValue = null, newValue = null) {
  await env.DB.prepare(
    `INSERT INTO admin_audit_log
      (id, actor_user_id, actor_email, action, target_user_id, target_email, previous_value_json, new_value_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    actor.id,
    actor.email,
    action,
    target?.id || null,
    target?.email || null,
    previousValue === null ? null : JSON.stringify(previousValue),
    newValue === null ? null : JSON.stringify(newValue),
    new Date().toISOString()
  ).run();
}

async function getUser(env, id) {
  return env.DB.prepare(`SELECT ${USER_SELECT} FROM admin_users WHERE id = ? LIMIT 1`)
    .bind(String(id || ''))
    .first();
}

async function activeAdministratorCount(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM admin_users WHERE role = 'administrator' AND status = 'active'`
  ).first();
  return Number(row?.total || 0);
}

async function assertCanRestrictUser(env, actor, target, { nextRole, nextStatus }) {
  const removesActiveAdmin = target.role === 'administrator'
    && target.status === 'active'
    && (nextRole !== 'administrator' || nextStatus !== 'active');

  if (target.id === actor.id && (nextRole !== target.role || nextStatus !== target.status)) {
    throw new AdminAuthError(
      'SELF_MODIFICATION_FORBIDDEN',
      'You cannot change your own role or account status.',
      409
    );
  }
  if (removesActiveAdmin && await activeAdministratorCount(env) <= 1) {
    throw new AdminAuthError(
      'FINAL_ACTIVE_ADMIN',
      'At least one active administrator must remain.',
      409
    );
  }
}

async function listUsers(request, env) {
  const url = new URL(request.url);
  const page = positiveInteger(url.searchParams.get('page'), 1, 100000);
  const pageSize = positiveInteger(url.searchParams.get('pageSize') || url.searchParams.get('limit'), 25, 100);
  const role = url.searchParams.get('role') ? normalizeRole(url.searchParams.get('role')) : '';
  const status = cleanText(url.searchParams.get('status'), 30).toLowerCase();
  const query = cleanText(url.searchParams.get('q') || url.searchParams.get('search'), 120).toLowerCase();
  if (url.searchParams.has('role') && !role) return apiError(400, 'INVALID_ROLE', 'Role is invalid.');
  if (status && !USER_STATUSES.has(status)) return apiError(400, 'INVALID_STATUS', 'Status is invalid.');

  const conditions = [];
  const bindings = [];
  if (role) { conditions.push('role = ?'); bindings.push(role); }
  if (status) { conditions.push('status = ?'); bindings.push(status); }
  if (query) {
    conditions.push('(lower(email) LIKE ? OR lower(full_name) LIKE ?)');
    bindings.push(`%${query}%`, `%${query}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM admin_users ${where}`)
    .bind(...bindings)
    .first();
  const rows = await env.DB.prepare(
    `SELECT ${USER_SELECT} FROM admin_users ${where}
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END,
              lower(email) ASC
     LIMIT ? OFFSET ?`
  ).bind(...bindings, pageSize, (page - 1) * pageSize).all();
  const total = Number(count?.total || 0);
  return json({
    users: (rows?.results || []).map(serializeUser),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
  });
}

async function listAudit(request, env) {
  const url = new URL(request.url);
  const page = positiveInteger(url.searchParams.get('page'), 1, 100000);
  const pageSize = positiveInteger(url.searchParams.get('pageSize') || url.searchParams.get('limit'), 25, 100);
  const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM admin_audit_log').first();
  const rows = await env.DB.prepare(
        `SELECT id, actor_user_id, actor_email, action, target_user_id, target_email,
          previous_value_json, new_value_json, created_at
       FROM admin_audit_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(pageSize, (page - 1) * pageSize).all();
  const total = Number(count?.total || 0);
  return json({
    audit: (rows?.results || []).map(serializeAudit),
    entries: (rows?.results || []).map(serializeAudit),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
  });
}

async function createUser(request, env, actor) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return apiError(400, 'INVALID_BODY', 'A JSON request body is required.');
  const email = normalizeEmail(body.email);
  const role = normalizeRole(body.role || 'website_editor');
  const fullName = cleanText(body.fullName ?? body.name, 120);
  const status = cleanText(body.status || 'pending', 30).toLowerCase();
  if (!isValidEmail(email)) return apiError(400, 'INVALID_EMAIL', 'A valid email is required.');
  if (!role) return apiError(400, 'INVALID_ROLE', 'Role is invalid.');
  if (!USER_STATUSES.has(status) || status === 'revoked') {
    return apiError(400, 'INVALID_STATUS', 'New users may be pending, active, or suspended.');
  }

  const existing = await env.DB.prepare('SELECT id FROM admin_users WHERE email = ? COLLATE NOCASE LIMIT 1')
    .bind(email)
    .first();
  if (existing) return apiError(409, 'USER_EXISTS', 'A user with this email already exists.');

  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(), email, full_name: fullName, role, status,
    invited_by: actor.email, invited_at: now,
    activated_at: status === 'active' ? now : null,
    last_login_at: null, created_at: now, updated_at: now
  };
  await env.DB.prepare(
    `INSERT INTO admin_users
      (id, email, full_name, role, status, invited_by, invited_at, activated_at, last_login_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    user.id, user.email, user.full_name, user.role, user.status, user.invited_by,
    user.invited_at, user.activated_at, user.last_login_at, user.created_at, user.updated_at
  ).run();
  await writeAudit(env, actor, 'user.created', user, null, { email, fullName, role, status });
  return json({
    ok: true,
    user: serializeUser(user),
    inviteLink: `${new URL(request.url).origin}/admin/`,
    emailSent: false
  }, 201);
}

async function updateUser(request, env, actor, id) {
  const row = await getUser(env, id);
  if (!row) return apiError(404, 'USER_NOT_FOUND', 'Administrator user was not found.');
  const target = serializeUser(row);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return apiError(400, 'INVALID_BODY', 'A JSON request body is required.');
  const hasRole = Object.hasOwn(body, 'role');
  const hasName = Object.hasOwn(body, 'fullName') || Object.hasOwn(body, 'name');
  if (!hasRole && !hasName) return apiError(400, 'NO_CHANGES', 'Provide a role or full name to update.');
  const role = hasRole ? normalizeRole(body.role) : target.role;
  const fullName = hasName ? cleanText(body.fullName ?? body.name, 120) : target.fullName;
  if (!role) return apiError(400, 'INVALID_ROLE', 'Role is invalid.');
  await assertCanRestrictUser(env, actor, target, { nextRole: role, nextStatus: target.status });

  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE admin_users SET role = ?, full_name = ?, updated_at = ? WHERE id = ?')
    .bind(role, fullName, now, target.id)
    .run();
  const updated = { ...row, role, full_name: fullName, updated_at: now };
  await writeAudit(
    env,
    actor,
    'user.updated',
    updated,
    { fullName: target.fullName, role: target.role, status: target.status },
    { fullName, role, status: target.status }
  );
  return json({ ok: true, user: serializeUser(updated) });
}

async function changeStatus(env, actor, id, action) {
  const row = await getUser(env, id);
  if (!row) return apiError(404, 'USER_NOT_FOUND', 'Administrator user was not found.');
  const target = serializeUser(row);
  const transitions = {
    activate: new Set(['pending', 'suspended']),
    reactivate: new Set(['suspended', 'revoked']),
    suspend: new Set(['active']),
    revoke: new Set(['invited', 'active', 'suspended'])
  };
  const nextStatus = action === 'activate' || action === 'reactivate' ? 'active' : action === 'suspend' ? 'suspended' : 'revoked';
  if (!transitions[action]?.has(target.status)) {
    return apiError(409, 'INVALID_STATUS_TRANSITION', `A ${target.status} user cannot be ${action}d.`);
  }
  await assertCanRestrictUser(env, actor, target, { nextRole: target.role, nextStatus });

  const now = new Date().toISOString();
  const activatedAt = nextStatus === 'active' ? (target.activatedAt || now) : row.activated_at;
  await env.DB.prepare('UPDATE admin_users SET status = ?, activated_at = ?, updated_at = ? WHERE id = ?')
    .bind(nextStatus, activatedAt || null, now, target.id)
    .run();
  const updated = { ...row, status: nextStatus, activated_at: activatedAt || null, updated_at: now };
  const auditAction = { activate: 'activated', suspend: 'suspended', reactivate: 'reactivated', revoke: 'revoked' }[action];
  await writeAudit(
    env,
    actor,
    `user.${auditAction}`,
    updated,
    { role: target.role, status: target.status },
    { role: target.role, status: nextStatus }
  );
  return json({ ok: true, user: serializeUser(updated) });
}

function parseUserRoute(pathname) {
  const normalized = pathname
    .replace(/^\/api\/admin\/settings\/users/, '/api/users')
    .replace(/^\/api\/admin\/users/, '/api/users')
    .replace(/\/+$/, '') || '/';
  const match = normalized.match(/^\/api\/users\/([^/]+)(?:\/(role|activate|suspend|reactivate|revoke))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] || '' } : null;
}

export function isAdminUserSettingsPath(pathname) {
  return pathname === '/api/admin/settings/roles'
    || pathname === '/api/admin/settings/users/audit'
    || pathname === '/api/admin/settings/users'
    || pathname.startsWith('/api/admin/settings/users/')
    || pathname === '/api/audit-log'
    || pathname === '/api/admin/audit-log'
    || pathname === '/api/users/audit'
    || pathname === '/api/users/roles'
    || pathname === '/api/admin/users/roles'
    || pathname === '/api/users'
    || pathname === '/api/users/invite'
    || pathname === '/api/admin/users'
    || pathname.startsWith('/api/users/')
    || pathname.startsWith('/api/admin/users/');
}

export async function handleAdminUserSettingsRequest(request, env, authContext) {
  try {
    requirePermission(authContext?.user, PERMISSIONS.USERS_MANAGE);
    if (!env.DB) return apiError(503, 'AUTH_STORAGE_UNAVAILABLE', 'Administrator storage is unavailable.');
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const canonical = pathname
      .replace(/^\/api\/admin\/settings\/users/, '/api/users')
      .replace(/^\/api\/admin\/settings\/roles$/, '/api/users/roles')
      .replace(/^\/api\/admin\/users/, '/api/users');

    if ((canonical === '/api/users/roles') && request.method === 'GET') {
      return json({ roles: publicRoleDefinitions() });
    }
    if ((pathname === '/api/audit-log' || pathname === '/api/admin/audit-log' || canonical === '/api/users/audit') && request.method === 'GET') {
      return await listAudit(request, env);
    }
    if (canonical === '/api/users' && request.method === 'GET') return await listUsers(request, env);
    if ((canonical === '/api/users' || canonical === '/api/users/invite') && request.method === 'POST') {
      return await createUser(request, env, authContext.user);
    }

    const route = parseUserRoute(pathname);
    if (!route) return apiError(404, 'ENDPOINT_NOT_FOUND', 'Administrator user endpoint was not found.');
    if ((request.method === 'PATCH' && (!route.action || route.action === 'role')) || (request.method === 'PUT' && route.action === 'role')) {
      return await updateUser(request, env, authContext.user, route.id);
    }
    if (request.method === 'POST' && ['activate', 'suspend', 'reactivate', 'revoke'].includes(route.action)) {
      return await changeStatus(env, authContext.user, route.id, route.action);
    }
    if (request.method === 'DELETE' && !route.action) {
      return await changeStatus(env, authContext.user, route.id, 'revoke');
    }
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  } catch (error) {
    if (error instanceof AdminAuthError) return apiError(error.status, error.code, error.message);
    return apiError(500, 'USER_SETTINGS_FAILED', 'Administrator user settings could not be updated.');
  }
}