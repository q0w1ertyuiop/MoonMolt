import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, runInWorker } from '../node/runtime.mjs';
import { Adapter } from '../node/adapter.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-definitions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), d = new DatabaseSync(db);
  d.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO notes VALUES(1,\'保留笔记\');'); d.close();
  return { db };
}

test('a delayed trigger cannot install future writes to migration history', async t => {
  const f = fixture(t), before = readFileSync(f.db);
  const report = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_trigger.sql', sql: 'CREATE TRIGGER erase_history AFTER INSERT ON notes BEGIN DELETE FROM __moonmigrate_history; END;' }] });
  assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.equal(report.stage, 'rehearse'); assert.deepEqual(readFileSync(f.db), before);
});

test('insert, delete and column-specific update triggers cannot hide protected accesses', async t => {
  for (const sql of [
    'CREATE TRIGGER bad AFTER DELETE ON notes BEGIN DELETE FROM __moonmigrate_history; END;',
    'CREATE TRIGGER bad AFTER UPDATE OF body ON notes WHEN NEW.body IS NOT NULL BEGIN SELECT COUNT(*) FROM __MOONMIGRATE_HISTORY; END;',
    'CREATE VIEW leaked AS SELECT version FROM __moonmigrate_history;',
    'CREATE VIEW leaked AS SELECT version FROM __moonmigrate_history; CREATE TRIGGER bad AFTER INSERT ON notes BEGIN SELECT * FROM leaked; END;',
    'CREATE VIEW editable AS SELECT * FROM notes; CREATE TRIGGER bad INSTEAD OF INSERT ON editable BEGIN DELETE FROM __moonmigrate_history; END;',
  ]) {
    const f = fixture(t), before = readFileSync(f.db);
    const report = await runInWorker({ command: 'apply', db: f.db, migrations: [{ filename: '000001_definition.sql', sql }] });
    assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.match(report.message, /protected migration metadata/); assert.deepEqual(readFileSync(f.db), before);
  }
});

test('unresolved final views and trigger bodies fail without modifying source data', async t => {
  for (const sql of ['CREATE VIEW broken AS SELECT absent FROM notes;', 'CREATE VIEW broken AS SELECT * FROM missing;', 'CREATE TRIGGER broken AFTER INSERT ON notes BEGIN INSERT INTO missing VALUES(NEW.id); END;']) {
    const f = fixture(t), before = readFileSync(f.db);
    const report = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_broken.sql', sql }] });
    assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.match(report.message, /view|trigger program/); assert.deepEqual(readFileSync(f.db), before);
  }
});

test('later scripts can resolve earlier definitions and valid programs never run during validation', async t => {
  const f = fixture(t);
  const migrations = [
    { filename: '000001_view.sql', sql: 'CREATE VIEW later_view AS SELECT * FROM later_table;' },
    { filename: '000002_table.sql', sql: `CREATE TABLE later_table(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO later_table VALUES(5,'ok');
      CREATE TABLE audit(value TEXT);
      CREATE TRIGGER log_insert AFTER INSERT ON notes BEGIN INSERT INTO audit VALUES('insert'); END;
      CREATE TRIGGER log_update AFTER UPDATE OF body ON notes BEGIN INSERT INTO audit VALUES('update'); END;
      CREATE TRIGGER log_delete AFTER DELETE ON notes BEGIN INSERT INTO audit VALUES('delete'); END;` },
  ];
  const report = await runInWorker({ command: 'apply', db: f.db, migrations }); assert.equal(report.ok, true, JSON.stringify(report));
  const before = readFileSync(f.db);
  assert.equal((await run({ command: 'verify', db: f.db, migrations })).verified, true);
  assert.deepEqual(readFileSync(f.db), before);
  const d = new DatabaseSync(f.db);
  try {
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0); assert.equal(d.prepare('SELECT value FROM later_view').get().value, 'ok');
    d.exec("INSERT INTO notes VALUES(2,'new'); UPDATE notes SET body='changed' WHERE id=2; DELETE FROM notes WHERE id=2;");
    assert.deepEqual(d.prepare('SELECT value FROM audit ORDER BY rowid').all().map(r => r.value), ['insert', 'update', 'delete']);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM __moonmigrate_history').get().n, 2);
  } finally { d.close(); }
});

