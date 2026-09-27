const fs = require('fs');
const os = require('os');
const path = require('path');

describe('admin production startup guards', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('boot blocks when shared session store is required but not shared', async () => {
    const stamp = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const tempDataDir = path.join(os.tmpdir(), `mmmbc-admin-test-data-${stamp}`);
    const tempUploadsDir = path.join(os.tmpdir(), `mmmbc-admin-test-uploads-${stamp}`);
    const tempSessionsDir = path.join(os.tmpdir(), `mmmbc-admin-test-sessions-${stamp}`);

    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'test-session-secret';
    process.env.REQUIRE_SHARED_SESSION_STORE_IN_PROD = 'true';
    process.env.SESSION_STORE_MODE = 'file';
    process.env.POSTGRES_URL = '';
    process.env.DATABASE_URL = '';
    process.env.ADMIN_DATA_DIR = tempDataDir;
    process.env.ADMIN_UPLOADS_DIR = tempUploadsDir;
    process.env.SESSIONS_DIR = tempSessionsDir;

    const { boot } = require('./server');

    await expect(boot({ listen: false })).rejects.toThrow(
      'Production startup blocked: REQUIRE_SHARED_SESSION_STORE_IN_PROD=true but no shared session store is active.'
    );

    try { fs.rmSync(tempDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tempUploadsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tempSessionsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
