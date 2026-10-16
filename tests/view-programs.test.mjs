import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, runInWorker } from '../node/runtime.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-view-programs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), d = new DatabaseSync(db);
  d.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO notes VALUES(1,'keep');"); d.close();
  return { db };
}

test('a broken INSTEAD OF body is not mistaken for an unsupported view operation', async t => {
  for (const [event, body] of [['INSERT', 'UPDATE editable SET body=NEW.body;'], ['DELETE', "UPDATE editable SET body='bad';"], ['UPDATE', 'DELETE FROM editable;']]) {
    const f = fixture(t), before = readFileSync(f.db);
    const report = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_broken.sql', sql: `
      CREATE VIEW editable AS SELECT * FROM notes;
      CREATE TRIGGER broken INSTEAD OF ${event} ON editable BEGIN ${body} END;
    ` }] });
    assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.equal(report.stage, 'rehearse'); assert.deepEqual(readFileSync(f.db), before);
  }
});

test('separate INSERT-only, DELETE-only and UPDATE-only views remain usable', async t => {
  const f = fixture(t);
  const migrations = [{ filename: '000001_views.sql', sql: `
    CREATE VIEW inserts AS SELECT * FROM notes;
    CREATE VIEW deletes AS SELECT * FROM notes;
    CREATE VIEW updates AS SELECT * FROM notes;
    CREATE TRIGGER insert_notes INSTEAD OF INSERT ON inserts BEGIN INSERT INTO notes VALUES(NEW.id,NEW.body); END;
    CREATE TRIGGER delete_notes INSTEAD OF DELETE ON deletes BEGIN DELETE FROM notes WHERE id=OLD.id; END;
    CREATE TRIGGER update_notes INSTEAD OF UPDATE OF body ON updates BEGIN UPDATE notes SET body=NEW.body WHERE id=OLD.id; END;
  ` }];
  const report = await runInWorker({ command: 'apply', db: f.db, migrations }); assert.equal(report.ok, true, JSON.stringify(report));
  const before = readFileSync(f.db);
  assert.equal((await run({ command: 'verify', db: f.db, migrations })).verified, true); assert.deepEqual(readFileSync(f.db), before);
  const d = new DatabaseSync(f.db);
  try {
    assert.deepEqual(d.prepare('SELECT body FROM notes').all().map(r => r.body), ['keep']);
    d.exec("INSERT INTO inserts VALUES(2,'new'); UPDATE updates SET body='changed' WHERE id=2;");
    assert.equal(d.prepare('SELECT body FROM notes WHERE id=2').get().body, 'changed');
    d.exec('DELETE FROM deletes WHERE id=2;'); assert.equal(d.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 1);
    assert.throws(() => d.prepare('DELETE FROM inserts;'), /cannot modify/);
  } finally { d.close(); }
});

test('quoted names, escaped quotes and comments cannot change the declared trigger event', async t => {
  for (const name of ['begin', '"INSTEAD OF DELETE"', "'INSTEAD OF UPDATE'", '`INSTEAD OF DELETE`', '[INSTEAD OF UPDATE]', '"quote"" INSTEAD OF DELETE"', '"中文 INSTEAD OF UPDATE"']) {
    const f = fixture(t);
    const migrations = [{ filename: '000001_header.sql', sql: `CREATE VIEW editable AS SELECT * FROM notes;
      CREATE TRIGGER ${name} /* INSTEAD OF DELETE */ inStead/* gap */oF-- INSERT header continues
      inSert ON editable BEGIN INSERT INTO notes VALUES(NEW.id,NEW.body); END;` }];
    const report = await run({ command: 'apply', db: f.db, migrations }); assert.equal(report.ok, true, JSON.stringify(report));
    const d = new DatabaseSync(f.db);
    try { d.exec("INSERT INTO editable VALUES(2,'works');"); assert.equal(d.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 2); }
    finally { d.close(); }
  }
});

test('fake events inside trigger names cannot hide protected body access', async t => {
  for (const [event, name] of [['INSERT', '"INSTEAD OF DELETE"'], ['DELETE', '[INSTEAD OF INSERT]'], ['UPDATE', '`INSTEAD OF INSERT`']]) {
    const f = fixture(t), before = readFileSync(f.db);
    const report = await runInWorker({ command: 'apply', db: f.db, migrations: [{ filename: '000001_protected.sql', sql: `CREATE VIEW editable AS SELECT * FROM notes;
      CREATE TRIGGER ${name} INSTEAD/* event */OF ${event} ON editable BEGIN DELETE FROM __moonmigrate_history; END;` }] });
    assert.equal(report.kind, 'policy', JSON.stringify(report)); assert.match(report.message, /protected migration metadata/); assert.deepEqual(readFileSync(f.db), before);
  }
});

test('read-only verification catches legacy broken bodies and a forward repair restores application writes', async t => {
  const f = fixture(t), legacy = new DatabaseSync(f.db);
  legacy.exec('CREATE VIEW editable AS SELECT * FROM notes; CREATE TRIGGER broken INSTEAD OF INSERT ON editable BEGIN UPDATE editable SET body=NEW.body; END;'); legacy.close();
  const before = readFileSync(f.db), migrations = [{ filename: '000001_repair.sql', sql: 'DROP TRIGGER broken; CREATE TRIGGER writer INSTEAD OF INSERT ON editable BEGIN INSERT INTO notes VALUES(NEW.id,NEW.body); END;' }];
  const rejected = await runInWorker({ command: 'verify', db: f.db, migrations }); assert.equal(rejected.kind, 'policy'); assert.deepEqual(readFileSync(f.db), before);
  assert.equal((await run({ command: 'apply', db: f.db, migrations })).ok, true);
  assert.equal((await run({ command: 'verify', db: f.db, migrations })).verified, true);
  const d = new DatabaseSync(f.db);
  try { d.exec("INSERT INTO editable VALUES(2,'repaired');"); assert.equal(d.prepare('SELECT body FROM notes WHERE id=2').get().body, 'repaired'); }
  finally { d.close(); }
});

test('multiple declared events on the same view are each checked without firing them', async t => {
  const f = fixture(t);
  const migrations = [{ filename: '000001_events.sql', sql: `CREATE VIEW editable AS SELECT * FROM notes;
    CREATE TABLE audit(event TEXT);
    CREATE TRIGGER inserted INSTEAD OF INSERT ON editable BEGIN INSERT INTO audit VALUES('insert'); END;
    CREATE TRIGGER deleted INSTEAD OF DELETE ON editable BEGIN INSERT INTO audit VALUES('delete'); END;
    CREATE TRIGGER updated INSTEAD OF UPDATE ON editable BEGIN INSERT INTO audit VALUES('update'); END;` }];
  const report = await runInWorker({ command: 'apply', db: f.db, migrations }); assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal((await run({ command: 'verify', db: f.db, migrations })).verified, true);
  const d = new DatabaseSync(f.db);
  try {
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0);
    d.exec("INSERT INTO editable VALUES(2,'new'); UPDATE editable SET body='changed'; DELETE FROM editable;");
    assert.deepEqual(d.prepare('SELECT event FROM audit ORDER BY rowid').all().map(r => r.event), ['insert', 'update', 'delete']);
  } finally { d.close(); }
});

test('a declared view UPDATE event needs a writable target by the end of the batch', async t => {
  const f = fixture(t), sql = `CREATE VIEW editable AS SELECT * FROM notes;
    CREATE TRIGGER deferred INSTEAD OF UPDATE OF future_column ON editable BEGIN UPDATE notes SET body=NEW.body WHERE id=OLD.id; END;`;
  const rejected = await run({ command: 'apply', db: f.db, migrations: [{ filename: '000001_deferred.sql', sql }] });
  assert.equal(rejected.kind, 'policy', JSON.stringify(rejected));
  // Earlier forward references are still allowed once a later script makes
  // the view's declared operation usable before final batch validation.
  const migrations = [{ filename: '000001_deferred.sql', sql }, { filename: '000002_ready.sql', sql: 'ALTER TABLE notes ADD COLUMN future_column INTEGER;' }];
  const accepted = await runInWorker({ command: 'apply', db: f.db, migrations }); assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const d = new DatabaseSync(f.db);
  try { d.exec("UPDATE editable SET body='ready',future_column=1 WHERE id=1;"); assert.equal(d.prepare('SELECT body FROM notes').get().body, 'ready'); }
  finally { d.close(); }
});
