import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runInWorker } from '../node/runtime.mjs';

const root = mkdtempSync(join(tmpdir(), 'moonmolt-preservation-demo-')), db = join(root, 'shop.db');
const checks_json = JSON.stringify({
  preserve: [
    { name: 'order count', sql: 'SELECT COUNT(*) FROM orders;' },
    { name: 'exact monetary total', sql: 'SELECT SUM(amount_cents) FROM orders;' },
    { name: 'order identities', sql: 'SELECT json_group_array(id) FROM (SELECT id FROM orders ORDER BY id);' },
  ],
  checks: [{ name: 'all statuses backfilled', sql: "SELECT NOT EXISTS(SELECT 1 FROM orders WHERE status<>'paid');" }],
});
const migration = filter => ({ filename: '000001_order_status.sql', checks_json, sql: `
  CREATE TABLE next_orders(id INTEGER PRIMARY KEY,amount_cents INTEGER NOT NULL,status TEXT NOT NULL);
  INSERT INTO next_orders SELECT id,amount_cents,'paid' FROM orders ${filter};
  DROP TABLE orders; ALTER TABLE next_orders RENAME TO orders;
` });
function state() {
  const reader = new DatabaseSync(db);
  try {
    const query = reader.prepare('SELECT * FROM orders ORDER BY id'); query.setReadBigInts(true);
    return query.all().map(row => ({ ...row }));
  } finally { reader.close(); }
}
try {
  const fresh = new DatabaseSync(db);
  try { fresh.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,amount_cents INTEGER NOT NULL); INSERT INTO orders VALUES(10,9007199254740993),(20,345);'); }
  finally { fresh.close(); }
  const before = state();
  // Simulate a mapping bug. The schema and foreign keys would still be valid.
  const rejected = await runInWorker({ command: 'apply', db, migrations: [migration('WHERE id>10')] });
  assert.equal(rejected.kind, 'policy'); assert.equal(rejected.stage, 'rehearse');
  assert.deepEqual(state(), before);
  // Correct only the pending script; a successful migration is immutable.
  const migrations = [migration('')];
  const upgraded = await runInWorker({ command: 'apply', db, migrations });
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
  assert.deepEqual(state().map(({ status, ...row }) => row), before);
  assert.equal((await runInWorker({ command: 'apply', db, migrations })).noop, true);
  const backupVerification = await runInWorker({ command: 'verify', db: upgraded.backup, migrations, expected_version: 0 });
  assert.equal(backupVerification.ok, true, JSON.stringify(backupVerification));
  assert.equal(backupVerification.pending.length, 1);
  const verify_checks = [{ name: 'current amounts stay positive', sql: 'SELECT COUNT(*)=2 AND MIN(amount_cents)>0 FROM main.orders;' }];
  const sourceVerification = await runInWorker({ command: 'verify', db, migrations, expected_version: 1, verify_checks });
  assert.equal(sourceVerification.ok, true, JSON.stringify(sourceVerification));
  assert.equal(sourceVerification.checks.length, 1);
  // Later application damage can leave SQLite and migration history valid.
  const damaged = new DatabaseSync(db);
  try { damaged.exec('UPDATE orders SET amount_cents=0;'); } finally { damaged.close(); }
  const damagedStructure = await runInWorker({ command: 'verify', db, migrations });
  assert.equal(damagedStructure.verified, true);
  const damagedBusiness = await runInWorker({ command: 'verify', db, migrations, verify_checks });
  assert.equal(damagedBusiness.kind, 'policy');
  console.log(JSON.stringify({ rejected_lossy_upgrade: rejected.kind, source_unchanged_after_failure: true,
    preserved: upgraded.result.preserved, business_checks: upgraded.result.checks, repeat_noop: true,
    backup_verification: { verified: backupVerification.verified, current_version: backupVerification.current_version, pending: backupVerification.pending },
    source_verification: sourceVerification.validation, current_checks: sourceVerification.checks,
    later_data_damage: { sqlite_valid: damagedStructure.verified, business_check: damagedBusiness.kind } }, null, 2));
} finally {
  assert.equal(root.startsWith(join(tmpdir(), 'moonmolt-preservation-demo-')), true);
  rmSync(root, { recursive: true, force: true });
}
