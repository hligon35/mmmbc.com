import { createRemoteJWKSet, jwtVerify } from 'jose';
import { permissionsForRole, roleHasPermission } from './admin-rbac.js';

const LAST_LOGIN_THROTTLE_MS = 60 * 60 * 1000;

export class AdminAuthError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AdminAuthError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function accessConfig(env) {
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/\/+$/, '');
  const audiences = String(env.CF_ACCESS_AUD || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!teamDomain || !audiences.length) {
    throw new AdminAuthError('AUTH_NOT_CONFIGURED', 'Cloudflare Access authentication is not configured.', 503);
  }
  let issuer;
  try {
    issuer = new URL(teamDomain).origin;
  } catch {
    throw new AdminAuthError('AUTH_NOT_CONFIGURED', 'Cloudflare Access team domain is invalid.', 503);
  }
  if (!issuer.endsWith('.cloudflareaccess.com')) {
    throw new AdminAuthError('AUTH_NOT_CONFIGURED', 'Cloudflare Access team domain is invalid.', 503);
  }
  return { issuer, audience: audiences.length === 1 ? audiences[0] : audiences };
}

export async function authenticateAccessRequest(request, env, { jwks } = {}) {
  const url = new URL(request.url);
  const devBypass = ['1', 'true', 'yes', 'on'].includes(String(env.DEV_BYPASS_AUTH || '').trim().toLowerCase());
  if (devBypass && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    const email = normalizeEmail(env.DEV_BYPASS_EMAIL || 'dev@local.test');
    if (!isValidEmail(email)) {
      throw new AdminAuthError('AUTH_NOT_CONFIGURED', 'The local development identity is invalid.', 503);
    }
    return { email, claims: { email, devBypass: true } };
  }

  const token = String(request.headers.get('Cf-Access-Jwt-Assertion') || '').trim();
  if (!token) {
    throw new AdminAuthError('AUTH_REQUIRED', 'Cloudflare Access authentication is required.', 401);
  }

  const { issuer, audience } = accessConfig(env);
  const keySet = jwks || createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      audience,
      algorithms: ['RS256']
    });
    const email = normalizeEmail(payload.email);
    if (!isValidEmail(email)) {
      throw new AdminAuthError('INVALID_IDENTITY', 'Cloudflare Access did not provide a valid email identity.', 401);
    }
    return { email, claims: payload };
  } catch (error) {
    if (error instanceof AdminAuthError) throw error;
    throw new AdminAuthError('INVALID_ACCESS_TOKEN', 'Cloudflare Access authentication is invalid or expired.', 401);
  }
}

export async function resolveAdminUser(env, email) {
  if (!env.DB) throw new AdminAuthError('AUTH_STORAGE_UNAVAILABLE', 'Administrator authorization storage is unavailable.', 503);
  const normalized = normalizeEmail(email);
  const row = await env.DB.prepare(
    `SELECT id, email, full_name, role, status, invited_by, invited_at,
            activated_at, last_login_at, created_at, updated_at
       FROM admin_users
      WHERE email = ? COLLATE NOCASE
      LIMIT 1`
  ).bind(normalized).first();
  if (!row) return null;
  return {
    id: String(row.id),
    email: normalizeEmail(row.email),
    fullName: String(row.full_name || ''),
    role: String(row.role || ''),
    status: String(row.status || ''),
    invitedBy: normalizeEmail(row.invited_by),
    invitedAt: String(row.invited_at || ''),
    activatedAt: String(row.activated_at || ''),
    lastLoginAt: String(row.last_login_at || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || '')
  };
}

async function bootstrapFirstAdministrator(env, email) {
  const allowed = new Set(String(env.ADMIN_BOOTSTRAP_EMAILS || env.ADMIN_ALLOW_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean));
  if (!allowed.has(email)) return null;

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT INTO admin_users
      (id, email, full_name, role, status, invited_by, invited_at, activated_at, last_login_at, created_at, updated_at)
     SELECT ?, ?, '', 'administrator', 'active', ?, ?, ?, NULL, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM admin_users)`
  ).bind(id, email, email, now, now, now, now).run();
  if (Number(result?.meta?.changes || 0) < 1) return null;

  await env.DB.prepare(
    `INSERT INTO admin_audit_log
      (id, actor_user_id, actor_email, action, target_user_id, target_email, previous_value_json, new_value_json, created_at)
     VALUES (?, ?, ?, 'user.bootstrapped', ?, ?, NULL, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    id,
    email,
    id,
    email,
    JSON.stringify({ email, role: 'administrator', status: 'active' }),
    now
  ).run();
  return resolveAdminUser(env, email);
}

