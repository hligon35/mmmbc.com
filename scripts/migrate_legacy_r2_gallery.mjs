import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function readLegacyKeys() {
  const command = "& npx wrangler d1 execute mmdb --remote --command 'SELECT DISTINCT file_key FROM gallery_items WHERE file_key IS NOT NULL AND file_key <> '''' ORDER BY file_key' --json";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  const start = output.indexOf('[');
  if (start < 0) throw new Error('Could not parse legacy gallery keys.');
  return JSON.parse(output.slice(start))[0]?.results?.map((row) => String(row.file_key || '').trim()).filter(Boolean) || [];
}

function contentTypeFor(key) {
  const extension = key.toLowerCase().split('.').pop();
  return {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif'
  }[extension] || 'application/octet-stream';
}

function copyObject(key) {
  const temp = join(tmpdir(), `mmmbc-r2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  const source = `mmmbc-gallery/${key}`;
  const destination = `mmmbc/${key}`;
  const escapedTemp = temp.replaceAll('`', '``');
  const escapedSource = source.replaceAll('"', '`"');
  const escapedDestination = destination.replaceAll('"', '`"');
  const mime = contentTypeFor(key);
  const command = [
    `$temp = '${escapedTemp}'`,
    `npx wrangler r2 object get "${escapedSource}" --remote --file $temp`,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    `npx wrangler r2 object put "${escapedDestination}" --remote --file $temp --content-type "${mime}" --force`,
    '$code = $LASTEXITCODE',
    'Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue',
    'exit $code'
  ].join('; ');

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
      stdio: 'ignore',
      timeout: 120000
    });
  } finally {
    try { unlinkSync(temp); } catch { /* ignore cleanup failures */ }
  }
}

const keys = readLegacyKeys();
console.log(`Copying ${keys.length} R2 gallery objects from mmmbc-gallery to mmmbc.`);
for (let index = 0; index < keys.length; index += 1) {
  copyObject(keys[index]);
  if ((index + 1) % 25 === 0 || index + 1 === keys.length) {
    console.log(`Copied ${index + 1}/${keys.length}`);
  }
}