test('INSTEAD OF view programs and generated columns keep their valid write behavior', async t => {
  const f = fixture(t);
  const migrations = [{ filename: '000001_writable.sql', sql: `
    CREATE TABLE generated(id INTEGER PRIMARY KEY,value INTEGER,doubled INTEGER GENERATED ALWAYS AS(value*2) STORED);
    CREATE TABLE changes_log(id INTEGER);
    CREATE TRIGGER changed AFTER UPDATE OF value ON generated BEGIN INSERT INTO changes_log VALUES(NEW.id); END;
    CREATE VIEW "editable notes" AS SELECT * FROM notes;
    CREATE TRIGGER insert_view INSTEAD OF INSERT ON "editable notes" BEGIN INSERT INTO notes VALUES(NEW.id,NEW.body); END;
  ` }];
  const report = await run({ command: 'apply', db: f.db, migrations }); assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal((await runInWorker({ command: 'verify', db: f.db, migrations })).verified, true);
  const d = new DatabaseSync(f.db);
  try { d.exec(`INSERT INTO "editable notes" VALUES(2,'view insert'); INSERT INTO generated(id,value) VALUES(1,4); UPDATE generated SET value=5;`); assert.equal(d.prepare('SELECT doubled FROM generated').get().doubled, 10); assert.equal(d.prepare('SELECT COUNT(*) AS n FROM changes_log').get().n, 1); }
  finally { d.close(); }
});

test('verification diagnoses legacy broken definitions and a reviewed forward migration can repair them', async t => {
  const f = fixture(t), d = new DatabaseSync(f.db); d.exec('CREATE VIEW broken AS SELECT * FROM missing;'); d.close();
  const before = readFileSync(f.db), migrations = [{ filename: '000001_repair.sql', sql: 'DROP VIEW broken; CREATE VIEW broken AS SELECT * FROM notes;' }];
  const rejected = await runInWorker({ command: 'verify', db: f.db, migrations }); assert.equal(rejected.kind, 'policy'); assert.match(rejected.message, /broken/); assert.deepEqual(readFileSync(f.db), before);
  assert.equal((await run({ command: 'apply', db: f.db, migrations })).ok, true);
  assert.equal((await run({ command: 'verify', db: f.db, migrations })).verified, true);
});

test('a source-only bad definition after successful rehearsal rolls back the entire batch', async t => {
  const f = fixture(t), before = readFileSync(f.db), original = Adapter.prototype.script;
  Adapter.prototype.script = function(id, sql, filename) { return original.call(this, id, sql + (id === 'source' ? ' CREATE VIEW broken AS SELECT * FROM missing;' : ''), filename); };
  let report;
  try { report = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_update.sql', sql: "UPDATE notes SET body='changed';" }] }); }
  finally { Adapter.prototype.script = original; }
  assert.equal(report.kind, 'policy'); assert.equal(report.stage, 'apply'); assert.deepEqual(readFileSync(f.db), before);
  assert.equal((await run({ command: 'verify', db: report.backup, migrations: [] })).verified, true);
});

test('adding a column cannot activate a previously dormant protected trigger', async t => {
  const f = fixture(t);
  const dormant = { filename: '000001_dormant.sql', sql: 'CREATE TRIGGER dormant AFTER UPDATE OF future_column ON notes BEGIN DELETE FROM __moonmigrate_history; END;' };
  // SQLite permits UPDATE OF names which do not yet exist. Such an event
  // cannot run until the column is added; compilation is repeated then.
  const first = await run({ command: 'apply', db: f.db, migrations: [dormant] }); assert.equal(first.ok, true, JSON.stringify(first));
  const before = readFileSync(f.db);
  const report = await runInWorker({ command: 'apply', db: f.db, migrations: [dormant, { filename: '000002_activate.sql', sql: 'ALTER TABLE notes ADD COLUMN future_column INTEGER;' }] });
  assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.match(report.message, /protected migration metadata/); assert.deepEqual(readFileSync(f.db), before);
});

test('ROWID alias update triggers receive the same protected metadata checks', async t => {
  for (const alias of ['rowid', '_rowid_', 'oid']) {
    const f = fixture(t), before = readFileSync(f.db);
    const report = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_alias.sql', sql: `CREATE TRIGGER bad AFTER UPDATE OF ${alias} ON notes BEGIN DELETE FROM __moonmigrate_history; END;` }] });
    assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.deepEqual(readFileSync(f.db), before);
  }
});

test('WITHOUT ROWID tables and real columns shadowing aliases remain valid', async t => {
  const f = fixture(t);
  const migrations = [{ filename: '000001_identifiers.sql', sql: `
    CREATE TABLE entries(key TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID;
    CREATE TABLE shadowed(rowid TEXT,oid TEXT,_rowid_ TEXT,value TEXT);
    CREATE TABLE audit(value TEXT);
    CREATE TRIGGER entry_update AFTER UPDATE OF value ON entries BEGIN INSERT INTO audit VALUES(NEW.value); END;
    CREATE TRIGGER alias_update AFTER UPDATE OF rowid ON shadowed BEGIN INSERT INTO audit VALUES(NEW.rowid); END;
  ` }];
  const report = await runInWorker({ command: 'apply', db: f.db, migrations }); assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal((await run({ command: 'verify', db: f.db, migrations })).verified, true);
  const d = new DatabaseSync(f.db);
  try { assert.equal(d.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0); }
  finally { d.close(); }
});
