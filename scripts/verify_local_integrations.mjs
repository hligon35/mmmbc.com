import { spawn } from 'node:child_process';

const port = '8787';
const worker = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', port, '--env', 'production'
], { stdio: ['ignore', 'pipe', 'pipe'] });

let workerOutput = '';
worker.stdout.on('data', (chunk) => { workerOutput += chunk; });
worker.stderr.on('data', (chunk) => { workerOutput += chunk; });

async function waitUntilReady() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(workerOutput || 'Local Worker exited before becoming ready.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/public/announcements`);
      if (response.status > 0) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`Local Worker did not become ready.\n${workerOutput}`);
}

try {
  await waitUntilReady();
  const verify = spawn(process.execPath, ['./scripts/verify_integrations.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` }
  });
  const exitCode = await new Promise((resolve) => verify.on('exit', resolve));
  process.exitCode = Number(exitCode || 0);
} finally {
  worker.kill('SIGTERM');
}
