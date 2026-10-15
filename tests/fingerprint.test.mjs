import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run, runInWorker } from '../node/runtime.mjs';

function withDb(path, fn) {
  const db = new DatabaseSync(path);
  try { return fn(db); } finally { db.close(); }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-fingerprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), dir = join(root, 'migrations'); mkdirSync(dir);
  withDb(db, db => db.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,amount INTEGER); INSERT INTO orders VALUES(1,100);'));
  const migrations = [{ filename: '000001_label.sql', sql: "ALTER TABLE orders ADD COLUMN label TEXT DEFAULT 'paid';" }];
  writeFileSync(join(dir, migrations[0].filename), migrations[0].sql);
  return { root, db, dir, migrations };
}
const inspected = async db => {
  const report = await run({ command: 'inspect', db }); assert.equal(report.ok, true, JSON.stringify(report)); return report.snapshot.fingerprint;
};

test('a reviewed legacy schema cannot acquire an unexpected trigger before its first upgrade', async t => {
  const f = fixture(t), expected_fingerprint = await inspected(f.db);
  withDb(f.db, db => db.exec('CREATE TRIGGER unexpected AFTER UPDATE ON orders BEGIN UPDATE orders SET amount=0; END;'));
  const before = readFileSync(f.db), events = [];
  const migrations = [{ filename: '000001_change.sql', sql: 'UPDATE orders SET amount=amount+1;' }];
  const report = await runInWorker({ command: 'apply', db: f.db, migrations, expected_fingerprint }, { onProgress: e => events.push(e) });
  assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.match(report.message, /schema fingerprint mismatch/);
  assert.equal(report.stage, 'prepare'); assert.equal(report.backup, undefined); assert.equal(events.some(e => ['backup', 'exec_script'].includes(e.operation)), false);
  assert.deepEqual(readFileSync(f.db), before); assert.equal(existsSync(f.db + '.moonmolt-backups'), false);
  assert.equal(withDb(f.db, db => db.prepare('SELECT amount FROM orders').get().amount), 100);
});

test('all database commands enforce fingerprints, including inspection and migration no-ops', async t => {
  const f = fixture(t), fingerprint = await inspected(f.db), wrong = fingerprint === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  for (const command of ['inspect', 'status', 'verify', 'rehearse', 'apply']) {
    const request = { command, db: f.db, ...(command === 'inspect' ? {} : { migrations: [] }) }, events = [];
    const rejected = await run({ ...request, expected_fingerprint: wrong }, { onProgress: e => events.push(e) });
    assert.equal(rejected.kind, 'policy', JSON.stringify(rejected)); assert.equal(events.some(e => ['verify', 'backup', 'exec_script'].includes(e.operation)), false);
    const accepted = await run({ ...request, expected_fingerprint: fingerprint });
    assert.equal(accepted.ok, true, JSON.stringify(accepted)); assert.equal(accepted.snapshot?.fingerprint ?? accepted.fingerprint, fingerprint);
  }
});

test('status, inspection, verification and completed no-ops expose the same current fingerprint', async t => {
  const f = fixture(t), expected_fingerprint = await inspected(f.db);
  const status = await run({ command: 'status', db: f.db, migrations: f.migrations }); assert.equal(status.fingerprint, expected_fingerprint);
  const applied = await runInWorker({ command: 'apply', db: f.db, migrations: f.migrations, expected_fingerprint });
  assert.equal(applied.ok, true, JSON.stringify(applied)); assert.notEqual(applied.result.fingerprint, expected_fingerprint);
  for (const command of ['status', 'verify', 'apply']) {
    const report = await run({ command, db: f.db, migrations: f.migrations, expected_fingerprint: applied.result.fingerprint });
    assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.fingerprint, applied.result.fingerprint);
  }
  assert.equal(await inspected(f.db), applied.result.fingerprint);
  const stale = await run({ command: 'apply', db: f.db, migrations: f.migrations, expected_fingerprint });
  assert.equal(stale.kind, 'policy'); assert.equal(stale.backup, undefined);
});

test('two workers recheck a reviewed schema after acquiring the SQLite write lock', async t => {
  const f = fixture(t), expected_fingerprint = await inspected(f.db);
  const reports = await Promise.all([0, 1].map(() => runInWorker({ command: 'apply', db: f.db, migrations: f.migrations, expected_fingerprint })));
  assert.equal(reports.filter(r => r.ok).length, 1, JSON.stringify(reports));
  assert.equal(reports.filter(r => r.kind === 'policy' && /fingerprint mismatch/.test(r.message)).length, 1);
  assert.equal(withDb(f.db, db => db.prepare('SELECT COUNT(*) AS count FROM __moonmigrate_history').get().count), 1);
});

test('schema expectations are captured before queueing and do not fingerprint business data', async t => {
  for (const execute of [run, runInWorker]) {
    const f = fixture(t), expected_fingerprint = await inspected(f.db);
    withDb(f.db, db => db.exec('UPDATE orders SET amount=amount+7;'));
    assert.equal(await inspected(f.db), expected_fingerprint);
    const request = { command: 'apply', db: f.db, migrations: f.migrations, expected_fingerprint };
    const pending = execute(request); request.expected_fingerprint = '0'.repeat(64);
    const report = await pending; assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(withDb(f.db, db => db.prepare('SELECT amount FROM orders').get().amount), 107);
  }
});

test('malformed digest requirements fail before database creation', async t => {
  const f = fixture(t), db = join(f.root, 'missing.db');
  for (const expected_fingerprint of [null, 5, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\n', ' a'.repeat(32)]) {
    for (const execute of [run, runInWorker]) {
      const report = await execute({ command: 'apply', db, migrations: f.migrations, create: true, expected_fingerprint });
      assert.equal(report.kind, 'input'); assert.equal(existsSync(db), false);
    }
  }
});

test('schema review conditions preserve existing migration history drift diagnostics', async t => {
  const f = fixture(t);
  assert.equal((await run({ command: 'apply', db: f.db, migrations: f.migrations })).ok, true);
  const expected_fingerprint = await inspected(f.db);
  withDb(f.db, db => db.exec('CREATE INDEX outside_history ON orders(amount);'));
  const report = await run({ command: 'verify', db: f.db, migrations: f.migrations, expected_fingerprint });
  assert.equal(report.kind, 'history_mismatch'); assert.match(report.message, /outside migration history/);
});

test('CLI accepts reviewed fingerprints and rejects a stale requirement with exit category two', async t => {
  const f = fixture(t), fingerprint = await inspected(f.db);
  const args = ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--expected-fingerprint', fingerprint, '--worker', '--format', 'json'];
  const applied = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(applied.status, 0, applied.stderr);
  const stale = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(stale.status, 2, stale.stderr); assert.match(stale.stderr, /fingerprint mismatch/);
  const plan = spawnSync(process.execPath, ['node/cli.mjs', 'plan', '--before', 'absent.json', '--after', 'absent.json', '--expected-fingerprint', fingerprint], { encoding: 'utf8' });
  assert.equal(plan.status, 1); assert.match(plan.stderr, /does not apply/);
});
