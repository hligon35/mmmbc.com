process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';

const request = require('supertest');

const { app } = require('./server');

describe('admin API request ids and auth errors', () => {
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
});