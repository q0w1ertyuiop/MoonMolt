import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { run } from '../node/runtime.mjs';

const root = mkdtempSync(join(tmpdir(), 'moonmolt-demo-'));
const db = join(root, 'shop.db'), dir = join(root, 'migrations');
mkdirSync(dir);
const rows = sql => {
  const connection = new DatabaseSync(db, { readOnly: true });
  try { return connection.prepare(sql).all().map(r => ({ ...r })); }
  finally { connection.close(); }
};
const checked = async options => { const report = await run({ db, dir, ...options }); assert.equal(report.ok, true, JSON.stringify(report)); return report; };
try {
  const seed = new DatabaseSync(db);
  seed.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE orders(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),amount_cents INTEGER NOT NULL); INSERT INTO users VALUES(7,'王正'),(12,'MoonBit'); INSERT INTO orders VALUES(101,7,2599),(102,12,5000);");
  seed.close();
  for (const filename of readdirSync(new URL('./migrations/', import.meta.url))) copyFileSync(new URL('./migrations/' + filename, import.meta.url), join(dir, filename));
  const before = rows('SELECT * FROM orders ORDER BY id');
  const bytes = readFileSync(db);
  await checked({ command: 'rehearse', to: 2 });
  assert.deepEqual(readFileSync(db), bytes);
  const first = await checked({ command: 'apply', to: 2 });
  writeFileSync(join(dir, '000004_failure.sql'), "UPDATE orders SET amount_cents=0; INSERT INTO missing VALUES(1);");
  const expectedFailure = await run({ command: 'apply', db, dir, rebuild: true });
  assert.equal(expectedFailure.ok, false);
  assert.deepEqual(rows('SELECT id,user_id,amount_cents FROM orders ORDER BY id'), before);
  assert.equal(rows('SELECT * FROM __moonmigrate_history').length, 2);
  rmSync(join(dir, '000004_failure.sql'));
  const upgrade = await checked({ command: 'apply', rebuild: true });
  const repeat = await checked({ command: 'apply', rebuild: true });
  assert.equal(repeat.noop, true);
  const final = rows('SELECT * FROM orders ORDER BY id');
  assert.deepEqual(final.map(({ status, ...row }) => row), before);
  assert.deepEqual(rows('PRAGMA foreign_key_check'), []);
  const report = {
    generated_at: new Date().toISOString(), node: process.version,
    sqlite: rows('SELECT sqlite_version() AS version')[0].version,
    command: 'npm run build && npm run demo', seed: 'deterministic fixture; no random data',
    before, after: final, users: rows('SELECT * FROM users ORDER BY id'),
    rehearsed_without_modifying_source: true,
    applied_versions: rows('SELECT version FROM __moonmigrate_history').map(r => r.version),
    failure: { kind: expectedFailure.kind, stage: expectedFailure.stage, original_data_preserved: true },
    repeat_noop: repeat.noop, foreign_key_violations: 0,
    backups_created: readdirSync(`${db}.moonmolt-backups`).filter(name => name.endsWith('.sqlite')).length,
    first_upgrade_ms: first.result.applied.reduce((n, m) => n + Number(m.duration_ms), 0),
    rebuild_ms: upgrade.result.applied.reduce((n, m) => n + Number(m.duration_ms), 0),
  };
  if (process.argv.includes('--save-report')) writeFileSync(new URL('../docs/demo-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
