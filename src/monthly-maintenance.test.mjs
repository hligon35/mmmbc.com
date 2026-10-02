import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildReport } from '../scripts/monthly-maintenance.mjs';

test('monthly maintenance reports commands, exit codes, skips, and recommendations', () => {
  const report = buildReport([
    { name: 'Passing check', command: 'npm test', status: 'PASS', exitCode: 0, evidence: 'ok' },
    { name: 'Review check', command: 'npm outdated', status: 'REVIEW', exitCode: 1, evidence: 'package review needed' },
    { name: 'Skipped check', command: 'not run', status: 'SKIP', exitCode: 'n/a', evidence: 'not configured' }
  ], { branch: 'monthly-maintenance', commit: 'abc123', workingTree: 'clean' });

  assert.match(report, /Status: PASSED WITH WARNINGS/);
  assert.match(report, /npm test/);
  assert.match(report, /\| 1 \|/);
  assert.match(report, /## Skipped checks/);
  assert.match(report, /does not auto-merge, deploy to production/);
  assert.match(report, /private/);
});

test('monthly workflow preserves the required branch and review-only delivery model', () => {
  const workflow = readFileSync('.github/workflows/monthly-maintenance.yml', 'utf8');
  assert.match(workflow, /cron: "0 6,7 1 \* \*"/);
  assert.match(workflow, /monthly-maintenance/);
  assert.match(workflow, /gh pr edit/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /visibility.*private|private.*visibility/s);
  assert.match(workflow, /steps\.privacy\.outcome == 'success'/g);
  assert.doesNotMatch(workflow, /gh pr merge|npm run deploy|wrangler deploy --env production(?! --dry-run)/);
  assert.doesNotMatch(workflow, /git switch -C|git reset --hard/);
});

