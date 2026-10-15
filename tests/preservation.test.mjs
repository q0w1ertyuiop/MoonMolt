import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run, runInWorker } from '../node/runtime.mjs';
import { Adapter } from '../node/adapter.mjs';

const rebuild = 'CREATE TABLE next_orders(id INTEGER PRIMARY KEY,amount INTEGER,secret TEXT,token BLOB,rate REAL,optional TEXT,status TEXT DEFAULT \'paid\'); INSERT INTO next_orders(id,amount,secret,token,rate,optional) SELECT id,amount,secret,token,rate,optional FROM orders; DROP TABLE orders; ALTER TABLE next_orders RENAME TO orders;';
const defaults = [
  { name: 'order count', sql: 'SELECT COUNT(*) FROM orders;' },
  { name: 'exact monetary total', sql: 'SELECT SUM(amount) FROM orders;' },
];
function withDb(path, fn) {
  const db = new DatabaseSync(path);
  try { return fn(db); } finally { db.close(); }
}
function state(path) {
  return withDb(path, db => {
    const statement = db.prepare('SELECT * FROM orders ORDER BY id'); statement.setReadBigInts(true);
    return { rows: statement.all().map(r => ({ ...r })), columns: db.prepare('PRAGMA table_info(orders)').all().length,
      history: db.prepare("SELECT name FROM sqlite_schema WHERE name='__moonmigrate_history'").all().length };
  });
}
function fixture(t, seed = "INSERT INTO orders VALUES(1,9007199254740993,'私密客户值',x'00ff',1.25,NULL),(2,29,'other',x'31',2.5,'present');") {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-preserve-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'shop.db'), dir = join(root, 'migrations'); mkdirSync(dir);
  withDb(db, db => db.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,amount INTEGER,secret TEXT,token BLOB,rate REAL,optional TEXT);' + seed));
  const filename = '000001_rebuild.sql', sqlPath = join(dir, filename), checksPath = join(dir, '000001_rebuild.checks.json');
  writeFileSync(sqlPath, rebuild);
  const manifest = document => writeFileSync(checksPath, JSON.stringify(document));
  manifest({ preserve: defaults });
  return { db, dir, root, filename, sqlPath, checksPath, manifest };
}

test('unknown live counts and int64 totals survive rebuilds without hardcoded expected values', async t => {
  for (const seed of [undefined, '', "INSERT INTO orders VALUES(7,333,'a',x'',3.5,NULL);"]) {
    const f = fixture(t, seed), original = state(f.db);
    const rehearsal = await run({ command: 'rehearse', db: f.db, dir: f.dir });
    assert.equal(rehearsal.ok, true, JSON.stringify(rehearsal)); assert.equal(rehearsal.rehearsal.preserved.length, 2);
    assert.deepEqual(state(f.db), original);
    const applied = await runInWorker({ command: 'apply', db: f.db, dir: f.dir, rebuild: true });
    assert.equal(applied.ok, true, JSON.stringify(applied)); assert.deepEqual(applied.result.preserved.map(c => c.name), defaults.map(c => c.name));
    assert.deepEqual(state(f.db).rows.map(({ status, ...row }) => row), original.rows);
    assert.equal(state(f.db).columns, 7);
  }
});

test('a schema-valid rebuild that loses one large integer unit is rejected', async t => {
  const f = fixture(t), original = state(f.db);
  writeFileSync(f.sqlPath, rebuild + ' UPDATE orders SET amount=amount-1 WHERE id=1;');
  const result = await run({ command: 'apply', db: f.db, dir: f.dir });
  assert.equal(result.kind, 'policy'); assert.equal(result.stage, 'rehearse'); assert.match(result.message, /exact monetary total/);
  assert.deepEqual(state(f.db), original);
});

test('a source-only preservation failure rolls back earlier scripts, DDL, rows and history', async t => {
  const f = fixture(t), original = state(f.db);
  writeFileSync(f.sqlPath, "UPDATE orders SET secret=secret || ' upgraded';");
  writeFileSync(join(f.dir, '000002_rebuild.sql'), rebuild);
  writeFileSync(join(f.dir, '000002_rebuild.checks.json'), JSON.stringify({ preserve: defaults }));
  const originalScript = Adapter.prototype.script;
  Adapter.prototype.script = function(id, sql, filename) {
    originalScript.call(this, id, sql, filename);
    if (id === 'source' && filename === '000002_rebuild.sql') this.db(id).exec('UPDATE orders SET amount=amount-1 WHERE id=1;');
  };
  let result;
  try { result = await run({ command: 'apply', db: f.db, dir: f.dir }); } finally { Adapter.prototype.script = originalScript; }
  assert.equal(result.kind, 'policy'); assert.equal(result.stage, 'apply'); assert.match(result.message, /000002_rebuild.sql/);
  assert.deepEqual(state(f.db), original); assert.deepEqual(state(result.backup), original);
});

