import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, runInWorker } from '../node/runtime.mjs';
import { spawnSync } from 'node:child_process';
import { Adapter } from '../node/adapter.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-verify-checks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,amount INTEGER); INSERT INTO orders VALUES(1,100);'); connection.close();
  return { root, db, migrations: [] };
}
const healthy = [{ name: 'positive amounts', sql: 'SELECT COUNT(*)=1 AND MIN(amount)>0 FROM main.orders;' }];

test('renaming a business table into the protected namespace fails before source writes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-rename-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,amount INTEGER); INSERT INTO orders VALUES(1,100);'); connection.close();
  for (const sql of [
    'ALTER TABLE orders RENAME TO __moonmigrate_orders;',
    'ALTER TABLE orders RENAME TO __MOONMIGRATE_ORDERS; DROP TABLE __MOONMIGRATE_ORDERS;',
    'CREATE TEMP TABLE helper(id); ALTER TABLE temp.helper RENAME TO __moonmigrate_saved;',
  ]) {
    const report = await run({ command: 'apply', db, migrations: [{ filename: '000001_rename.sql', sql }] });
    assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.equal(report.stage, 'rehearse');
  }
  const reader = new DatabaseSync(db);
  try { assert.equal(reader.prepare('SELECT amount FROM orders').get().amount, 100); }
  finally { reader.close(); }
});

test('business verification detects data damage that SQLite integrity and history cannot see', async t => {
  for (const execute of [run, runInWorker]) {
    const f = fixture(t), migrations = [{ filename: '000001_index.sql', sql: 'CREATE INDEX amount_index ON orders(amount);' }];
    assert.equal((await execute({ command: 'apply', db: f.db, migrations })).ok, true);
    const good = await execute({ command: 'verify', db: f.db, migrations, verify_checks: healthy });
    assert.equal(good.verified, true, JSON.stringify(good)); assert.deepEqual(good.checks, [{ name: 'positive amounts', ok: true }]);
    const db = new DatabaseSync(f.db); try { db.exec('UPDATE orders SET amount=0;'); } finally { db.close(); }
    const before = readFileSync(f.db);
    assert.equal((await execute({ command: 'verify', db: f.db, migrations })).verified, true);
    const bad = await execute({ command: 'verify', db: f.db, migrations, verify_checks: healthy });
    assert.equal(bad.kind, 'policy'); assert.match(bad.message, /positive amounts/); assert.equal(bad.exit_code, 2); assert.equal(bad.backup, undefined);
    assert.deepEqual(readFileSync(f.db), before);
  }
});

test('explicit current checks are captured before queues and workers while pending migrations stay untouched', async t => {
  for (const execute of [run, runInWorker]) {
    const f = fixture(t), checks = healthy.map(c => ({ ...c }));
    const request = { command: 'verify', db: f.db, migrations: [{ filename: '000001_pending.sql', sql: 'DROP TABLE orders;', checks_json: '{"checks":[{"name":"historical failure","sql":"SELECT 0;"}]}' }], verify_checks: checks };
    const pending = execute(request);
    checks[0].sql = 'SELECT 0;'; checks[0].name = 'changed'; checks.push({ name: 'injected', sql: 'DELETE FROM orders;' }); request.verify_checks = [];
    const report = await pending; assert.equal(report.verified, true, JSON.stringify(report));
    assert.deepEqual(report.checks, [{ name: 'positive amounts', ok: true }]); assert.deepEqual(report.pending, ['000001_pending.sql']);
    assert.equal(existsSync(f.db + '.moonmolt-backups'), false);
  }
});

test('current checks share the read snapshot with history and full integrity checks', async t => {
  const f = fixture(t), writer = new DatabaseSync(f.db); writer.exec('PRAGMA journal_mode=WAL;');
  let changed = false;
  try {
    const report = await run({ command: 'verify', db: f.db, migrations: [], verify_checks: healthy }, { onProgress(event) {
      if (event.operation === 'verify' && event.state === 'complete') { writer.exec('UPDATE orders SET amount=0;'); changed = true; }
    } });
    assert.equal(changed, true); assert.equal(report.verified, true, JSON.stringify(report));
    assert.equal(writer.prepare('SELECT amount FROM orders').get().amount, 0);
    assert.equal((await run({ command: 'verify', db: f.db, migrations: [], verify_checks: healthy })).kind, 'policy');
  } finally { writer.close(); }
});

