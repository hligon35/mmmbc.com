import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const checks = [
  ['Admin migrations', 'npm', ['run', 'migrate:local:admin']],
  ['Site migrations', 'npm', ['run', 'migrate:local:site']],
  ['Tests', 'npm', ['test']],
  ['Admin tests', 'npm', ['run', 'test:admin']],
  ['Static build', 'npm', ['run', 'build:cf']],
  ['Integration audit', 'npm', ['run', 'verify:integrations']],
  ['Production dry run', 'npm', ['run', 'worker:dry-run']],
  ['Preview dry run', 'npm', ['run', 'preview:dry-run']],
  ['Dependency audit', 'npm', ['audit', '--omit=dev', '--audit-level=high']],
  ['Outdated dependencies', 'npm', ['outdated']]
];

const results = [];
for (const [name, command, args] of checks) {
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    results.push({ name, status: 'PASS', detail: output.trim().slice(-3000) || 'Completed successfully.' });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || error).trim().slice(-3000);
    const informational = name === 'Outdated dependencies';
    results.push({ name, status: informational ? 'REVIEW' : 'FAIL', detail: detail || 'Command failed.' });
  }
}

const escapeCell = (value) => String(value || '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
const generatedAt = new Date().toISOString();
const rows = results.map((result) => `| ${escapeCell(result.name)} | ${result.status} | ${escapeCell(result.detail)} |`).join('\n');
const failed = results.filter((result) => result.status === 'FAIL').length;
const report = `# Monthly Maintenance Report

Generated: ${generatedAt}

Status: ${failed ? `FAILED (${failed} required checks)` : 'PASSED'}

| Check | Result | Detail |
| --- | --- | --- |
${rows}

## Human review

- Review dependency changes and every failed or review item before merging.
- Confirm no credential, production data, or local Wrangler state is committed.
- This workflow does not deploy, merge, rotate secrets, or run remote migrations.
`;

writeFileSync('monthlyReport.md', report);
if (failed) process.exitCode = 1;
