import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';

import { authenticateAccessRequest, handleMeRequest } from './admin-auth.js';
import { handleAdminUserSettingsRequest } from './admin-user-settings.js';
import { PERMISSIONS, permissionsForRole, roleHasPermission } from './admin-rbac.js';

const ISSUER = 'https://mmmbc-test.cloudflareaccess.com';
const AUDIENCE = 'test-access-audience';

function createD1() {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE admin_invites (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'website_editor',
    status TEXT NOT NULL DEFAULT 'invited', invited_by TEXT, invited_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.exec(readFileSync(new URL('../migrations/admin/0007_add_admin_users_and_audit_log.sql', import.meta.url), 'utf8'));
  return {
    database,
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        first() { return database.prepare(sql).get(...bindings) || null; },
        all() { return { results: database.prepare(sql).all(...bindings) }; },
        run() {
          const result = database.prepare(sql).run(...bindings);
          return { success: true, meta: { changes: Number(result.changes || 0) } };
        }
      };
    }
  };
}

function insertUser(env, {
  id,
  email,
  role = 'administrator',
  status = 'active',
  fullName = 'Test Administrator',
  lastLoginAt = null
}) {
  const now = '2026-09-11T12:00:00.000Z';
  env.DB.prepare(
    `INSERT INTO admin_users
      (id, email, full_name, role, status, invited_by, invited_at, activated_at, last_login_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, email, fullName, role, status, 'seed@example.com', now, status === 'active' ? now : null, lastLoginAt, now, now).run();
}

function createEnv(DB, jwks) {
  return {
    DB,
    __ACCESS_JWKS: jwks,
    CF_ACCESS_TEAM_DOMAIN: ISSUER,
    CF_ACCESS_AUD: AUDIENCE,
    DEVELOPER_EMAILS: 'admin@example.com'
  };
}

async function accessToken(privateKey, email = 'admin@example.com') {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function request(pathname, { method = 'GET', token = '', body, headers = {} } = {}) {
  return new Request(`https://admin.example.com${pathname}`, {
    method,
    headers: {
      ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function json(response) {
  return response.json();
}

test('RBAC matrix grants only the intended finance and user permissions', () => {
  assert.equal(roleHasPermission('administrator', PERMISSIONS.USERS_MANAGE), true);
  assert.equal(roleHasPermission('website_editor', PERMISSIONS.USERS_MANAGE), false);
  assert.equal(roleHasPermission('treasurer', PERMISSIONS.FINANCE_EDIT_VOID), true);
  assert.equal(roleHasPermission('finance_entry', PERMISSIONS.FINANCE_EDIT_VOID), false);
  assert.equal(roleHasPermission('auditor', PERMISSIONS.FINANCE_VIEW), true);
  assert.equal(roleHasPermission('auditor', PERMISSIONS.FINANCE_RECORD), false);
  assert.deepEqual(new Set(permissionsForRole('admin')), new Set(permissionsForRole('administrator')));
});

test('Access authentication verifies JWT crypto and never trusts the email header', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const env = createEnv(createD1(), publicKey);
  const spoofed = request('/api/me', { headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.com' } });
  await assert.rejects(authenticateAccessRequest(spoofed, env, { jwks: publicKey }), { code: 'AUTH_REQUIRED' });

  const identity = await authenticateAccessRequest(
    request('/api/me', { token: await accessToken(privateKey) }),
    env,
    { jwks: publicKey }
  );
  assert.equal(identity.email, 'admin@example.com');
});

test('/api/me returns stored fields, permissions and capabilities and throttles last_login', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const DB = createD1();
  const env = createEnv(DB, publicKey);
  insertUser(env, { id: 'admin-1', email: 'admin@example.com', fullName: 'Ada Admin' });
  const token = await accessToken(privateKey);

  const first = await handleMeRequest(request('/api/me', { token }), env);
  assert.equal(first.status, 200);
  const state = await json(first);
  assert.equal(state.user.id, 'admin-1');
  assert.equal(state.user.fullName, 'Ada Admin');
  assert.equal(state.user.status, 'active');
  assert.equal(state.user.developer, true);
  assert.equal(state.permissions.includes(PERMISSIONS.USERS_MANAGE), true);
  assert.equal(state.capabilities.permissions[PERMISSIONS.FINANCE_VIEW], true);

  const firstLogin = DB.database.prepare('SELECT last_login_at FROM admin_users WHERE id = ?').get('admin-1').last_login_at;
  assert.ok(firstLogin);
  await handleMeRequest(request('/api/me', { token }), env);
  const secondLogin = DB.database.prepare('SELECT last_login_at FROM admin_users WHERE id = ?').get('admin-1').last_login_at;
  assert.equal(secondLogin, firstLogin);
});

test('/api/me returns structured status and token errors', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const env = createEnv(createD1(), publicKey);
  insertUser(env, { id: 'suspended-1', email: 'suspended@example.com', status: 'suspended' });

  const inactive = await handleMeRequest(
    request('/api/me', { token: await accessToken(privateKey, 'suspended@example.com') }),
    env
  );
  assert.equal(inactive.status, 403);
  assert.deepEqual((await json(inactive)).error.code, 'ADMIN_INACTIVE');

  const missing = await handleMeRequest(request('/api/me'), env);
  assert.equal(missing.status, 401);
  assert.equal((await json(missing)).error.code, 'AUTH_REQUIRED');
});

test('verified bootstrap configuration creates only the first D1 administrator', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const DB = createD1();
  const env = createEnv(DB, publicKey);
  env.ADMIN_ALLOW_EMAILS = 'admin@example.com,second@example.com';

  const first = await handleMeRequest(request('/api/me', { token: await accessToken(privateKey) }), env);
  assert.equal(first.status, 200);
  assert.equal((await json(first)).user.role, 'administrator');
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS total FROM admin_users').get().total, 1);

  const second = await handleMeRequest(
    request('/api/me', { token: await accessToken(privateKey, 'second@example.com') }),
    env
  );
  assert.equal(second.status, 403);
  assert.equal((await json(second)).error.code, 'ADMIN_NOT_AUTHORIZED');
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS total FROM admin_users').get().total, 1);
});

test('user settings supports create, pagination, role patch, lifecycle actions and audit', async () => {
  const DB = createD1();
  const env = createEnv(DB, null);
  insertUser(env, { id: 'admin-1', email: 'admin@example.com' });
  const actor = {
    user: { id: 'admin-1', email: 'admin@example.com', role: 'administrator', status: 'active' }
  };

  const createdResponse = await handleAdminUserSettingsRequest(request('/api/users', {
    method: 'POST',
    body: { email: 'editor@example.com', fullName: 'Ed Editor', role: 'website_editor' }
  }), env, actor);
  assert.equal(createdResponse.status, 201);
  const created = (await json(createdResponse)).user;
  assert.equal(created.status, 'pending');

  const page = await handleAdminUserSettingsRequest(request('/api/users?page=1&pageSize=1'), env, actor);
  const pageBody = await json(page);
  assert.equal(pageBody.users.length, 1);
  assert.equal(pageBody.pagination.total, 2);

  const patched = await handleAdminUserSettingsRequest(request(`/api/users/${created.id}`, {
    method: 'PATCH', body: { role: 'finance_entry' }
  }), env, actor);
  assert.equal((await json(patched)).user.role, 'finance_entry');

  for (const action of ['activate', 'suspend', 'reactivate', 'revoke']) {
    const response = await handleAdminUserSettingsRequest(request(`/api/users/${created.id}/${action}`, { method: 'POST' }), env, actor);
    assert.equal(response.status, 200, action);
  }
  const auditCount = DB.database.prepare('SELECT COUNT(*) AS total FROM admin_audit_log').get().total;
  assert.equal(auditCount, 6);
});

test('user settings blocks self changes, final-admin removal and unauthorized roles', async () => {
  const DB = createD1();
  const env = createEnv(DB, null);
  insertUser(env, { id: 'admin-1', email: 'admin@example.com' });
  insertUser(env, { id: 'editor-1', email: 'editor@example.com', role: 'website_editor' });
  const admin = { user: { id: 'admin-1', email: 'admin@example.com', role: 'administrator', status: 'active' } };
  const editor = { user: { id: 'editor-1', email: 'editor@example.com', role: 'website_editor', status: 'active' } };

  const self = await handleAdminUserSettingsRequest(request('/api/users/admin-1', {
    method: 'PATCH', body: { role: 'website_editor' }
  }), env, admin);
  assert.equal(self.status, 409);
  assert.equal((await json(self)).error.code, 'SELF_MODIFICATION_FORBIDDEN');

  const finalAdmin = await handleAdminUserSettingsRequest(request('/api/users/admin-1/suspend', { method: 'POST' }), env, admin);
  assert.equal(finalAdmin.status, 409);

  const denied = await handleAdminUserSettingsRequest(request('/api/users'), env, editor);
  assert.equal(denied.status, 403);
  assert.equal((await json(denied)).error.code, 'PERMISSION_DENIED');
});