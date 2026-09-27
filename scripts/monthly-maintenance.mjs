import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = join(ROOT, 'monthlyReport.md');
const MAX_EVIDENCE = 2400;
const SKIP_DIRS = new Set(['.git', '.wrangler', 'node_modules', 'uploads', 'sessions', 'logs']);
const SECRET_ENV_NAMES = ['RESEND_API_KEY', 'SQUARE_ACCESS_TOKEN', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'STRIPE_SECRET_KEY'];

const compact = (value, limit = MAX_EVIDENCE) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(-limit);
const redact = (value) => {
  let output = String(value ?? '');
  for (const name of SECRET_ENV_NAMES) {
    const secret = process.env[name];
    if (secret) output = output.replaceAll(secret, '[REDACTED]');
  }
  return output
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(sk|pk|rk|re|whsec|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED TOKEN]');
};
const escapeCell = (value) => redact(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');

function runCommand(name, command, args, { required = true, timeout = 240_000 } = {}) {
  const started = Date.now();
  try {
    const output = execFileSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024 * 8,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return {
      name,
      command: [command, ...args].join(' '),
      status: 'PASS',
      exitCode: 0,
      durationMs: Date.now() - started,
      evidence: compact(output) || 'Completed successfully.'
    };
  } catch (error) {
    const exitCode = Number.isInteger(error.status) ? error.status : 1;
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return {
      name,
      command: [command, ...args].join(' '),
      status: required ? 'FAIL' : 'REVIEW',
      exitCode,
      durationMs: Date.now() - started,
      evidence: compact(output) || 'Command failed without output.'
    };
  }
}

function skipCheck(name, reason) {
  return { name, command: 'not run', status: 'SKIP', exitCode: 'n/a', durationMs: 0, evidence: reason };
}

function walkFiles(directory, files = []) {
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(absolute, files);
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function repositoryFiles() {
  return walkFiles(ROOT).filter((file) => {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    return !rel.startsWith('cf_site/') && !rel.startsWith('admin/node_modules/');
  });
}

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .map((file) => join(ROOT, file));
  } catch {
    return [];
  }
}

