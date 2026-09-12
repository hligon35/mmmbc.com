import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import XLSX from 'xlsx';
import { isValidEmail, normalizeEmail } from '../src/admin-auth.js';
import { normalizeRole } from '../src/admin-rbac.js';

const VALID_STATUSES = new Set(['pending', 'active', 'suspended', 'revoked']);

function parseArgs(argv) {
  const args = { apply: false, local: false, remote: false, env: '', input: '', confirmProduction: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--local') args.local = true;
    else if (value === '--remote') args.remote = true;
    else if (value === '--confirm-production') args.confirmProduction = true;
    else if (value === '--input') args.input = argv[++index] || '';
    else if (value === '--env') args.env = argv[++index] || '';
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.input) throw new Error('Provide --input admin-roster.local.json or --input admin-roster.local.csv.');
  if (args.local === args.remote) throw new Error('Choose exactly one database target: --local or --remote.');
  if (args.local && args.env) throw new Error('--env is only valid with --remote.');
  if (args.remote && !['preview', 'production'].includes(args.env)) throw new Error('Remote imports require --env preview or --env production.');
  if (args.apply && args.env === 'production' && !args.confirmProduction) throw new Error('Production apply requires --confirm-production.');
  return args;
}

function readRows(inputPath) {
  if (extname(inputPath).toLowerCase() === '.json') {
    const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('JSON input must contain an array of administrator rows.');
    return parsed;
  }
  const workbook = XLSX.readFile(inputPath, { raw: false });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
}

function field(row, names) {
  for (const [key, value] of Object.entries(row || {})) {
    if (names.includes(key.trim().toLowerCase())) return String(value ?? '').trim();
  }
  return '';
}

function normalizeRows(rows) {
  const valid = [];
  const invalid = [];
  const skipped = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    const email = normalizeEmail(field(row, ['email', 'email address']));
    const fullName = field(row, ['full_name', 'full name', 'name']).replace(/\s+/g, ' ').slice(0, 120);
    const role = normalizeRole(field(row, ['role', 'standard role']));
    const status = field(row, ['status', 'approval status']).toLowerCase() || 'pending';
    const reason = !isValidEmail(email) ? 'invalid email'
      : !fullName ? 'missing full name'
        : !role ? 'invalid role'
          : !VALID_STATUSES.has(status) ? 'invalid status' : '';
    if (reason) invalid.push({ row: index + 2, email, reason });
    else if (seen.has(email)) skipped.push({ row: index + 2, email, reason: 'duplicate input email' });
    else {
      seen.add(email);
      valid.push({ email, fullName, role, status });
    }
  });
  return { valid, invalid, skipped };
}

function sqlText(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function wranglerArgs(args, extra) {
  const target = args.local ? ['--local'] : ['--remote', '--env', args.env];
  return ['wrangler', 'd1', 'execute', 'mmdb', ...target, ...extra];
}

function runWrangler(args, extra) {
  const commandArgs = wranglerArgs(args, extra);
  const wranglerCli = resolve(import.meta.dirname, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  commandArgs.splice(0, 1, wranglerCli);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Wrangler command failed.').trim());
  return result.stdout;
}

function existingEmails(args, rows) {
  if (!rows.length) return new Set();
  const values = rows.map(({ email }) => sqlText(email)).join(', ');
  const output = runWrangler(args, ['--command', `SELECT lower(email) AS email FROM admin_users WHERE lower(email) IN (${values})`, '--json']);
  const parsed = JSON.parse(output);
  const sets = Array.isArray(parsed) ? parsed : [parsed];
  const records = sets.flatMap((entry) => entry?.results || entry?.result?.[0]?.results || []);
  return new Set(records.map((record) => normalizeEmail(record.email)).filter(Boolean));
}

function buildUpsertSql(rows) {
  const now = new Date().toISOString();
  const statements = rows.map((row) => `INSERT INTO admin_users (
  id, email, full_name, role, status, invited_by, invited_at, activated_at, last_login_at, created_at, updated_at
) VALUES (
  lower(hex(randomblob(16))), ${sqlText(row.email)}, ${sqlText(row.fullName)}, ${sqlText(row.role)}, ${sqlText(row.status)},
  'roster-import', ${sqlText(now)}, ${row.status === 'active' ? sqlText(now) : 'NULL'}, NULL, ${sqlText(now)}, ${sqlText(now)}
) ON CONFLICT(email) DO UPDATE SET
  full_name = excluded.full_name,
  role = excluded.role,
  status = excluded.status,
  activated_at = CASE WHEN excluded.status = 'active' THEN coalesce(admin_users.activated_at, excluded.activated_at) ELSE admin_users.activated_at END,
  updated_at = excluded.updated_at;`);
  return `BEGIN TRANSACTION;\n${statements.join('\n')}\nCOMMIT;\n`;
}

function printSummary(summary, dryRun) {
  console.log(`${dryRun ? 'Dry run' : 'Import'} summary`);
  console.log(`Inserted: ${summary.inserted}`);
  console.log(`Updated: ${summary.updated}`);
  console.log(`Skipped: ${summary.skipped.length}`);
  console.log(`Invalid: ${summary.invalid.length}`);
  for (const item of [...summary.skipped, ...summary.invalid]) {
    console.log(`Row ${item.row}: ${item.email || '(no email)'} - ${item.reason}`);
  }
}

let tempDirectory = '';
try {
  const args = parseArgs(process.argv.slice(2));
  const normalized = normalizeRows(readRows(resolve(args.input)));
  const existing = existingEmails(args, normalized.valid);
  const inserted = normalized.valid.filter((row) => !existing.has(row.email)).length;
  const updated = normalized.valid.length - inserted;
  printSummary({ inserted, updated, skipped: normalized.skipped, invalid: normalized.invalid }, !args.apply);
  if (!args.apply || !normalized.valid.length) {
    process.exitCode = normalized.invalid.length ? 2 : 0;
  } else {
    tempDirectory = mkdtempSync(join(tmpdir(), 'mmmbc-admin-import-'));
    const sqlPath = join(tempDirectory, 'import.sql');
    writeFileSync(sqlPath, buildUpsertSql(normalized.valid), { encoding: 'utf8', mode: 0o600 });
    runWrangler(args, ['--file', sqlPath]);
    console.log('Import applied. No invitation emails were sent.');
    process.exitCode = normalized.invalid.length ? 2 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
}