process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TestAdmin!1';

const fs = require('fs');
const os = require('os');
const path = require('path');

const stamp = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
const tempDataDir = path.join(os.tmpdir(), `mmmbc-admin-request-id-data-${stamp}`);
const tempUploadsDir = path.join(os.tmpdir(), `mmmbc-admin-request-id-uploads-${stamp}`);
const tempSessionsDir = path.join(os.tmpdir(), `mmmbc-admin-request-id-sessions-${stamp}`);

process.env.ADMIN_DATA_DIR = tempDataDir;
process.env.ADMIN_UPLOADS_DIR = tempUploadsDir;
process.env.SESSIONS_DIR = tempSessionsDir;

const request = require('supertest');

const { app, boot } = require('./server');

describe('admin API request ids and auth errors', () => {
  beforeAll(async () => {
    await boot({ listen: false });
  });

  afterAll(() => {
    try { fs.rmSync(tempDataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempUploadsDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempSessionsDir, { recursive: true, force: true }); } catch {}
  });

  test('public auth providers response includes a request id header', async () => {
    const res = await request(app).get('/api/auth/providers');

    expect(res.status).toBe(200);
    expect(typeof res.headers['x-request-id']).toBe('string');
    expect(res.headers['x-request-id']).not.toHaveLength(0);
    expect(res.body).toHaveProperty('google');
  });

  test('csrf endpoint returns structured session-expired metadata when unauthenticated', async () => {
    const res = await request(app).get('/api/csrf');

    expect(res.status).toBe(401);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body).toMatchObject({
      error: 'Session expired. Sign in again.',
      code: 'SESSION_EXPIRED',
      requestId: res.headers['x-request-id']
    });
  });

  test('storage health endpoint is protected and returns structured auth failure', async () => {
    const res = await request(app).get('/api/admin/storage-health');

    expect(res.status).toBe(401);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body).toMatchObject({
      error: 'Session expired. Sign in again.',
      code: 'SESSION_EXPIRED',
      requestId: res.headers['x-request-id']
    });
  });

  test('authenticated non-developers receive a 403 from developer diagnostics endpoints', async () => {
    process.env.DEVELOPER_EMAILS = 'developer@example.com';
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD
    });

    expect(login.status).toBe(200);

    const res = await agent.get('/api/admin/storage-health');

    expect(res.status).toBe(403);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body).toMatchObject({
      error: 'Developer diagnostics access is required for this action.',
      code: 'DEVELOPER_DIAGNOSTICS_REQUIRED',
      requestId: res.headers['x-request-id']
    });
  });

  test('developer allowlist enables /api/me capability and diagnostics access', async () => {
    process.env.DEVELOPER_EMAILS = process.env.ADMIN_EMAIL;
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD
    });

    expect(login.status).toBe(200);

    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      user: {
        email: process.env.ADMIN_EMAIL,
        developer: true
      },
      capabilities: {
        developer: true,
        diagnostics: {
          view: true
        }
      }
    });

    const res = await agent.get('/api/admin/integration-health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      actor: process.env.ADMIN_EMAIL
    });
  });
});