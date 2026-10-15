import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run, runInWorker } from '../node/runtime.mjs';
import { Adapter } from '../node/adapter.mjs';

function connection(path, fn, options = {}) {
  const db = new DatabaseSync(path, options);
  try { return fn(db); } finally { db.close(); }
}
function fixture(t, sql = 'CREATE TABLE t(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO t VALUES(1,10);') {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-verification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), dir = join(root, 'migrations'); mkdirSync(dir);
  connection(db, db => db.exec('PRAGMA application_id=321;' + sql));
  const migrations = [
    { filename: '000001_label.sql', sql: 'ALTER TABLE t ADD COLUMN label TEXT;' },
    { filename: '000002_value.sql', sql: 'UPDATE t SET value=value+1;' },
  ];
  return { root, db, dir, migrations };
}

test('verify checks a retained pre-upgrade backup without applying its pending migration', async t => {
  const f = fixture(t);
  assert.equal((await run({ command: 'apply', db: f.db, migrations: f.migrations, to: 1 })).ok, true);
  const upgrade = await runInWorker({ command: 'apply', db: f.db, migrations: f.migrations }); assert.equal(upgrade.ok, true);
  const before = readFileSync(upgrade.backup), files = readdirSync(f.root).sort(), events = [];
  const verified = await runInWorker({ command: 'verify', db: upgrade.backup, migrations: f.migrations, expected_application_id: 321, expected_version: 1 }, { onProgress: e => events.push(e) });
  assert.equal(verified.ok, true, JSON.stringify(verified)); assert.equal(verified.verified, true); assert.equal(verified.database_modified, false);
  assert.deepEqual(verified.validation, { integrity_check: 'ok', foreign_key_check: 'ok' });
  assert.equal(verified.current_version, 1); assert.deepEqual(verified.pending, ['000002_value.sql']);
  assert.deepEqual(readFileSync(upgrade.backup), before); assert.deepEqual(readdirSync(f.root).sort(), files);
  assert.equal(connection(upgrade.backup, db => db.prepare('SELECT value FROM t').get().value), 10);
  assert.equal(connection(f.db, db => db.prepare('SELECT value FROM t').get().value), 11);
  assert.equal(verified.backup, undefined); assert.equal(verified.report_path, undefined);
  assert.equal(events.some(e => e.operation === 'verify' && e.state === 'complete'), true);
  assert.equal(events.some(e => ['exec_script', 'backup', 'capture_value', 'exec_check', 'commit'].includes(e.operation)), false);
});

test('verification runs full index consistency checks that quick_check does not perform', async t => {
  const f = fixture(t);
  connection(f.db, db => db.exec("CREATE INDEX idx ON t(value); PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql='CREATE INDEX idx ON t(id)' WHERE name='idx'; PRAGMA writable_schema=OFF;"), { defensive: false });
  const before = readFileSync(f.db);
  assert.equal(connection(f.db, db => db.prepare('PRAGMA quick_check').get().quick_check), 'ok');
  assert.equal((await run({ command: 'status', db: f.db, migrations: [] })).ok, true);
  const report = await run({ command: 'verify', db: f.db, migrations: [] });
  assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.match(report.message, /missing from index idx/);
  assert.deepEqual(readFileSync(f.db), before);
});

test('no pending migrations do not suppress verification of current foreign keys', async t => {
  const f = fixture(t, 'CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE t(id INTEGER PRIMARY KEY,value INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(10); INSERT INTO t VALUES(1,10);');
  f.migrations[1].sql = 'CREATE INDEX t_value ON t(value);';
  assert.equal((await run({ command: 'apply', db: f.db, migrations: f.migrations })).ok, true);
  connection(f.db, db => db.exec('PRAGMA foreign_keys=OFF; UPDATE t SET value=99;'));
  const before = readFileSync(f.db);
  assert.equal((await run({ command: 'status', db: f.db, migrations: f.migrations })).noop, true);
  const report = await runInWorker({ command: 'verify', db: f.db, migrations: f.migrations });
  assert.equal(report.kind, 'policy'); assert.match(report.message, /foreign key check failed/);
  assert.deepEqual(readFileSync(f.db), before);
});

test('verify checks history checksums, schema drift and identity/version expectations', async t => {
  const f = fixture(t);
  assert.equal((await run({ command: 'apply', db: f.db, migrations: f.migrations })).ok, true);
  for (const options of [{ expected_application_id: 999 }, { expected_version: 0 }]) {
    const events = [];
    const report = await run({ command: 'verify', db: f.db, migrations: f.migrations, ...options }, { onProgress: e => events.push(e) });
    assert.equal(report.kind, 'policy'); assert.equal(events.some(e => e.operation === 'verify'), false);
  }
  const altered = f.migrations.map(entry => ({ ...entry, sql: entry.sql + ' -- edited' }));
  assert.equal((await run({ command: 'verify', db: f.db, migrations: altered })).kind, 'history_mismatch');
  assert.equal((await run({ command: 'verify', db: f.db, migrations: [] })).kind, 'history_mismatch');
  connection(f.db, db => db.exec('CREATE TABLE outside(x);'));
  assert.equal((await run({ command: 'verify', db: f.db, migrations: f.migrations })).kind, 'history_mismatch');
});

