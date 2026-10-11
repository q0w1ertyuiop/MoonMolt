import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run, plan } from '../node/runtime.mjs';

function fixture(t, sql = '') {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db');
  const dir = join(root, 'migrations');
  mkdirSync(dir);
  const connection = new DatabaseSync(db);
  if (sql) connection.exec(sql);
  connection.close();
  return { root, db, dir, add(version, sql, name = 'change') { writeFileSync(join(dir, `${String(version).padStart(6, '0')}_${name}.sql`), sql); } };
}

function query(path, sql) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all().map(r => ({ ...r })); }
  finally { db.close(); }
}

test('atomic upgrade, exact history, consistent backup and repeat no-op', async t => {
  const f = fixture(t, "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO users VALUES(1,'王正');");
  f.add(1, "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';", 'status');
  f.add(3, 'CREATE INDEX users_name ON users(name);', 'index');
  const before = readFileSync(f.db);
  const rehearsal = await run({ command: 'rehearse', ...f });
  assert.equal(rehearsal.ok, true, JSON.stringify(rehearsal));
  assert.deepEqual(readFileSync(f.db), before);
  const applied = await run({ command: 'apply', ...f });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(query(f.db, 'SELECT * FROM users'), [{ id: 1, name: '王正', status: 'active' }]);
  assert.deepEqual(query(applied.backup, 'SELECT * FROM users'), [{ id: 1, name: '王正' }]);
  assert.equal(query(f.db, 'SELECT * FROM __moonmigrate_history').length, 2);
  assert.equal(JSON.parse(readFileSync(applied.report_path)).ok, true);
  const files = readdirSync(`${f.db}.moonmolt-backups`);
  const again = await run({ command: 'apply', ...f });
  assert.equal(again.noop, true);
  assert.deepEqual(readdirSync(`${f.db}.moonmolt-backups`), files);
  const status = await run({ command: 'status', ...f });
  assert.equal(status.ok, true);
  assert.deepEqual(status.pending, []);
});

test('second migration failure rolls back schema, data and history', async t => {
  const f = fixture(t, 'CREATE TABLE accounts(id INTEGER PRIMARY KEY,balance INTEGER); INSERT INTO accounts VALUES(1,100);');
  f.add(1, 'UPDATE accounts SET balance=0; ALTER TABLE accounts ADD COLUMN label TEXT;');
  f.add(2, 'INSERT INTO missing VALUES(1);');
  const result = await run({ command: 'apply', ...f });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'rehearse');
  assert.deepEqual(query(f.db, 'SELECT * FROM accounts'), [{ id: 1, balance: 100 }]);
  assert.equal(query(f.db, "SELECT name FROM sqlite_schema WHERE name='__moonmigrate_history'").length, 0);
});

test('applied checksum changes, deleted files, inserted older versions and drift block', async t => {
  const f = fixture(t, 'CREATE TABLE t(id INTEGER);');
  f.add(2, 'CREATE INDEX t_id ON t(id);');
  assert.equal((await run({ command: 'apply', ...f })).ok, true);
  f.add(2, 'CREATE INDEX t_id ON t(id); -- edited');
  assert.equal((await run({ command: 'status', ...f })).kind, 'history_mismatch');
  f.add(2, 'CREATE INDEX t_id ON t(id);');
  f.add(1, 'SELECT 1;');
  assert.equal((await run({ command: 'apply', ...f })).kind, 'history_mismatch');
  rmSync(join(f.dir, '000001_change.sql'));
  const db = new DatabaseSync(f.db);
  db.exec('CREATE TABLE rogue(a);'); db.close();
  assert.equal((await run({ command: 'status', ...f })).kind, 'history_mismatch');
  rmSync(join(f.dir, '000002_change.sql'));
  assert.equal((await run({ command: 'apply', ...f })).kind, 'history_mismatch');
});

test('authorizer rejects script transaction, pragma, attach and history access', async t => {
  for (const sql of ['COMMIT;', 'SAVEPOINT bad;', 'PRAGMA foreign_keys=OFF;', "ATTACH ':memory:' AS other;", 'DELETE FROM __moonmigrate_history;', 'ALTER TABLE __moonmigrate_history RENAME TO stolen;']) {
    const f = fixture(t, 'CREATE TABLE t(x);');
    f.add(1, sql);
    const result = await run({ command: 'apply', ...f });
    assert.equal(result.kind, 'policy', JSON.stringify({ sql, result }));
    assert.equal(query(f.db, "SELECT name FROM sqlite_schema WHERE name='__moonmigrate_history'").length, 0);
  }
});

