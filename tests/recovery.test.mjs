import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { run, plan } from '../node/runtime.mjs';
import { Adapter } from '../node/adapter.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), dir = join(root, 'migrations');
  mkdirSync(dir);
  const connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE t(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO t VALUES(1,10);');
  connection.close();
  writeFileSync(join(dir, '000001_upgrade.sql'), 'UPDATE t SET value=value+1; ALTER TABLE t ADD COLUMN label TEXT;');
  return { root, db, dir };
}
function check(dbPath) {
  const db = new DatabaseSync(dbPath);
  try { return { rows: db.prepare('SELECT * FROM t').all().map(r => ({ ...r })), history: db.prepare("SELECT name FROM sqlite_schema WHERE name='__moonmigrate_history'").all().length }; }
  finally { db.close(); }
}
function childResult(child) {
  let out = '', err = '';
  child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  return once(child, 'close').then(([code]) => ({ code, out, err }));
}

test('two process executors recheck history after acquiring the write lock', async t => {
  const f = fixture(t);
  const args = ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--format', 'json'];
  const a = childResult(spawn(process.execPath, args));
  const b = childResult(spawn(process.execPath, args));
  const results = await Promise.all([a, b]);
  for (const result of results) assert.equal(result.code, 0, result.err);
  const reports = results.map(r => JSON.parse(r.out));
  assert.equal(reports.filter(r => r.noop).length, 1);
  assert.equal(check(f.db).rows[0].value, 11);
});

test('write lock timeout returns exit category 3 and leaves database intact', async t => {
  const f = fixture(t);
  const lock = new DatabaseSync(f.db);
  lock.exec('BEGIN IMMEDIATE;');
  let result;
  try { result = await run({ command: 'apply', ...f }); }
  finally { lock.exec('ROLLBACK;'); lock.close(); }
  assert.equal(result.kind, 'lock_timeout', JSON.stringify(result));
  assert.equal(result.exit_code, 3);
  assert.deepEqual(check(f.db), { rows: [{ id: 1, value: 10 }], history: 0 });
});

test('failure during actual execution after successful rehearsal rolls back the entire batch', async t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, '000002_index.sql'), 'CREATE INDEX t_value ON t(value);');
  const script = Adapter.prototype.script;
  Adapter.prototype.script = function(id, sql, filename) {
    if (id === 'source' && filename.startsWith('000002')) throw new Error('injected actual-execution failure');
    return script.call(this, id, sql, filename);
  };
  let report;
  try { report = await run({ command: 'apply', ...f }); }
  finally { Adapter.prototype.script = script; }
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'apply');
  assert.deepEqual(check(f.db), { rows: [{ id: 1, value: 10 }], history: 0 });
  assert.equal(JSON.parse(readFileSync(report.report_path)).ok, false);
});

test('killing a process after a real migration but before commit recovers original state', async t => {
  const f = fixture(t);
  const childPath = join(f.root, 'crash.mjs');
  const runtime = new URL('../node/runtime.mjs', import.meta.url).href;
  const adapter = new URL('../node/adapter.mjs', import.meta.url).href;
  writeFileSync(childPath, `import {writeSync} from 'node:fs';\nimport {run} from ${JSON.stringify(runtime)};\nimport {Adapter} from ${JSON.stringify(adapter)};\nconst original=Adapter.prototype.dispatch;\nAdapter.prototype.dispatch=function(op,args){const result=original.call(this,op,args);if(op==='history_insert'&&args.id==='source'){writeSync(1,'BEFORE_COMMIT\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return result;};\nawait run(${JSON.stringify({ command: 'apply', db: f.db, dir: f.dir })});\n`);
  const child = spawn(process.execPath, [childPath]);
  let output = '';
  const closed = once(child, 'close');
  const marker = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('crash probe did not reach the pre-commit marker')); }, 15000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('BEFORE_COMMIT')) { clearTimeout(timer); resolve(); } });
    child.on('error', reject);
    child.on('close', () => { if (!output.includes('BEFORE_COMMIT')) { clearTimeout(timer); reject(new Error('crash probe exited early')); } });
  });
  await marker;
  child.kill('SIGKILL');
  await closed;
  assert.deepEqual(check(f.db), { rows: [{ id: 1, value: 10 }], history: 0 });
  const retry = await run({ command: 'apply', ...f });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(check(f.db).rows[0].value, 11);
});

test('unsupported schema fields fail closed instead of silently losing objects', () => {
  const before = { version: '1', views: [], tables: [] };
  for (const extra of [{ strict: true }, { without_rowid: true }]) {
    const result = plan({ before, after: { version: '2', views: [], tables: [{ name: 't', columns: [], indexes: [], foreign_keys: [], checks: [], triggers: [], ...extra }] } });
    assert.equal(result.kind, 'policy');
  }
});
