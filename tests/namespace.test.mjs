import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runInWorker } from '../node/runtime.mjs';
import { Adapter } from '../node/adapter.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-namespace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,amount INTEGER); INSERT INTO orders VALUES(1,100);'); connection.close();
  return { db };
}
function original(path) {
  const db = new DatabaseSync(path);
  try { return { amount: db.prepare('SELECT amount FROM orders').get().amount, history: db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='__moonmigrate_history'").get().count }; }
  finally { db.close(); }
}

test('a TEMP shadow cannot trick a business check into accepting lost application data', async t => {
  const f = fixture(t);
  const result = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_change.sql',
    sql: 'CREATE TEMP TABLE orders AS SELECT * FROM main.orders; UPDATE main.orders SET amount=0;',
    checks_json: '{"checks":[{"name":"amount retained","sql":"SELECT SUM(amount)=100 FROM orders;"}]}' }] });
  assert.equal(result.kind, 'policy', JSON.stringify(result)); assert.match(result.message, /shadow/i);
  assert.deepEqual(original(f.db), { amount: 100, history: 0 });
});

test('collisions are rejected before a later DROP can conceal the TEMP helper', async t => {
  const f = fixture(t);
  const result = await runInWorker({ command: 'apply', db: f.db, migrations: [{ filename: '000001_hidden.sql',
    sql: 'CREATE TEMP TABLE orders AS SELECT * FROM main.orders; UPDATE orders SET amount=0; DROP TABLE temp.orders;' }] });
  assert.equal(result.kind, 'policy', JSON.stringify(result)); assert.equal(result.stage, 'rehearse');
  assert.deepEqual(original(f.db), { amount: 100, history: 0 });
});

test('views, case differences and renamed main objects obey the same no-shadow rule', async t => {
  for (const sql of [
    'CREATE TEMP VIEW OrDeRs AS SELECT 1 AS id,100 AS amount;',
    'CREATE TEMP TABLE helper(x); ALTER TABLE main.orders RENAME TO helper;',
    'CREATE TEMP VIEW target AS SELECT 1; CREATE VIEW main.target AS SELECT 2;',
    'CREATE VIEW main.order_view AS SELECT * FROM main.orders; CREATE TEMP TABLE ORDER_VIEW(id,amount);',
  ]) {
    const f = fixture(t);
    const result = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_collision.sql', sql }] });
    assert.equal(result.kind, 'policy', JSON.stringify(result)); assert.match(result.message, /shadow/i);
    assert.deepEqual(original(f.db), { amount: 100, history: 0 });
  }
});

test('distinct helper tables and views remain available across scripts', async t => {
  const f = fixture(t);
  const result = await runInWorker({ command: 'apply', db: f.db, migrations: [
    { filename: '000001_capture.sql', sql: 'CREATE TEMP TABLE saved_orders AS SELECT * FROM main.orders; CREATE TEMP VIEW saved_total AS SELECT SUM(amount) AS total FROM saved_orders;' },
    { filename: '000002_upgrade.sql', sql: 'ALTER TABLE orders ADD COLUMN label TEXT; UPDATE orders SET label=\'paid\';',
      checks_json: '{"checks":[{"name":"snapshot total retained","sql":"SELECT (SELECT SUM(amount) FROM main.orders)=(SELECT total FROM temp.saved_total);"}]}' },
  ] });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.checks.length, 1);
  assert.equal(original(f.db).amount, 100);
});

test('source-only namespace conflicts roll back earlier writes and retain the backup', async t => {
  const f = fixture(t), script = Adapter.prototype.script;
  Adapter.prototype.script = function(id, sql, filename) {
    return script.call(this, id, sql + (id === 'source' ? ' CREATE TEMP TABLE orders AS SELECT * FROM main.orders;' : ''), filename);
  };
  let report;
  try { report = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_update.sql', sql: 'UPDATE orders SET amount=amount+1;' }] }); }
  finally { Adapter.prototype.script = script; }
  assert.equal(report.kind, 'policy'); assert.equal(report.stage, 'apply');
  assert.deepEqual(original(f.db), { amount: 100, history: 0 }); assert.deepEqual(original(report.backup), { amount: 100, history: 0 });
});

test('independent index names and SQLite-owned sequence objects are not business shadows', async t => {
  const f = fixture(t);
  const report = await runInWorker({ command: 'apply', db: f.db, migrations: [{ filename: '000001_helpers.sql', sql: `
    CREATE INDEX main.lookup ON orders(amount);
    CREATE TEMP TABLE saved_orders(id,amount);
    CREATE INDEX temp.lookup ON saved_orders(id);
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TEMP TABLE saved_events(id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO events DEFAULT VALUES; INSERT INTO saved_events DEFAULT VALUES;
  ` }] });
  assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(original(f.db).amount, 100);
});
