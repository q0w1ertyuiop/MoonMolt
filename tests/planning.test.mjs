import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, plan } from '../node/runtime.mjs';

test('generated rebuild draft executes through the real guarded adapter with backfill', async t => {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), dir = join(root, 'migrations'); mkdirSync(dir);
  const connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE t(id INTEGER PRIMARY KEY,label TEXT); INSERT INTO t VALUES(8,NULL);'); connection.close();
  const col = { name: 'id', data_type: 'INTEGER', nullable: false, primary_key: true, unique: false };
  const label = { name: 'label', data_type: 'TEXT', nullable: true, primary_key: false, unique: false };
  const before = { version: '1', views: [], tables: [{ name: 't', columns: [col, label], indexes: [], foreign_keys: [], checks: [], triggers: [] }] };
  const after = { version: '2', views: [], tables: [{ ...before.tables[0], columns: [col, { ...label, nullable: false, default_value: "'unknown'" }] }] };
  const draft = plan({ before, after, allow_destructive: true });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  writeFileSync(join(dir, '000001_required_label.sql'), draft.sql);
  const report = await run({ command: 'apply', db, dir, rebuild: true });
  assert.equal(report.ok, true, JSON.stringify(report));
  const check = new DatabaseSync(db);
  try { assert.deepEqual({ ...check.prepare('SELECT * FROM t').get() }, { id: 8, label: 'unknown' }); }
  finally { check.close(); }
});