test('scripts retain trigger bodies, Chinese text, semicolons, int64 and blobs', async t => {
  const f = fixture(t);
  f.add(1, "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, big INTEGER, data BLOB); CREATE TABLE log(label TEXT); CREATE TRIGGER t_log AFTER INSERT ON t BEGIN INSERT INTO log VALUES(new.label); END; INSERT INTO t VALUES(42,'月蜕;a;b',9223372036854775807,X'00FFAB');");
  const result = await run({ command: 'apply', ...f });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(query(f.db, 'SELECT label,CAST(big AS TEXT) AS big,hex(data) AS blob FROM t'), [{ label: '月蜕;a;b', big: '9223372036854775807', blob: '00FFAB' }]);
  assert.deepEqual(query(f.db, 'SELECT * FROM log'), [{ label: '月蜕;a;b' }]);
});

test('rebuild preserves IDs and references; invalid references abort the entire batch', async t => {
  const schema = "PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE orders(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id)); INSERT INTO users VALUES(7,'王正'); INSERT INTO orders VALUES(9,7);";
  const sql = 'CREATE TABLE users_new(id INTEGER PRIMARY KEY,name TEXT NOT NULL); INSERT INTO users_new(id,name) SELECT id,name FROM users; DROP TABLE users; ALTER TABLE users_new RENAME TO users;';
  const f = fixture(t, schema); f.add(1, sql);
  assert.equal((await run({ command: 'apply', ...f })).ok, false);
  const result = await run({ command: 'apply', ...f, rebuild: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(query(f.db, 'SELECT * FROM orders'), [{ id: 9, user_id: 7 }]);
  f.add(2, 'UPDATE orders SET user_id=999;');
  assert.equal((await run({ command: 'apply', ...f, rebuild: true })).kind, 'policy');
  assert.deepEqual(query(f.db, 'SELECT * FROM orders'), [{ id: 9, user_id: 7 }]);
});

test('WAL backup includes committed data still in WAL', async t => {
  const f = fixture(t);
  const writer = new DatabaseSync(f.db);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x); INSERT INTO t VALUES(123);');
  f.add(1, 'ALTER TABLE t ADD COLUMN y TEXT;');
  const result = await run({ command: 'apply', ...f });
  writer.close();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(query(result.backup, 'SELECT * FROM t'), [{ x: 123 }]);
});

test('strict UTF-8, duplicate version, missing database, explicit create and target selection', async t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, '000001_bad.sql'), Buffer.from([0xff]));
  assert.equal((await run({ command: 'apply', ...f })).kind, 'input');
  rmSync(join(f.dir, '000001_bad.sql'));
  f.add(1, 'CREATE TABLE t(x);'); f.add(2, 'CREATE TABLE second(x);');
  const result = await run({ command: 'apply', ...f, to: 1 });
  assert.equal(result.ok, true);
  assert.equal(query(f.db, "SELECT name FROM sqlite_schema WHERE name='second'").length, 0);
  assert.equal((await run({ command: 'apply', ...f, to: 999 })).kind, 'input');
  assert.equal((await run({ command: 'apply', ...f, to: 1.5 })).kind, 'input');
  const missing = join(f.root, 'missing.db');
  assert.equal((await run({ command: 'apply', ...f, db: missing })).kind, 'input');
  assert.equal((await run({ command: 'apply', ...f, db: missing, create: true })).ok, true);
});

test('CLI JSON errors have meaningful exit codes', t => {
  const f = fixture(t); f.add(1, 'COMMIT;');
  const child = spawnSync(process.execPath, ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(child.status, 2, child.stderr);
  assert.equal(JSON.parse(child.stderr.trim().split('\n').at(-1)).kind, 'policy');
});

test('schema planner creates ordinary SQL and strips only known rebuild wrappers', () => {
  const col = { name: 'id', data_type: 'INTEGER', nullable: false, primary_key: true, unique: false, default_value: null };
  const base = { indexes: [], foreign_keys: [], checks: [], triggers: [] };
  const before = { version: '1', views: [], tables: [{ ...base, name: 't', columns: [col] }] };
  const after = { version: '2', views: [], tables: [{ ...base, name: 't', columns: [col, { ...col, name: 'label', data_type: 'TEXT', primary_key: false, nullable: true }] }] };
  const result = plan({ before, after });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.sql, /ADD COLUMN/);
  const rebuild = plan({ before: after, after: { ...after, version: '3', tables: [{ ...after.tables[0], columns: [col, { ...after.tables[0].columns[1], nullable: false, default_value: "'unknown'" }] }] }, allow_destructive: true });
  assert.equal(rebuild.ok, true, JSON.stringify(rebuild));
  assert.equal(rebuild.requires_rebuild, true);
  assert.doesNotMatch(rebuild.sql, /PRAGMA foreign_keys|BEGIN IMMEDIATE|COMMIT;/);
  assert.match(rebuild.sql, /__msp_fk_guard/);
});