test('scalar preservation retains types, nulls, text, blobs and finite reals without exposing values', async t => {
  const f = fixture(t), events = [];
  const preserve = ['secret', 'token', 'rate', 'optional'].map(column => ({ name: column + ' retained', sql: `SELECT ${column} FROM orders WHERE id=1;` }));
  f.manifest({ preserve, checks: [{ name: 'status exists', sql: "SELECT NOT EXISTS(SELECT 1 FROM orders WHERE status<>'paid');" }] });
  const result = await runInWorker({ command: 'apply', db: f.db, dir: f.dir }, { onProgress: e => events.push(e) });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.preserved.length, 4); assert.equal(result.result.checks.length, 1);
  for (const connection of ['clone', 'source']) for (const phase of ['before', 'after']) {
    const captures = events.filter(e => e.operation === 'capture_value' && e.connection === connection && e.phase === phase && e.state === 'complete');
    assert.equal(captures.length, 4); assert.equal(captures.every(e => e.stage === (connection === 'source' ? 'apply' : 'rehearse')), true);
  }
  for (const output of [JSON.stringify(result), JSON.stringify(events), readFileSync(result.report_path, 'utf8')]) {
    assert.equal(output.includes('私密客户值'), false); assert.equal(output.includes('AP8='), false); assert.equal(output.includes('baseline'), false);
  }
});

test('equal-looking INTEGER, REAL, TEXT and BLOB results do not compare equal', async t => {
  for (const replacement of ['1.0', "'1'", "x'31'", 'NULL']) {
    const f = fixture(t); withDb(f.db, db => db.exec('CREATE TABLE scalar(value); INSERT INTO scalar VALUES(1);'));
    writeFileSync(f.sqlPath, `UPDATE scalar SET value=${replacement};`);
    f.manifest({ preserve: [{ name: 'storage class retained', sql: 'SELECT value FROM scalar;' }] });
    const result = await run({ command: 'apply', db: f.db, dir: f.dir });
    assert.equal(result.kind, 'policy', JSON.stringify(result)); assert.match(result.message, /storage class retained/);
    assert.equal(withDb(f.db, db => db.prepare('SELECT typeof(value) AS type FROM scalar').get().type), 'integer');
  }
});

test('same-type text, blob and finite real value changes are rejected', async t => {
  for (const [column, replacement] of [['secret', "'changed private text'"], ['token', "x'00fe'"], ['rate', '1.2500000000000002']]) {
    const f = fixture(t), original = state(f.db);
    writeFileSync(f.sqlPath, rebuild + ` UPDATE orders SET ${column}=${replacement} WHERE id=1;`);
    f.manifest({ preserve: [{ name: 'exact field', sql: `SELECT ${column} FROM orders WHERE id=1;` }] });
    const result = await runInWorker({ command: 'apply', db: f.db, dir: f.dir });
    assert.equal(result.kind, 'policy', JSON.stringify(result)); assert.match(result.message, /exact field/); assert.deepEqual(state(f.db), original);
  }
});

test('BLOB casts compare legacy TEXT bytes that decode to the same Unicode replacement', async t => {
  const f = fixture(t);
  withDb(f.db, db => db.exec("UPDATE orders SET secret=CAST(x'80' AS TEXT) WHERE id=1;"));
  writeFileSync(f.sqlPath, rebuild + " UPDATE orders SET secret=CAST(x'81' AS TEXT) WHERE id=1;");
  f.manifest({ preserve: [{ name: 'legacy text bytes', sql: 'SELECT CAST(secret AS BLOB) FROM orders WHERE id=1;' }] });
  const result = await run({ command: 'apply', db: f.db, dir: f.dir });
  assert.equal(result.kind, 'policy'); assert.match(result.message, /legacy text bytes/);
  assert.equal(withDb(f.db, db => db.prepare('SELECT hex(secret) AS value FROM orders WHERE id=1').get().value), '80');
});

