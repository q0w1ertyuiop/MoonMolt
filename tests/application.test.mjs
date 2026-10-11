import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run, plan } from '../node/runtime.mjs';
import { Adapter } from '../node/adapter.mjs';

function fixture(t, sql = 'CREATE TABLE t(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO t VALUES(1,10);') {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-application-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), dir = join(root, 'migrations');
  mkdirSync(dir);
  const connection = new DatabaseSync(db);
  connection.exec(sql); connection.close();
  return { db, dir, add(version, sql) { writeFileSync(join(dir, `${String(version).padStart(6, '0')}_upgrade.sql`), sql); } };
}
function withDb(path, fn) {
  const db = new DatabaseSync(path);
  try { return fn(db); } finally { db.close(); }
}
const rebuild = `CREATE TABLE t_new(id INTEGER PRIMARY KEY AUTOINCREMENT,value INTEGER,label TEXT);
INSERT INTO t_new(id,value) SELECT id,value FROM t;
DROP TABLE t; ALTER TABLE t_new RENAME TO t;`;

test('deleted large AUTOINCREMENT IDs cannot be reused after a table rebuild', async t => {
  const f = fixture(t, 'CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT,value INTEGER); INSERT INTO t VALUES(1,10),(9007199254740993,20); DELETE FROM t WHERE id>1;');
  f.add(1, rebuild);
  const rejected = await run({ command: 'apply', ...f, rebuild: true });
  assert.equal(rejected.kind, 'policy', JSON.stringify(rejected));
  assert.match(rejected.message, /AUTOINCREMENT high-water/);
  withDb(f.db, db => {
    const seq = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?'); seq.setReadBigInts(true);
    assert.equal(seq.get('t').seq, 9007199254740993n);
    assert.equal(db.prepare('PRAGMA table_info(t)').all().length, 2);
  });
  f.add(1, `CREATE TEMP TABLE saved_sequence AS SELECT seq FROM sqlite_sequence WHERE name='t';
${rebuild}
UPDATE sqlite_sequence SET seq=max(seq,(SELECT seq FROM saved_sequence)) WHERE name='t';
INSERT INTO sqlite_sequence(name,seq) SELECT 't',seq FROM saved_sequence WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='t');
DROP TABLE saved_sequence;`);
  const applied = await run({ command: 'apply', ...f, rebuild: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  withDb(f.db, db => {
    db.exec('INSERT INTO t(value) VALUES(30);');
    const row = db.prepare('SELECT max(id) AS id FROM t'); row.setReadBigInts(true);
    assert.equal(row.get().id, 9007199254740994n);
  });
});

test('an empty AUTOINCREMENT table still retains its previously issued IDs', async t => {
  const f = fixture(t, 'CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT,value INTEGER); INSERT INTO t VALUES(100,20); DELETE FROM t;');
  f.add(1, rebuild);
  assert.equal((await run({ command: 'apply', ...f, rebuild: true })).kind, 'policy');
  assert.equal(withDb(f.db, db => db.prepare("SELECT seq FROM sqlite_sequence WHERE name='t'").get().seq), 100);
});

test('foreign history layouts and metadata triggers fail before touching application data', async t => {
  const canonical = 'CREATE TABLE "__moonmigrate_history" (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, schema_before TEXT NOT NULL, schema_after TEXT NOT NULL, tool_version TEXT NOT NULL)';
  for (const ddl of [
    canonical + '; CREATE TRIGGER history_side_effect AFTER INSERT ON __moonmigrate_history BEGIN UPDATE t SET value=0; END;',
    canonical.replace('tool_version TEXT NOT NULL', 'tool_version TEXT NOT NULL, extra TEXT'),
    canonical.replace('__moonmigrate_history', '__MOONMIGRATE_HISTORY'),
    canonical + '; CREATE INDEX custom_history ON __moonmigrate_history(name);',
  ]) {
    const f = fixture(t);
    withDb(f.db, db => db.exec(ddl));
    f.add(1, 'UPDATE t SET value=value+1;');
    const result = await run({ command: 'apply', ...f });
    assert.equal(result.kind, 'policy', JSON.stringify(result));
    assert.equal(result.stage, 'prepare');
    assert.equal(withDb(f.db, db => db.prepare('SELECT value FROM t').get().value), 10);
  }
});

test('history fingerprints form a chain even when the latest schema is unchanged', async t => {
  const f = fixture(t); f.add(1, 'UPDATE t SET value=value+1;'); f.add(2, 'UPDATE t SET value=value+1;');
  assert.equal((await run({ command: 'apply', ...f })).ok, true);
  withDb(f.db, db => db.exec("UPDATE __moonmigrate_history SET schema_before='broken' WHERE version=2;"));
  const result = await run({ command: 'status', ...f });
  assert.equal(result.kind, 'history_mismatch'); assert.match(result.message, /chain/);
});

test('queued requests capture values and relative paths when called', async t => {
  const f = fixture(t); f.add(1, 'UPDATE t SET value=value+1;');
  const request = { command: 'apply', db: relative(process.cwd(), f.db), dir: relative(process.cwd(), f.dir) };
  const pending = run(request);
  request.db = 'wrong.db'; request.command = 'inspect';
  const cwd = process.cwd();
  let result;
  try { process.chdir(tmpdir()); result = await pending; } finally { process.chdir(cwd); }
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.command, 'apply');
  assert.equal(withDb(f.db, db => db.prepare('SELECT value FROM t').get().value), 11);
});

test('library validation rejects ignored command options and nonboolean flags', async t => {
  const f = fixture(t); f.add(1, 'UPDATE t SET value=value+1;');
  for (const request of [null, { ...f, create: 'false' }, { ...f, rebuild: 1 }, { ...f, command: 'status', create: true }, { ...f, command: 'inspect', to: 1 }]) {
    assert.equal((await run(request)).kind, 'input');
  }
  assert.equal(withDb(f.db, db => db.prepare('SELECT value FROM t').get().value), 10);
});

test('status sees one WAL snapshot while another process finishes an upgrade', async t => {
  const f = fixture(t, 'PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO t VALUES(1,10);');
  f.add(1, 'UPDATE t SET value=value+1;');
  assert.equal((await run({ command: 'apply', ...f })).ok, true);
  f.add(2, 'CREATE INDEX value_lookup ON t(value);');
  const original = Adapter.prototype.dispatch;
  let upgraded = false;
  Adapter.prototype.dispatch = function(op, args) {
    const value = original.call(this, op, args);
    if (op === 'history' && args.id === 'source' && !upgraded) {
      upgraded = true;
      const child = spawnSync(process.execPath, ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--format', 'json'], { encoding: 'utf8', timeout: 15000 });
      assert.equal(child.status, 0, child.stderr);
    }
    return value;
  };
  let result;
  try { result = await run({ command: 'status', ...f }); } finally { Adapter.prototype.dispatch = original; }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.applied.length, 1); assert.deepEqual(result.pending, ['000002_upgrade.sql']);
  assert.equal((await run({ command: 'status', ...f })).applied.length, 2);
});

test('rehearsal detects history advancement even for a data-only migration', async t => {
  const f = fixture(t); f.add(1, 'UPDATE t SET value=value+1;');
  const original = Adapter.prototype.makeBackup;
  Adapter.prototype.makeBackup = async function(command) {
    const child = spawnSync(process.execPath, ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--format', 'json'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    return original.call(this, command);
  };
  let result;
  try { result = await run({ command: 'rehearse', ...f }); } finally { Adapter.prototype.makeBackup = original; }
  assert.equal(result.kind, 'history_mismatch', JSON.stringify(result));
  assert.match(result.message, /history changed/);
  assert.equal(withDb(f.db, db => db.prepare('SELECT value FROM t').get().value), 11);
});

test('application backup destination and fail-fast lock policy are reusable options', async t => {
  const f = fixture(t); f.add(1, 'UPDATE t SET value=value+1;');
  const lock = new DatabaseSync(f.db); lock.exec('BEGIN IMMEDIATE;');
  let rejected;
  try { rejected = await run({ command: 'apply', ...f, busy_timeout_ms: 0 }); } finally { lock.close(); }
  assert.equal(rejected.kind, 'lock_timeout');
  const backup_dir = join(f.dir, 'snapshots');
  const result = await run({ command: 'apply', ...f, backup_dir });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.backup.startsWith(backup_dir), true);
  assert.equal(withDb(result.backup, db => db.prepare('SELECT value FROM t').get().value), 10);
  const cli = spawnSync(process.execPath, ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--backup-dir', backup_dir, '--busy-timeout-ms', '0', '--format', 'json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).noop, true);
  const ignored = spawnSync(process.execPath, ['node/cli.mjs', 'inspect', '--db', f.db, '--to', '1', '--format', 'json'], { encoding: 'utf8' });
  assert.equal(ignored.status, 1); assert.equal(JSON.parse(ignored.stderr.split('\n').find(line => line.startsWith('{'))).kind, 'input');
});

test('plan validates policy booleans and reserved names without throwing', () => {
  assert.equal(plan(null).kind, 'input');
  assert.equal(plan({ allow_destructive: 'false' }).kind, 'input');
  const before = { version: '1', tables: [], views: [] };
  const after = { version: '2', views: [], tables: [{ name: '__MOONMIGRATE_BAD', columns: [], indexes: [], foreign_keys: [], checks: [], triggers: [] }] };
  assert.equal(plan({ before, after }).kind, 'policy');
});
