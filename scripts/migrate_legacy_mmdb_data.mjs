import { execFileSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = 'mmdb';
const destination = 'admin';

function runD1(database, sql) {
  const sqlFile = join(tmpdir(), `mmmbc-d1-${process.pid}-${Date.now()}.sql`);
  writeFileSync(sqlFile, sql, 'utf8');
  let output;
  try {
    const command = `npx.cmd wrangler d1 execute ${database} --remote --file ${sqlFile} --json`;
    output = execFileSync('cmd.exe', ['/d', '/s', '/c', command], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
  } finally {
    try { unlinkSync(sqlFile); } catch { /* ignore cleanup failures */ }
  }
  const start = output.indexOf('[');
  if (start < 0) throw new Error(`Could not parse Wrangler output for ${database}.`);
  const parsed = JSON.parse(output.slice(start));
  return parsed[0]?.results || [];
}

function readD1(database, table) {
  const command = `& npx wrangler d1 execute ${database} --remote --command 'SELECT * FROM ${table}' --json`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  const start = output.indexOf('[');
  if (start < 0) throw new Error(`Could not parse Wrangler output for ${database}.`);
  const parsed = JSON.parse(output.slice(start));
  return parsed[0]?.results || [];
}

function sqlText(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function copyTable(table) {
  const rows = readD1(source, table);
  if (!rows.length) {
    console.log(`${table}: 0 rows`);
    return;
  }

  const columns = Object.keys(rows[0]);
  const statements = rows.map((row) => {
    const values = columns.map((column) => sqlText(row[column])).join(', ');
    return `INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${values});`;
  });

  let chunk = '';
  let copied = 0;
  for (const statement of statements) {
    if (chunk.length + statement.length > 70000) {
      runD1(destination, chunk);
      chunk = '';
    }
    chunk += statement;
    copied += 1;
  }
  try {
    if (chunk) runD1(destination, chunk);
  } catch (error) {
    throw new Error(`Failed while copying ${table}: ${error.message}`);
  }
  console.log(`${table}: copied ${copied} rows`);
}

runD1(destination, `CREATE TABLE IF NOT EXISTS gallery_items (
  id TEXT PRIMARY KEY,
  album TEXT NOT NULL,
  label TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  file_key TEXT NOT NULL,
  thumb_key TEXT,
  original_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  position INTEGER,
  is_hidden INTEGER NOT NULL DEFAULT 0
)`);

runD1(destination, `CREATE TABLE IF NOT EXISTS gallery_preferences (
  id INTEGER PRIMARY KEY,
  show_image_names INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
)`);

for (const table of [
  'gallery_items',
  'gallery_preferences',
  'directory_contacts',
  'finance_donors',
  'finance_entries'
]) copyTable(table);