test('large foreign-key failure reports are bounded for verify and migration validation', async t => {
  const f = fixture(t, 'CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(pid INTEGER REFERENCES parent(id)); PRAGMA foreign_keys=OFF; WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<500) INSERT INTO child SELECT n FROM ids;');
  for (const command of ['verify', 'apply']) {
    const report = await run({ command, db: f.db, migrations: [{ filename: '000001_noop.sql', sql: 'SELECT 1;' }] });
    assert.equal(report.kind, 'policy'); assert.match(report.message, /additional findings omitted/);
    const details = report.message.match(/^foreign key check failed: (\[.*\]); additional findings omitted$/);
    assert.ok(details); assert.equal(JSON.parse(details[1]).length, 20); assert.ok(report.message.length < 5000);
  }
  assert.equal(connection(f.db, db => db.prepare('SELECT COUNT(*) AS count FROM child').get().count), 500);
});

test('verify observes a single WAL snapshot while another process upgrades the source', async t => {
  const f = fixture(t, 'PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO t VALUES(1,10);');
  assert.equal((await run({ command: 'apply', db: f.db, migrations: f.migrations, to: 1 })).ok, true);
  const runtime = new URL('../node/runtime.mjs', import.meta.url).href, original = Adapter.prototype.dispatch;
  let upgraded = false;
  Adapter.prototype.dispatch = function(op, args) {
    if (op === 'verify' && !upgraded) {
      upgraded = true;
      const script = `import {run} from ${JSON.stringify(runtime)}; const r=await run(${JSON.stringify({ command: 'apply', db: f.db, migrations: f.migrations })}); console.log(JSON.stringify(r)); process.exitCode=r.ok?0:1;`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
      assert.equal(child.status, 0, child.stderr);
    }
    return original.call(this, op, args);
  };
  let report;
  try { report = await run({ command: 'verify', db: f.db, migrations: f.migrations }); } finally { Adapter.prototype.dispatch = original; }
  assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.current_version, 1); assert.equal(report.pending.length, 1);
  assert.equal((await run({ command: 'verify', db: f.db, migrations: f.migrations })).current_version, 2);
});

test('verification never executes historical checks or invalid pending SQL', async t => {
  const f = fixture(t);
  f.migrations[1].checks_json = '{"checks":[{"name":"value was 11","sql":"SELECT value=11 FROM t;"}]}';
  assert.equal((await run({ command: 'apply', db: f.db, migrations: f.migrations })).ok, true);
  connection(f.db, db => db.exec('UPDATE t SET value=999;'));
  f.migrations.push({ filename: '000003_future.sql', sql: 'INSERT INTO nonexistent VALUES(:unbound);' });
  const report = await runInWorker({ command: 'verify', db: f.db, migrations: f.migrations });
  assert.equal(report.ok, true, JSON.stringify(report)); assert.deepEqual(report.pending, ['000003_future.sql']);
  assert.equal(connection(f.db, db => db.prepare('SELECT value FROM t').get().value), 999);
});

test('cancellation at the verification checkpoint is read-only and closes the snapshot', async t => {
  const f = fixture(t), before = readFileSync(f.db), controller = new AbortController();
  const report = await run({ command: 'verify', db: f.db, migrations: [] }, { signal: controller.signal,
    onProgress: e => { if (e.operation === 'verify' && e.state === 'start') controller.abort(); } });
  assert.equal(report.kind, 'cancelled'); assert.equal(report.exit_code, 4); assert.deepEqual(readFileSync(f.db), before);
  // A write lock can be acquired immediately after cleanup.
  connection(f.db, db => db.exec('BEGIN EXCLUSIVE; ROLLBACK;'));
});

test('verify rejects mutation/target flags and never creates a missing database', async t => {
  const f = fixture(t), missing = join(f.root, 'missing.db');
  for (const options of [{ create: true }, { rebuild: true }, { to: 1 }, { backup_dir: f.root }]) {
    const report = await run({ command: 'verify', db: missing, migrations: [], ...options });
    assert.equal(report.kind, 'input'); assert.equal(existsSync(missing), false);
  }
  assert.equal((await runInWorker({ command: 'verify', db: missing, migrations: [] })).kind, 'input');
  assert.equal(existsSync(missing), false);
  writeFileSync(missing, 'not a SQLite backup');
  assert.equal((await run({ command: 'verify', db: missing, migrations: [] })).ok, false);
  assert.equal(readFileSync(missing, 'utf8'), 'not a SQLite backup');
});

test('CLI supports read-only file verification, JSON reports and strict option scopes', t => {
  const f = fixture(t);
  const args = ['node/cli.mjs', 'verify', '--db', f.db, '--dir', f.dir, '--expected-application-id', '321', '--expected-version', '0', '--worker'];
  const result = spawnSync(process.execPath, [...args, '--format', 'json', '--progress'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).verified, true);
  const text = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /Database verification passed/);
  for (const options of [['--create'], ['--rebuild'], ['--to', '1'], ['--backup-dir', f.root]]) {
    const bad = spawnSync(process.execPath, [...args, ...options, '--format', 'json'], { encoding: 'utf8' });
    assert.equal(bad.status, 1); assert.match(bad.stderr, /does not apply/);
  }
});