export function requireActiveUser(user) {
  if (!user) {
    throw new AdminAuthError('ADMIN_NOT_AUTHORIZED', 'This authenticated email is not an administrator.', 403);
  }
  if (user.status !== 'active') {
    throw new AdminAuthError('ADMIN_INACTIVE', `This administrator account is ${user.status || 'inactive'}.`, 403);
  }
  if (!permissionsForRole(user.role).length) {
    throw new AdminAuthError('INVALID_ROLE', 'This administrator account has an invalid role.', 403);
  }
  return user;
}

export function requirePermission(user, permission) {
  requireActiveUser(user);
  if (!roleHasPermission(user.role, permission)) {
    throw new AdminAuthError('PERMISSION_DENIED', 'You do not have permission to perform this action.', 403);
  }
  return user;
}

export function requireAnyPermission(user, permissions) {
  requireActiveUser(user);
  if (!(permissions || []).some((permission) => roleHasPermission(user.role, permission))) {
    throw new AdminAuthError('PERMISSION_DENIED', 'You do not have permission to perform this action.', 403);
  }
  return user;
}

export async function authenticateAdminRequest(request, env, options = {}) {
  const identity = await authenticateAccessRequest(request, env, options);
  const storedUser = await resolveAdminUser(env, identity.email)
    || await bootstrapFirstAdministrator(env, identity.email);
  const user = requireActiveUser(storedUser);
  return { identity, user, permissions: permissionsForRole(user.role) };
}

export async function updateLastLoginIfDue(env, user, now = new Date()) {
  const previous = Date.parse(user?.lastLoginAt || '');
  if (Number.isFinite(previous) && now.getTime() - previous < LAST_LOGIN_THROTTLE_MS) return false;
  const timestamp = now.toISOString();
  const result = await env.DB.prepare(
    `UPDATE admin_users
        SET last_login_at = ?, updated_at = ?
      WHERE id = ?
        AND (last_login_at IS NULL OR last_login_at = '' OR last_login_at <= ?)`
  ).bind(
    timestamp,
    timestamp,
    user.id,
    new Date(now.getTime() - LAST_LOGIN_THROTTLE_MS).toISOString()
  ).run();
  if (Number(result?.meta?.changes || 0) > 0) user.lastLoginAt = timestamp;
  return Number(result?.meta?.changes || 0) > 0;
}

export function sessionStateForUser(user, env = {}) {
  const permissions = permissionsForRole(user.role);
  const developerEmails = new Set(String(env.DEVELOPER_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean));
  const developer = developerEmails.has(user.email);
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.fullName,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
      invitedBy: user.invitedBy,
      invitedAt: user.invitedAt,
      activatedAt: user.activatedAt,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      isMaster: false,
      developer,
      mustOnboard: false,
      twoFactorEnabled: false
    },
    permissions,
    capabilities: {
      developer,
      diagnostics: { view: developer },
      permissions: Object.fromEntries(permissions.map((permission) => [permission, true]))
    }
  };
}

export async function handleMeRequest(request, env, ctx = null) {
  try {
    const authContext = await authenticateAdminRequest(
      request,
      env,
      env.__ACCESS_JWKS ? { jwks: env.__ACCESS_JWKS } : {}
    );
    const update = updateLastLoginIfDue(env, authContext.user);
    if (ctx?.waitUntil) ctx.waitUntil(update);
    else await update;
    return Response.json(sessionStateForUser(authContext.user, env), {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export function authErrorResponse(error) {
  const authError = error instanceof AdminAuthError
    ? error
    : new AdminAuthError('AUTHORIZATION_FAILED', 'Authentication or authorization failed.', 500);
  return Response.json({
    error: {
      code: authError.code,
      message: authError.message
    }
  }, {
    status: authError.status,
    headers: { 'Cache-Control': 'no-store' }
  });
}