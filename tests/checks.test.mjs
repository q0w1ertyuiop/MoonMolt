import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run } from '../node/runtime.mjs';
import { Adapter } from '../node/adapter.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-checks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), dir = join(root, 'migrations');
  mkdirSync(dir);
  const connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,amount_cents INTEGER); INSERT INTO orders VALUES(101,2599),(102,5000);'); connection.close();
  const sqlPath = join(dir, '000001_status.sql'), checksPath = join(dir, '000001_status.checks.json');
  writeFileSync(sqlPath, "ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'paid';");
  return { db, dir, sqlPath, checksPath, checks(checks) { writeFileSync(checksPath, JSON.stringify({ checks })); } };
}
function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { rows: db.prepare('SELECT * FROM orders ORDER BY id').all().map(r => ({ ...r })), history: db.prepare("SELECT name FROM sqlite_schema WHERE name='__moonmigrate_history'").all().length }; }
  finally { db.close(); }
}
const valid = [
  { name: 'order amounts preserved', sql: 'SELECT COUNT(*)=2 AND SUM(amount_cents)=7599 FROM orders;' },
  { name: 'all statuses set', sql: "-- 中文名称 / a;b\nWITH missing AS (SELECT * FROM orders WHERE status<>'paid') SELECT NOT EXISTS(SELECT 1 FROM missing); /* tail ; */" },
];

test('business checks run in rehearsal and real upgrade and appear in reports', async t => {
  const f = fixture(t); f.checks(valid);
  const bytes = readFileSync(f.db);
  const rehearsal = await run({ command: 'rehearse', ...f });
  assert.equal(rehearsal.ok, true, JSON.stringify(rehearsal));
  assert.equal(rehearsal.rehearsal.checks.length, 2);
  assert.deepEqual(readFileSync(f.db), bytes);
  const applied = await run({ command: 'apply', ...f });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.result.checks.map(c => c.name), valid.map(c => c.name));
  assert.equal(applied.result.applied[0].tool_version, '0.4.0');
  assert.equal((await run({ command: 'apply', ...f })).noop, true);
});

test('schema-valid lossy upgrade fails business checks without touching the source', async t => {
  const f = fixture(t); f.checks(valid);
  writeFileSync(f.sqlPath, "ALTER TABLE orders ADD COLUMN status TEXT DEFAULT 'paid'; UPDATE orders SET amount_cents=0;");
  const result = await run({ command: 'apply', ...f });
  assert.equal(result.kind, 'policy'); assert.equal(result.stage, 'rehearse');
  assert.match(result.message, /order amounts preserved/);
  assert.deepEqual(inspect(f.db), { rows: [{ id: 101, amount_cents: 2599 }, { id: 102, amount_cents: 5000 }], history: 0 });
});

test('actual business failure after successful rehearsal rolls back schema and history', async t => {
  const f = fixture(t); f.checks(valid);
  const original = Adapter.prototype.check;
  Adapter.prototype.check = function(id, sql, name, filename) {
    if (id === 'source') this.db(id).exec('UPDATE orders SET amount_cents=0;');
    return original.call(this, id, sql, name, filename);
  };
  let result;
  try { result = await run({ command: 'apply', ...f }); } finally { Adapter.prototype.check = original; }
  assert.equal(result.kind, 'policy'); assert.equal(result.stage, 'apply');
  assert.equal(inspect(f.db).history, 0); assert.equal(inspect(f.db).rows[0].amount_cents, 2599);
});

test('checks cannot write or hide additional statements and require a scalar INTEGER true', async t => {
  for (const sql of [
    'UPDATE orders SET amount_cents=0 RETURNING 1;', 'DELETE FROM orders RETURNING 1;',
    'PRAGMA user_version=123;', 'COMMIT;', 'SELECT 1; UPDATE orders SET amount_cents=0;',
    'SELECT 1; SELECT 0;', 'SELECT 0;', 'SELECT NULL;', "SELECT '1';", 'SELECT 1.0;',
    'SELECT 1,1;', 'SELECT 1 AS ok,0 AS ok;', 'SELECT 1 WHERE 0;', 'SELECT 1 FROM orders;',
    'SELECT 1 FROM __moonmigrate_history;',
  ]) {
    const f = fixture(t); f.checks([{ name: 'reject unsafe or ambiguous check', sql }]);
    const result = await run({ command: 'apply', ...f });
    assert.equal(result.kind, 'policy', JSON.stringify({ sql, result }));
    assert.equal(inspect(f.db).rows[0].amount_cents, 2599); assert.equal(inspect(f.db).history, 0);
  }
});