test('preservation queries cannot write, hide tails, use metadata or leave parameters unbound', async t => {
  for (const sql of [
    'DELETE FROM orders RETURNING amount;', 'UPDATE orders SET amount=0 RETURNING amount;', 'PRAGMA application_id=99;', 'COMMIT;',
    'SELECT 1; DELETE FROM orders;', 'SELECT 1,2;', 'SELECT 1 AS ok,2 AS ok;', 'SELECT 1 WHERE 0;', 'SELECT amount FROM orders;',
    'SELECT COUNT(*) FROM __moonmigrate_history;', 'SELECT ? IS NULL;', 'SELECT :bound;', 'SELECT 1e999;', 'SELECT zeroblob(1048577);', "SELECT replace(hex(zeroblob(524289)),'0','x');",
  ]) {
    const f = fixture(t), original = state(f.db);
    f.manifest({ preserve: [{ name: 'invalid query', sql }] });
    const result = await run({ command: 'apply', db: f.db, dir: f.dir });
    assert.equal(result.kind, 'policy', JSON.stringify({ sql, result })); assert.equal(result.stage, 'rehearse');
    assert.deepEqual(state(f.db), original);
  }
});

test('bad preservation manifests fail before creating a database', async t => {
  const f = fixture(t), missing = join(f.root, 'missing.db');
  for (const document of [
    { preserve: [] }, { preserve: null }, { preserve: {} }, { preserve: [null] }, { preserve: [{ name: 'x', sql: 'SELECT 1;', expected: 1 }] },
    { preserve: [defaults[0], defaults[0]] }, { preserve: [defaults[0]], checks: [defaults[0]] }, { preserve: [{ name: 'x', sql: 'SELECT 1;\0' }] },
  ]) {
    const migrations = [{ filename: f.filename, sql: rebuild, checks_json: JSON.stringify(document) }];
    const result = await runInWorker({ command: 'apply', db: missing, migrations, create: true });
    assert.equal(result.kind, 'input', JSON.stringify(result));
    assert.equal(existsSync(missing), false);
  }
});

test('preservation sidecars are immutable during backup and protected by history checksums', async t => {
  const f = fixture(t), original = Adapter.prototype.makeBackup;
  Adapter.prototype.makeBackup = async function(command) {
    f.manifest({ preserve: [{ name: 'weakened', sql: 'SELECT 1;' }] });
    return original.call(this, command);
  };
  let result;
  try { result = await run({ command: 'apply', db: f.db, dir: f.dir }); } finally { Adapter.prototype.makeBackup = original; }
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.preserved.length, 2);
  assert.equal((await run({ command: 'status', db: f.db, dir: f.dir })).kind, 'history_mismatch');
  f.manifest({ preserve: defaults });
  const bundle = [{ filename: f.filename, sql: readFileSync(f.sqlPath, 'utf8'), checks_json: readFileSync(f.checksPath, 'utf8') }];
  assert.equal((await runInWorker({ command: 'status', db: f.db, migrations: bundle })).ok, true);
  f.manifest({ checks: [{ name: 'replacement', sql: 'SELECT 1;' }] });
  assert.equal((await run({ command: 'status', db: f.db, dir: f.dir })).kind, 'history_mismatch');
});

test('cancellation before source post-capture rolls back without leaking the baseline', async t => {
  const f = fixture(t), original = state(f.db), controller = new AbortController();
  const result = await run({ command: 'apply', db: f.db, dir: f.dir }, {
    signal: controller.signal, onProgress: e => { if (e.operation === 'capture_value' && e.connection === 'source' && e.phase === 'after' && e.state === 'start') controller.abort(); },
  });
  assert.equal(result.kind, 'cancelled'); assert.equal(result.stage, 'apply'); assert.deepEqual(state(f.db), original);
});

test('CLI reports preservation counts, and completed no-ops do not reevaluate baselines', async t => {
  const f = fixture(t);
  const cli = spawnSync(process.execPath, ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--worker'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /Preservation checks passed: 2/);
  withDb(f.db, db => db.exec('UPDATE orders SET amount=amount+1;'));
  const events = [];
  const noop = await run({ command: 'apply', db: f.db, dir: f.dir }, { onProgress: e => events.push(e) });
  assert.equal(noop.noop, true); assert.equal(events.some(e => e.operation === 'capture_value'), false);
});
