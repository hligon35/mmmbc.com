const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('supertest');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('admin auth + csrf', () => {
  let tmpData;
  let tmpSessions;
  let app;
  let boot;

  beforeAll(async () => {
    tmpData = mkTempDir('mmmbc-admin-data-');
    tmpSessions = mkTempDir('mmmbc-admin-sessions-');

    process.env.ADMIN_DATA_DIR = tmpData;
    process.env.SESSIONS_DIR = tmpSessions;
    process.env.SESSION_SECRET = 'test_session_secret_1234567890';
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.ADMIN_PASSWORD = 'Str0ng!Passw0rd';
    process.env.ENFORCE_HTTPS = 'false';
    process.env.SUPPORT_API_TOKEN = 'test_support_token_123';
    process.env.SUPPORT_DISABLE_SEND = 'true';

    ({ app, boot } = require('../server'));
    await boot({ listen: false });
  });

  afterAll(() => {
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tmpSessions, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('requires auth for /api/csrf', async () => {
    const res = await request(app).get('/api/csrf');
    expect(res.status).toBe(401);
  });

  test('login works and CSRF is enforced', async () => {
    const agent = request.agent(app);

    // login
    const login = await agent
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'Str0ng!Passw0rd' });
    expect(login.status).toBe(200);

    // get token
    const csrf = await agent.get('/api/csrf');
    expect(csrf.status).toBe(200);
    expect(typeof csrf.body.csrfToken).toBe('string');
    expect(csrf.body.csrfToken.length).toBeGreaterThan(10);

    // POST without CSRF should fail
    const bad = await agent
      .post('/api/announcements')
      .send({ title: 'Hello', body: 'World' });
    expect(bad.status).toBe(403);

    // POST with CSRF should succeed
    const ok = await agent
      .post('/api/announcements')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .send({ title: 'Hello', body: 'World' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });

  test('support endpoint accepts SUPPORT_API_TOKEN without CSRF', async () => {
    const res = await request(app)
      .post('/api/support/message')
      .set('X-Support-Token', 'test_support_token_123')
      .set('X-Support-Actor', 'support-emailer@test')
      .send({ subject: 'Test', message: 'Hello', replyTo: 'user@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // In tests we disable sending to avoid network calls.
    expect(res.body.disabled).toBe(true);
  });

  test('newsletter records draft and schedule lifecycle works', async () => {
    const agent = request.agent(app);

    const login = await agent
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'Str0ng!Passw0rd' });
    expect(login.status).toBe(200);

    const csrf = await agent.get('/api/csrf');
    expect(csrf.status).toBe(200);

    const seedSubscribers = await agent
      .put('/api/subscribers')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .send({
        subscribers: [
          { email: 'member1@example.com', name: 'Member One', group: 'members' },
          { email: 'member2@example.com', name: 'Member Two', group: 'members' }
        ]
      });
    expect(seedSubscribers.status).toBe(200);

    const draftRes = await agent
      .post('/api/newsletter/records')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .send({
        action: 'save_draft',
        subject: 'Draft Subject',
        message: 'Draft Message',
        emails: ['member1@example.com']
      });
    expect(draftRes.status).toBe(200);
    expect(Array.isArray(draftRes.body.drafts)).toBe(true);
    expect(draftRes.body.drafts.length).toBeGreaterThan(0);

    const scheduleDate = new Date(Date.now() + (2 * 60 * 60 * 1000));
    const yyyy = String(scheduleDate.getUTCFullYear());
    const mm = String(scheduleDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(scheduleDate.getUTCDate()).padStart(2, '0');
    const hh = String(scheduleDate.getUTCHours()).padStart(2, '0');
    const mi = String(scheduleDate.getUTCMinutes()).padStart(2, '0');

    const scheduleRes = await agent
      .post('/api/newsletter/records')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .send({
        action: 'schedule',
        subject: 'Scheduled Subject',
        message: 'Scheduled Message',
        emails: ['member1@example.com', 'member2@example.com'],
        scheduleDate: `${yyyy}-${mm}-${dd}`,
        scheduleTime: `${hh}:${mi}`,
        scheduleTimezone: 'UTC'
      });
    expect(scheduleRes.status).toBe(200);
    expect(Array.isArray(scheduleRes.body.scheduled)).toBe(true);
    expect(scheduleRes.body.scheduled.length).toBeGreaterThan(0);

    const scheduledId = String(scheduleRes.body.scheduled[0].id || '');
    expect(scheduledId.length).toBeGreaterThan(0);

    const deleteRes = await agent
      .post('/api/newsletter/records')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .send({ action: 'delete', id: scheduledId });
    expect(deleteRes.status).toBe(200);
    expect((deleteRes.body.scheduled || []).some((r) => String(r.id) === scheduledId)).toBe(false);

    const testSendRes = await agent
      .post('/api/newsletter/test')
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .send({ subject: 'Test Subject', message: 'Hello from test' });
    expect(testSendRes.status).toBe(200);
    expect(testSendRes.body.ok).toBe(true);
    expect(testSendRes.body.disabled).toBe(true);
  });
});
