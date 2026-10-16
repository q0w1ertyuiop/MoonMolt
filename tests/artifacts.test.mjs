import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, runInWorker } from '../node/runtime.mjs';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO notes VALUES(1,\'private note\');'); connection.close();
  return { root, db, migrations: [{ filename: '000001_label.sql', sql: 'ALTER TABLE notes ADD COLUMN label TEXT;' }] };
}

test('a backup filename is reserved before its start event is published', async t => {
  const f = fixture(t); let reserved = false, empty = false;
  const report = await run({ command: 'apply', db: f.db, migrations: f.migrations }, { onProgress(event) {
    if (event.operation === 'backup' && event.state === 'start') {
      reserved = existsSync(event.backup); empty = reserved && statSync(event.backup).size === 0;
    }
  } });
  assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(reserved, true); assert.equal(empty, true);
  assert.equal(statSync(report.backup).size > 0, true);
  const backup = new DatabaseSync(report.backup, { readOnly: true });
  try { assert.equal(backup.prepare('SELECT body FROM notes').get().body, 'private note'); }
  finally { backup.close(); }
});

test('a colliding backup file is never overwritten or claimed as an incomplete snapshot', async t => {
  const f = fixture(t), backup_dir = join(f.root, 'backups'); mkdirSync(backup_dir);
  const iso = '2000-01-02T03:04:05.000Z', uuid = '00000000-0000-4000-8000-000000000000';
  const collision = join(backup_dir, `${iso.replaceAll(':', '-')}-${uuid}.sqlite`);
  const archived = new DatabaseSync(collision);
  archived.exec('CREATE TABLE archive(value TEXT); INSERT INTO archive VALUES(\'existing backup must remain intact\');'); archived.close();
  const original = readFileSync(collision);
  const random = crypto.randomUUID, toISOString = Date.prototype.toISOString;
  let report;
  try {
    crypto.randomUUID = () => uuid; syncBuiltinESMExports();
    Date.prototype.toISOString = () => iso;
    report = await run({ command: 'apply', db: f.db, migrations: f.migrations, backup_dir });
  } finally { crypto.randomUUID = random; syncBuiltinESMExports(); Date.prototype.toISOString = toISOString; }
  assert.equal(report.ok, false); assert.equal(report.stage, 'backup');
  assert.equal(report.backup, undefined); assert.equal(report.incomplete_backup, undefined); assert.equal(report.report_path, undefined);
  assert.equal(existsSync(collision + '.json'), false); assert.deepEqual(readFileSync(collision), original);
  const db = new DatabaseSync(f.db);
  try { assert.equal(db.prepare('PRAGMA table_info(notes)').all().length, 2); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='__moonmigrate_history'").get().n, 0); }
  finally { db.close(); }
});

test('report collisions preserve the completed migration, existing report and usable backup', async t => {
  const f = fixture(t); let collision;
  const report = await run({ command: 'apply', db: f.db, migrations: f.migrations }, { onProgress(event) {
    if (event.operation === 'backup' && event.state === 'complete') {
      collision = event.backup + '.json'; writeFileSync(collision, 'existing report');
    }
  } });
  assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.report_path, undefined); assert.match(report.report_warning, /EEXIST/);
  assert.equal(readFileSync(collision, 'utf8'), 'existing report');
  assert.equal((await run({ command: 'verify', db: report.backup, migrations: f.migrations, expected_version: 0 })).verified, true);
  assert.equal((await run({ command: 'apply', db: f.db, migrations: f.migrations })).noop, true);
});

test('a backup destination that is a file fails before SQL and leaves no claimed snapshot', async t => {
  const f = fixture(t), backup_dir = join(f.root, 'not-a-directory'); writeFileSync(backup_dir, 'keep me');
  const before = readFileSync(f.db);
  const report = await runInWorker({ command: 'apply', db: f.db, migrations: f.migrations, backup_dir });
  assert.equal(report.ok, false); assert.equal(report.stage, 'backup'); assert.equal(report.backup, undefined); assert.equal(report.incomplete_backup, undefined);
  assert.deepEqual(readFileSync(f.db), before); assert.equal(readFileSync(backup_dir, 'utf8'), 'keep me');
});

test('rehearsal reserves its private snapshot and removes all temporary artifacts afterward', async t => {
  const f = fixture(t); let reserved = false, backupPath;
  const before = readFileSync(f.db);
  const report = await run({ command: 'rehearse', db: f.db, migrations: f.migrations }, { onProgress(event) {
    if (event.operation === 'backup' && event.state === 'start') { backupPath = event.backup; reserved = existsSync(backupPath); }
  } });
  assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(reserved, true); assert.equal(existsSync(backupPath), false);
  assert.equal(report.backup, undefined); assert.deepEqual(readFileSync(f.db), before); assert.equal(existsSync(f.db + '.moonmolt-backups'), false);
});

test('failed rehearsal retains a complete private backup and an accurate failure report', async t => {
  const f = fixture(t), before = readFileSync(f.db);
  const report = await runInWorker({ command: 'apply', db: f.db, migrations: [{ filename: '000001_broken.sql', sql: 'DELETE FROM notes; INSERT INTO missing_table VALUES(1);' }] });
  assert.equal(report.ok, false); assert.equal(report.stage, 'rehearse'); assert.deepEqual(readFileSync(f.db), before);
  assert.equal(JSON.parse(readFileSync(report.report_path)).ok, false);
  assert.equal((await run({ command: 'verify', db: report.backup, migrations: f.migrations, expected_version: 0 })).verified, true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(report.backup).mode & 0o077, 0); assert.equal(statSync(report.report_path).mode & 0o077, 0);
  }
});

test('new backup directories and SQLite/report files are private on POSIX', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); chmodSync(f.db, 0o600);
  const report = await runInWorker({ command: 'apply', db: f.db, migrations: f.migrations });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(statSync(f.db + '.moonmolt-backups').mode & 0o077, 0);
  assert.equal(statSync(report.backup).mode & 0o077, 0);
  assert.equal(statSync(report.report_path).mode & 0o077, 0);
});

test('private artifact modes do not change a caller-managed backup directory', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), backup_dir = join(f.root, 'managed-backups'); mkdirSync(backup_dir); chmodSync(backup_dir, 0o755);
  const report = await run({ command: 'apply', db: f.db, migrations: f.migrations, backup_dir });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(statSync(backup_dir).mode & 0o777, 0o755);
  assert.equal(statSync(report.backup).mode & 0o077, 0); assert.equal(statSync(report.report_path).mode & 0o077, 0);
  assert.equal(JSON.parse(readFileSync(report.report_path)).ok, true);
});