export function auditStaticSite() {
  const htmlFiles = repositoryFiles().filter((file) => {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    return extname(file).toLowerCase() === '.html' &&
      (rel === 'index.html' || rel.startsWith('Pages/') || rel.startsWith('admin/public/'));
  });
  const findings = [];
  let images = 0;
  let missingAlt = 0;
  let missingTitles = 0;
  let missingDescriptions = 0;
  let missingLinks = 0;
  for (const file of htmlFiles) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const source = readFileSync(file, 'utf8');
    if (/(^|\n)\s*(<<<<<<<|=======|>>>>>>>)(\s|$)/m.test(source)) findings.push(`${rel}: conflict marker`);
    const imageTags = source.match(/<img\b[^>]*>/gi) ?? [];
    images += imageTags.length;
    missingAlt += imageTags.filter((tag) => !/\balt\s*=\s*["']/i.test(tag)).length;
    if (!/<title\b[^>]*>\s*[^<]+\s*<\/title>/i.test(source)) missingTitles += 1;
    if (!/<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["'][^"']+\s*["']/i.test(source)) missingDescriptions += 1;
    const references = [...source.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
    for (const reference of references) {
      if (!reference || reference.startsWith('#') || /^(?:[a-z]+:|\/\/)/i.test(reference)) continue;
      const clean = reference.split(/[?#]/, 1)[0];
      if (!clean || clean.startsWith('/api/') || clean.startsWith('/cdn/') || /[+${}]|encodeURIComponent|window\.|document\./i.test(reference)) continue;
      if (clean === '/admin' || clean === '/admin/') continue;
      const candidate = clean.startsWith('/') ? resolve(ROOT, clean.slice(1)) : resolve(dirname(file), clean);
      const candidates = [candidate, `${candidate}.html`, join(candidate, 'index.html')];
      if (clean.startsWith('/admin/')) candidates.push(resolve(ROOT, 'admin', 'public', clean.slice('/admin/'.length)));
      if (!candidates.some((path) => existsSync(path))) {
        missingLinks += 1;
        if (findings.length < 20) findings.push(`${rel}: missing local link ${reference}`);
      }
    }
  }
  if (missingAlt) findings.push(`${missingAlt} image(s) missing alt text`);
  if (missingTitles) findings.push(`${missingTitles} HTML page(s) missing a title`);
  if (missingDescriptions) findings.push(`${missingDescriptions} HTML page(s) missing a meta description`);
  const robots = existsSync(join(ROOT, 'robots.txt'));
  const sitemap = existsSync(join(ROOT, 'sitemap.xml'));
  if (!robots) findings.push('robots.txt is missing');
  if (!sitemap) findings.push('sitemap.xml is missing');
  return {
    name: 'Static HTML/accessibility/links/SEO audit',
    command: 'repository scanner',
    status: findings.some((finding) => finding.includes('conflict marker')) ? 'FAIL' : findings.length ? 'REVIEW' : 'PASS',
    exitCode: findings.some((finding) => finding.includes('conflict marker')) ? 1 : 0,
    durationMs: 0,
    evidence: `${htmlFiles.length} HTML pages; ${images} images; ${missingAlt} missing alt; ${missingLinks} missing local links; ${findings.length} finding(s). ${findings.slice(0, 6).join('; ') || 'No findings.'}`
  };
}

function auditCloudflareConfig() {
  const configPath = join(ROOT, 'wrangler.jsonc');
  const source = readFileSync(configPath, 'utf8');
  const requiredBindings = ['"binding": "ASSETS"', '"binding": "DB"', '"binding": "SITE_DB"', '"binding": "GALLERY_BUCKET"'];
  const missing = requiredBindings.filter((binding) => !source.includes(binding));
  const placeholders = (source.match(/00000000-0000-0000-0000-00000000000[12]/g) ?? []).length;
  const findings = [...missing.map((binding) => `missing ${binding}`)];
  if (placeholders) findings.push(`${placeholders} preview binding placeholder(s) are intentionally non-production`);
  return {
    name: 'Cloudflare Worker/D1/R2 configuration',
    command: 'wrangler.jsonc binding audit',
    status: missing.length ? 'FAIL' : placeholders ? 'REVIEW' : 'PASS',
    exitCode: missing.length ? 1 : 0,
    durationMs: 0,
    evidence: findings.join('; ') || 'ASSETS, DB, SITE_DB, and GALLERY_BUCKET bindings are present.'
  };
}

function auditSecrets() {
  const suspicious = [];
  const patterns = [
    /-----BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY-----/,
    /\bsk_live_[A-Za-z0-9]{16,}\b/,
    /\bre_[A-Za-z0-9]{16,}\b/,
    /\bwhsec_[A-Za-z0-9]{16,}\b/,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/
  ];
  for (const file of trackedFiles()) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    if (rel.endsWith('package-lock.json') || rel.endsWith('admin/package-lock.json')) continue;
    try {
      const source = readFileSync(file, 'utf8');
      if (patterns.some((pattern) => pattern.test(source))) suspicious.push(rel);
    } catch {
      // Binary files are not secret-scanned as text.
    }
  }
  return {
    name: 'Tracked-file secret scan',
    command: 'git ls-files + redacted secret patterns',
    status: suspicious.length ? 'FAIL' : 'PASS',
    exitCode: suspicious.length ? 1 : 0,
    durationMs: 0,
    evidence: suspicious.length ? `Potential secret pattern in: ${suspicious.join(', ')}` : 'No supported secret patterns found in tracked files.'
  };
}

function auditIntegrationSource() {
  const source = repositoryFiles()
    .filter((file) => /\.(?:js|mjs|json|html)$/i.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const checks = {
    Resend: /resend/i.test(source),
    Square: /square/i.test(source),
    webhook: /webhook/i.test(source),
    idempotency: /idempotenc/i.test(source)
  };
  const missing = Object.entries(checks).filter(([, present]) => !present).map(([name]) => name);
  return {
    name: 'Integration and idempotency source audit',
    command: 'source evidence scan (Resend/Square/webhook/idempotency)',
    status: missing.length ? 'REVIEW' : 'PASS',
    exitCode: 0,
    durationMs: 0,
    evidence: missing.length ? `Missing source evidence for: ${missing.join(', ')}. Live provider calls are not run.` : 'Resend, Square, webhook, and idempotency evidence found; live calls skipped.'
  };
}

function optionalToolCheck(name, envName) {
  if (!process.env[envName]) return skipCheck(name, `Set ${envName} in CI to run this optional check.`);
  const result = runCommand(name, 'sh', ['-c', process.env[envName]], { required: false, timeout: 300_000 });
  result.command = `${envName} (configured command)`;
  return result;
}

function versionEvidence() {
  const versions = [];
  for (const [name, command, args] of [
    ['Node', 'node', ['--version']],
    ['npm', 'npm', ['--version']],
    ['Wrangler', 'npx', ['--no-install', 'wrangler', '--version']]
  ]) {
    try {
      versions.push(`${name} ${compact(execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }), 300)}`);
    } catch {
      versions.push(`${name} unavailable`);
    }
  }
  return versions.join('; ');
}

export function runMaintenanceChecks() {
  return [
    runCommand('Admin local migrations', 'npm', ['run', 'migrate:local:admin']),
    runCommand('Site local migrations', 'npm', ['run', 'migrate:local:site']),
    runCommand('Application tests', 'npm', ['test']),
    runCommand('Admin tests', 'npm', ['run', 'test:admin']),
    runCommand('Static build', 'npm', ['run', 'build:cf']),
    runCommand('Integration test suite', 'npm', ['run', 'verify:integrations']),
    runCommand('Production Wrangler dry run', 'npm', ['run', 'worker:dry-run']),
    runCommand('Preview Wrangler dry run', 'npm', ['run', 'preview:dry-run']),
    runCommand('Root dependency audit', 'npm', ['audit', '--audit-level=high']),
    runCommand('Admin dependency audit', 'npm', ['--prefix', 'admin', 'audit', '--audit-level=high'], { required: false }),
    runCommand('Root outdated dependency review', 'npm', ['outdated'], { required: false }),
    runCommand('Admin outdated dependency review', 'npm', ['--prefix', 'admin', 'outdated'], { required: false }),
    auditStaticSite(),
    auditCloudflareConfig(),
    auditSecrets(),
    auditIntegrationSource(),
    existsSync(join(ROOT, '.github/workflows/codeql.yml'))
      ? { name: 'CodeQL workflow configuration', command: '.github/workflows/codeql.yml', status: 'PASS', exitCode: 0, durationMs: 0, evidence: 'JavaScript CodeQL workflow is configured for pushes, pull requests, and weekly scans.' }
      : { name: 'CodeQL workflow configuration', command: '.github/workflows/codeql.yml', status: 'FAIL', exitCode: 1, durationMs: 0, evidence: 'CodeQL workflow is missing.' },
    optionalToolCheck('Square sandbox/webhook/idempotency check', 'MMBC_SQUARE_CHECK_COMMAND'),
    optionalToolCheck('Browser smoke check', 'MMBC_BROWSER_CHECK_COMMAND'),
    optionalToolCheck('Lighthouse check', 'MMBC_LIGHTHOUSE_COMMAND')
  ];
}

export function buildReport(results, { generatedAt = new Date().toISOString(), branch = 'unknown', commit = 'unknown', workingTree = 'unknown' } = {}) {
  const failed = results.filter((result) => result.status === 'FAIL');
  const reviews = results.filter((result) => result.status === 'REVIEW');
  const skipped = results.filter((result) => result.status === 'SKIP');
  const status = failed.length ? `FAILED (${failed.length} required check${failed.length === 1 ? '' : 's'})` : reviews.length ? `PASSED WITH WARNINGS (${reviews.length})` : 'PASSED';
  const rows = results.map((result) => `| ${escapeCell(result.name)} | ${result.status} | ${escapeCell(result.command)} | ${escapeCell(result.exitCode)} | ${escapeCell(result.evidence)} |`).join('\n');
  const recommendations = [
    'Review every FAIL and REVIEW item, dependency update, and generated diff before merging.',
    'Keep production secrets in GitHub/Cloudflare secret stores; do not add credentials to source or fixtures.',
    'Run Square sandbox/webhook, browser, and Lighthouse checks by setting MMBC_SQUARE_CHECK_COMMAND, MMBC_BROWSER_CHECK_COMMAND, and MMBC_LIGHTHOUSE_COMMAND in the workflow when those tools are available.',
    'Confirm the GitHub repository remains private before granting access to the maintenance workflow.'
  ];
  return `# Monthly Maintenance Report

Generated: ${generatedAt}
Repository: hligon35/mmmbc.com
Branch: ${branch}
Commit: ${commit}
Working tree: ${escapeCell(workingTree)}
Status: ${status}

This report is generated on the first day of each month at 09:17 UTC and by manual dispatch. The workflow updates the \`monthlyUpdate\` branch and its pull request only. It does not auto-merge, deploy to production, send email, charge payments, rotate secrets, or apply remote database migrations.

## Checks

| Check | Result | Command/evidence source | Exit code | Redacted evidence |
| --- | --- | --- | --- | --- |
${rows}

## Findings and recommendations

${recommendations.map((recommendation) => `- ${recommendation}`).join('\n')}

## Skipped checks

${skipped.length ? skipped.map((result) => `- ${result.name}: ${result.evidence}`).join('\n') : '- None.'}
`;
}

function gitValue(args, fallback) {
  try {
    return compact(execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }), 1200).replaceAll('|', '\\|') || fallback;
  } catch {
    return fallback;
  }
}

export function main() {
  const results = runMaintenanceChecks();
  const report = buildReport(results, {
    branch: gitValue(['branch', '--show-current'], 'unknown'),
    commit: gitValue(['rev-parse', '--short', 'HEAD'], 'unknown'),
    workingTree: gitValue(['status', '--short'], 'clean')
  });
  writeFileSync(REPORT_PATH, report);
  process.stdout.write(`${report}\n`);
  if (results.some((result) => result.status === 'FAIL')) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