test('read-only current checks reject writes, parameters, metadata and invalid cardinalities', async t => {
  const f = fixture(t), before = readFileSync(f.db);
  for (const sql of ['DELETE FROM orders;', 'SELECT 1; DELETE FROM orders;', 'SELECT :unbound IS NULL;', 'SELECT NULL;', 'SELECT 1.0;', "SELECT '1';", 'SELECT amount FROM orders WHERE 0;', 'SELECT 1,1;', 'SELECT 1 UNION ALL SELECT 1;', 'SELECT 1 FROM __moonmigrate_history;', 'PRAGMA application_id=4;']) {
    const report = await run({ command: 'verify', db: f.db, migrations: [], verify_checks: [{ name: 'unsafe rule', sql }] });
    assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.match(report.message, /unsafe rule/);
    assert.deepEqual(readFileSync(f.db), before);
  }
});

test('malformed verification manifests fail before opening or creating a database', async t => {
  const f = fixture(t), missing = join(f.root, 'missing.db');
  for (const verify_checks of [null, {}, [], [null], [{ name: 'x', sql: 'SELECT 1;', extra: true }], [{ name: '', sql: 'SELECT 1;' }], [{ name: 'x', sql: '' }], [{ name: 'x', sql: 'SELECT 1;\0' }], [{ name: 'x', sql: '\ud800' }], [...healthy, ...healthy]]) {
    for (const execute of [run, runInWorker]) {
      const report = await execute({ command: 'verify', db: missing, migrations: [], verify_checks });
      assert.equal(report.kind, 'input'); assert.equal(existsSync(missing), false);
    }
  }
  for (const command of ['apply', 'status', 'inspect', 'rehearse']) {
    const report = await run({ command, db: missing, ...(command === 'inspect' ? {} : { migrations: [] }), verify_checks: healthy });
    assert.equal(report.kind, 'input'); assert.match(report.message, /only applies to verify/);
  }
});

test('guards and integrity failures happen before any custom verification query', async t => {
  const f = fixture(t), events = [];
  const report = await run({ command: 'verify', db: f.db, migrations: [], expected_version: 2, verify_checks: healthy }, { onProgress: e => events.push(e) });
  assert.equal(report.kind, 'policy'); assert.equal(events.some(e => e.operation === 'exec_check'), false);
  const original = Adapter.prototype.validate;
  Adapter.prototype.validate = function() { throw Object.assign(new Error('injected integrity failure'), { kind: 'policy' }); };
  try {
    events.length = 0;
    const bad = await run({ command: 'verify', db: f.db, migrations: [], verify_checks: healthy }, { onProgress: e => events.push(e) });
    assert.equal(bad.kind, 'policy'); assert.equal(events.some(e => e.operation === 'exec_check'), false);
  } finally { Adapter.prototype.validate = original; }
});

test('cancellation before a current check closes the read transaction without changing data', async t => {
  const f = fixture(t), controller = new AbortController(), before = readFileSync(f.db);
  const report = await run({ command: 'verify', db: f.db, migrations: [], verify_checks: healthy }, { signal: controller.signal, onProgress(event) {
    if (event.operation === 'exec_check' && event.state === 'start') controller.abort();
  } });
  assert.equal(report.kind, 'cancelled'); assert.equal(report.exit_code, 4); assert.deepEqual(readFileSync(f.db), before);
  assert.equal((await run({ command: 'apply', db: f.db, migrations: [] })).noop, true);
});

test('CLI accepts a checks document and rejects failures and inappropriate commands', t => {
  const f = fixture(t), dir = join(f.root, 'migrations'), checks = join(f.root, 'health.json'); mkdirSync(dir);
  writeFileSync(checks, '\uFEFF' + JSON.stringify({ checks: healthy }));
  const args = ['node/cli.mjs', 'verify', '--db', f.db, '--dir', dir, '--checks-file', checks, '--worker', '--format', 'json'];
  const good = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 }); assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).checks.length, 1);
  const text = spawnSync(process.execPath, args.slice(0, -2), { encoding: 'utf8', timeout: 15000 }); assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /Business checks passed: 1/);
  writeFileSync(checks, '{"checks":[{"name":"failed health","sql":"SELECT 0;"}]}');
  const bad = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 }); assert.equal(bad.status, 2); assert.match(bad.stderr, /failed health/);
  writeFileSync(checks, '{"preserve":[{"name":"wrong group","sql":"SELECT 1;"}]}');
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
  writeFileSync(checks, Buffer.from([0xff])); assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
  const invalid = spawnSync(process.execPath, args.map(a => a === 'verify' ? 'apply' : a), { encoding: 'utf8' }); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /does not apply/);
});
