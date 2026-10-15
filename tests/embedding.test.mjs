import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run, runInWorker } from '../node/runtime.mjs';
import { Adapter } from '../node/adapter.mjs';

function fixture(t, applicationId = 1234) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-embedding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), dir = join(root, 'migrations'); mkdirSync(dir);
  const connection = new DatabaseSync(db);
  connection.exec(`PRAGMA application_id=${applicationId}; CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER); INSERT INTO orders VALUES(1,200);`);
  connection.close();
  const migrations = [{ filename: '000003_upgrade.sql', sql: '\uFEFF-- 原样保留\r\nUPDATE orders SET amount=amount+5;\r\n',
    checks_json: '\uFEFF{ "checks": [ { "name": "金额", "sql": "SELECT amount=205 FROM orders;" } ] }\r\n' }];
  return { db, dir, root, migrations };
}
function rows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT amount FROM orders').get().amount; } finally { db.close(); }
}
function writeMigrations(f) {
  for (const entry of f.migrations) {
    writeFileSync(join(f.dir, entry.filename), entry.sql);
    if (entry.checks_json !== undefined) writeFileSync(join(f.dir, entry.filename.replace(/\.sql$/, '.checks.json')), entry.checks_json);
  }
}

test('bundles and files share exact UTF-8 checksums including BOM and sidecar formatting', async t => {
  const f = fixture(t); writeMigrations(f);
  const first = await run({ command: 'apply', db: f.db, dir: f.dir }); assert.equal(first.ok, true, JSON.stringify(first));
  const status = await runInWorker({ command: 'status', db: f.db, migrations: f.migrations });
  assert.equal(status.ok, true, JSON.stringify(status)); assert.equal(status.current_version, 3); assert.equal(status.application_id, 1234);
  f.migrations.push({ filename: '000010_index.sql', sql: 'CREATE INDEX order_amount ON orders(amount);' });
  const next = await runInWorker({ command: 'apply', db: f.db, migrations: f.migrations, expected_version: 3, expected_application_id: 1234 });
  assert.equal(next.ok, true, JSON.stringify(next)); writeMigrations(f);
  assert.equal((await run({ command: 'status', db: f.db, dir: f.dir })).current_version, 10);
  for (const altered of [
    { ...f.migrations[0], sql: f.migrations[0].sql.replaceAll('\r\n', '\n') },
    { ...f.migrations[0], checks_json: JSON.stringify(JSON.parse(f.migrations[0].checks_json.replace(/^\uFEFF/, ''))) },
    { filename: f.migrations[0].filename, sql: f.migrations[0].sql },
  ]) {
    const report = await run({ command: 'status', db: f.db, migrations: [altered, f.migrations[1]] });
    assert.equal(report.kind, 'history_mismatch', JSON.stringify(report));
  }
  assert.equal(rows(f.db), 205);
  assert.equal((await run({ command: 'status', db: f.db, migrations: [] })).kind, 'history_mismatch');
});

test('bundled sources and guard values are captured before queueing and worker creation', async t => {
  for (const execute of [run, runInWorker]) {
    const f = fixture(t);
    const request = { command: 'apply', db: f.db, migrations: f.migrations, expected_application_id: 1234, expected_version: 0 };
    const pending = execute(request);
    request.expected_application_id = 999; request.expected_version = 500;
    f.migrations[0].sql = 'DELETE FROM orders;'; f.migrations[0].checks_json = '{"checks":[{"name":"weakened","sql":"SELECT 1;"}]}'; f.migrations.length = 0;
    const result = await pending; assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(rows(f.db), 205); assert.equal(result.result.checks[0].name, '金额');
  }
});

test('bundled checks reject data loss in rehearsal and roll back the entire batch', async t => {
  const f = fixture(t); f.migrations[0].sql = 'UPDATE orders SET amount=0;';
  const result = await runInWorker({ command: 'apply', db: f.db, migrations: f.migrations });
  assert.equal(result.kind, 'policy'); assert.equal(result.stage, 'rehearse'); assert.equal(rows(f.db), 200);
  assert.equal((await run({ command: 'status', db: f.db, migrations: [] })).current_version, 0);
});

test('invalid bundles fail before creating a database or starting a worker', async t => {
  const f = fixture(t), db = join(f.root, 'missing.db');
  for (const execute of [run, runInWorker]) for (const options of [
    { migrations: null }, { migrations: {} }, { migrations: [null] }, { migrations: new Array(1) },
    { migrations: [{ filename: '000001_init.sql', sql: 'SELECT 1;', checksum: 'spoofed' }] },
    { migrations: [{ filename: '../000001_init.sql', sql: 'SELECT 1;' }] },
    { migrations: [{ filename: '000000_init.sql', sql: 'SELECT 1;' }] },
    { migrations: [{ filename: '000001_init.sql\n', sql: 'SELECT 1;' }] },
    { migrations: [{ filename: '000001_init.sql', sql: '\ud800' }] },
    { migrations: [{ filename: '000001_init.sql', sql: 'SELECT 1;\0DELETE FROM orders;' }] },
    { migrations: [{ filename: '000001_init.sql', sql: 'SELECT 1;', checks_json: '\udc00' }] },
    { migrations: [{ filename: '000001_init.sql', sql: 'SELECT 1;', checks_json: '{"checks":[]}' }] },
    { migrations: [f.migrations[0], f.migrations[0]] },
    { migrations: [], dir: f.dir },
  ]) {
    const report = await execute({ command: 'apply', db, create: true, ...options });
    assert.equal(report.kind, 'input', JSON.stringify(report)); assert.equal(existsSync(db), false);
  }
  assert.equal((await run({ command: 'inspect', db: f.db, migrations: [] })).kind, 'input');
});

