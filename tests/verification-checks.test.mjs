import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../node/runtime.mjs';

test('renaming a business table into the protected namespace fails before source writes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-rename-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,amount INTEGER); INSERT INTO orders VALUES(1,100);'); connection.close();
  const report = await run({ command: 'apply', db, migrations: [{ filename: '000001_rename.sql', sql: 'ALTER TABLE orders RENAME TO __moonmigrate_orders;' }] });
  assert.equal(report.kind, 'policy', JSON.stringify(report));
  const reader = new DatabaseSync(db);
  try { assert.equal(reader.prepare('SELECT amount FROM orders').get().amount, 100); }
  finally { reader.close(); }
});