test('editing or removing checks invalidates the applied migration checksum', async t => {
  const f = fixture(t); f.checks(valid);
  assert.equal((await run({ command: 'apply', ...f })).ok, true);
  f.checks([{ name: 'weakened', sql: 'SELECT 1;' }]);
  assert.equal((await run({ command: 'status', ...f })).kind, 'history_mismatch');
  rmSync(f.checksPath);
  assert.equal((await run({ command: 'status', ...f })).kind, 'history_mismatch');
});

test('old SQL-only history remains valid and checks are immutable during backup', async t => {
  const f = fixture(t);
  assert.equal((await run({ command: 'apply', ...f })).ok, true);
  assert.equal((await run({ command: 'status', ...f })).ok, true);
  f.checks(valid);
  assert.equal((await run({ command: 'status', ...f })).kind, 'history_mismatch');
  const fresh = fixture(t); fresh.checks(valid);
  const original = Adapter.prototype.makeBackup;
  Adapter.prototype.makeBackup = async function(command) {
    fresh.checks([{ name: 'changed while waiting', sql: 'SELECT 0;' }]);
    return original.call(this, command);
  };
  let result;
  try { result = await run({ command: 'apply', ...fresh }); } finally { Adapter.prototype.makeBackup = original; }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.checks[0].name, valid[0].name);
  assert.equal((await run({ command: 'status', ...fresh })).kind, 'history_mismatch');
});

test('malformed, duplicate, unknown-field and orphan manifests fail before opening source', async t => {
  for (const document of [null, {}, { checks: [] }, { checks: valid, typo: true }, { checks: [{ name: 'a', sql: 'SELECT 1;', typo: true }] }, { checks: [{ name: 'a', sql: 'SELECT 1;' }, { name: 'a', sql: 'SELECT 1;' }] }]) {
    const f = fixture(t); writeFileSync(f.checksPath, JSON.stringify(document));
    const result = await run({ command: 'apply', ...f });
    assert.equal(result.kind, 'input'); assert.equal(result.stage, 'prepare');
    assert.equal(inspect(f.db).history, 0);
  }
  const f = fixture(t); writeFileSync(join(f.dir, '000002_typo.checks.json'), JSON.stringify({ checks: valid }));
  assert.match((await run({ command: 'status', ...f })).message, /orphan/);
});

test('UTF-8 BOM manifests are supported and invalid bytes fail closed', async t => {
  const f = fixture(t);
  writeFileSync(f.checksPath, '\uFEFF' + JSON.stringify({ checks: valid }));
  assert.equal((await run({ command: 'apply', ...f })).ok, true);
  const invalid = fixture(t); writeFileSync(invalid.checksPath, Buffer.from([0xff]));
  assert.equal((await run({ command: 'apply', ...invalid })).kind, 'input');
  writeFileSync(invalid.checksPath, '{');
  assert.equal((await run({ command: 'status', ...invalid })).kind, 'input');
});

test('CLI reports verified checks and preserves policy exit codes for business failures', t => {
  const f = fixture(t); f.checks(valid);
  const applied = spawnSync(process.execPath, ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir], { encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr); assert.match(applied.stdout, /Business checks passed: 2/);
  const bad = fixture(t); bad.checks([{ name: 'requires manual correction', sql: 'SELECT 0;' }]);
  const failed = spawnSync(process.execPath, ['node/cli.mjs', 'apply', '--db', bad.db, '--dir', bad.dir, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(failed.status, 2, failed.stderr);
  const report = JSON.parse(failed.stderr.split('\n').find(line => line.startsWith('{')));
  assert.equal(report.kind, 'policy'); assert.match(report.message, /requires manual correction/);
});