test('application identity is checked even for inspect and no-op without backup or writes', async t => {
  const f = fixture(t, -2147483648), before = readFileSync(f.db);
  for (const migrations of [[], f.migrations]) for (const command of ['apply', 'rehearse', 'status', 'inspect']) {
    const report = await run({ command, db: f.db, ...(command === 'inspect' ? {} : { migrations }), expected_application_id: 2147483647 });
    assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.match(report.message, /application_id mismatch/);
    assert.equal(report.stage, 'prepare'); assert.equal(report.backup, undefined);
    assert.deepEqual(readFileSync(f.db), before); assert.equal(existsSync(f.db + '.moonmolt-backups'), false);
  }
  const inspected = await run({ command: 'inspect', db: f.db, expected_application_id: -2147483648 });
  assert.equal(inspected.snapshot.application_id, -2147483648);
  const status = await run({ command: 'status', db: f.db, migrations: [], expected_version: 0 });
  assert.equal(status.application_id, -2147483648); assert.equal(status.current_version, 0);
});

test('stale expected versions reject status, rehearsal and no-op apply before backup', async t => {
  const f = fixture(t); assert.equal((await run({ command: 'apply', db: f.db, migrations: f.migrations, expected_version: 0 })).ok, true);
  for (const command of ['status', 'rehearse', 'apply']) {
    const report = await runInWorker({ command, db: f.db, migrations: f.migrations, expected_version: 0 });
    assert.equal(report.kind, 'policy'); assert.match(report.message, /expected 0, found 3/); assert.equal(report.backup, undefined);
  }
  assert.equal(rows(f.db), 205);
  assert.equal((await run({ command: 'apply', db: f.db, migrations: f.migrations, expected_version: 3 })).noop, true);
});

test('two workers using the same expected version allow exactly one upgrade', async t => {
  const f = fixture(t);
  const reports = await Promise.all([0, 1].map(() => runInWorker({ command: 'apply', db: f.db, migrations: f.migrations, expected_version: 0 })));
  assert.equal(reports.filter(r => r.ok).length, 1, JSON.stringify(reports));
  assert.equal(reports.filter(r => r.kind === 'policy' && /version mismatch/.test(r.message)).length, 1);
  assert.equal(rows(f.db), 205);
});

test('advisory rehearsal detects a changed application ID in its backup snapshot', async t => {
  const f = fixture(t), original = Adapter.prototype.makeBackup;
  Adapter.prototype.makeBackup = async function(command) {
    const db = new DatabaseSync(f.db); try { db.exec('PRAGMA application_id=5678;'); } finally { db.close(); }
    return original.call(this, command);
  };
  let report;
  try { report = await run({ command: 'rehearse', db: f.db, migrations: f.migrations, expected_application_id: 1234 }); }
  finally { Adapter.prototype.makeBackup = original; }
  assert.equal(report.kind, 'history_mismatch', JSON.stringify(report)); assert.match(report.message, /application_id changed/); assert.equal(rows(f.db), 200);
});

test('guard values reject coercion and ranges before opening the database', async t => {
  const f = fixture(t), db = join(f.root, 'missing.db');
  for (const options of [
    ...[null, '1234', 1.5, NaN, Infinity, -2147483649, 2147483648].map(expected_application_id => ({ expected_application_id })),
    ...[null, '0', -1, 1.5, 1000000].map(expected_version => ({ expected_version })),
  ]) {
    const report = await run({ command: 'apply', db, create: true, migrations: [], ...options });
    assert.equal(report.kind, 'input'); assert.equal(existsSync(db), false);
  }
  assert.equal((await run({ command: 'inspect', db: f.db, expected_version: 0 })).kind, 'input');
});

test('CLI exposes both transaction guards and validates their command scope', t => {
  const f = fixture(t); writeMigrations(f);
  const args = ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--expected-application-id', '1234', '--expected-version', '0', '--worker', '--format', 'json'];
  const applied = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(applied.status, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).ok, true);
  const stale = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(stale.status, 2, stale.stderr); assert.match(stale.stderr, /version mismatch/); assert.equal(rows(f.db), 205);
  for (const option of ['--expected-application-id', '--expected-version']) {
    const invalid = spawnSync(process.execPath, ['node/cli.mjs', 'plan', '--before', 'absent.json', '--after', 'absent.json', option, '0'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /does not apply/);
  }
});
