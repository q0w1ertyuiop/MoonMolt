import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, runInWorker } from '../node/runtime.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-script-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db');
  const connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE accounts(id INTEGER PRIMARY KEY,balance INTEGER); INSERT INTO accounts VALUES(1,123);'); connection.close();
  return { db };
}
function state(path) {
  const db = new DatabaseSync(path);
  try { return { balance: db.prepare('SELECT balance FROM accounts').get().balance,
    tables: db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name) }; }
  finally { db.close(); }
}

test('unbound parameters in a later script statement cannot silently write NULL', async t => {
  for (const parameter of ['?', '?1', ':balance', '@balance', '$balance']) {
    const f = fixture(t), before = state(f.db);
    const result = await run({ command: 'apply', db: f.db, migrations: [
      { filename: '000001_prepare.sql', sql: 'CREATE TABLE new_table(value); INSERT INTO new_table VALUES(9);' },
      { filename: '000002_update.sql', sql: `UPDATE new_table SET value=value+1; UPDATE accounts SET balance=${parameter};` },
    ] });
    assert.equal(result.kind, 'policy', JSON.stringify(result)); assert.match(result.message, /000002_update.sql.*parameters/);
    assert.equal(result.stage, 'rehearse'); assert.deepEqual(state(f.db), before);
  }
});

test('SQLite statement boundaries retain triggers, escaped identifiers and parameter-looking text', async t => {
  const f = fixture(t);
  const sql = `\uFEFF ; -- ? ignored
  /* ; :ignored */ CREATE TABLE "?table"("a;b" TEXT, [@literal] TEXT, \`$column\` TEXT);
  CREATE TABLE log(value TEXT);
  CREATE TRIGGER keep_body AFTER INSERT ON "?table" BEGIN
    INSERT INTO log VALUES('first; ? :literal');
    INSERT INTO log VALUES(new."a;b" || ';second');
  END;
  INSERT INTO "?table" VALUES('quote''; ?月蜕', '@literal', '$literal');
  SELECT '?1'; ; /* unclosed trailing comment`;
  const result = await runInWorker({ command: 'apply', db: f.db, migrations: [{ filename: '000001_trigger.sql', sql }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const reader = new DatabaseSync(f.db);
  try { assert.deepEqual(reader.prepare('SELECT value FROM log ORDER BY rowid').all().map(r => r.value), ['first; ? :literal', "quote'; ?月蜕;second"]); }
  finally { reader.close(); }
});

test('comments and empty terminators remain valid no-op scripts', async t => {
  for (const sql of ['', '; ;\r\n-- ignored ? :a', '/* comment */', '\uFEFF; /* unclosed']) {
    const f = fixture(t);
    const result = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_noop.sql', sql }] });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(state(f.db).balance, 123);
  }
});

test('every statement retains authorizer restrictions and syntax failures roll back', async t => {
  for (const tail of ['COMMIT;', 'SAVEPOINT forbidden;', 'PRAGMA user_version=10;', "ATTACH ':memory:' AS other;", 'DELETE FROM __moonmigrate_history;', 'SELECT FROM broken;', '\u000b SELECT 1;']) {
    const f = fixture(t), before = state(f.db);
    const result = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_guard.sql', sql: 'UPDATE accounts SET balance=0; CREATE TABLE preceding(x); ' + tail }] });
    assert.equal(result.ok, false); assert.equal(result.stage, 'rehearse'); assert.deepEqual(state(f.db), before);
    assert.equal(result.kind, tail.includes('broken') || tail.startsWith('\u000b') ? 'database' : 'policy', JSON.stringify(result));
  }
});
