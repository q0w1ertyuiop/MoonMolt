import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { run, runInWorker } from '../node/runtime.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'moonmolt-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'app.db'), dir = join(root, 'migrations'); mkdirSync(dir);
  const connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE t(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO t VALUES(1,10);'); connection.close();
  writeFileSync(join(dir, '000001_upgrade.sql'), 'UPDATE t SET value=value+1; ALTER TABLE t ADD COLUMN label TEXT;');
  writeFileSync(join(dir, '000001_upgrade.checks.json'), JSON.stringify({ checks: [{ name: 'value preserved', sql: 'SELECT value=11 FROM t;' }] }));
  return { root, db, dir };
}
function value(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT value FROM t').get().value; } finally { db.close(); }
}

test('worker upgrade emits ordered stage and business-check events and returns backup', async t => {
  const f = fixture(t), events = [];
  const result = await runInWorker({ command: 'apply', ...f }, { onProgress: e => events.push(e) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(value(f.db), 11); assert.equal(value(result.backup), 10);
  assert.equal(result.result.checks[0].name, 'value preserved');
  for (const stage of ['prepare', 'backup', 'rehearse', 'apply']) assert.equal(events.some(e => e.stage === stage), true);
  assert.equal(events.some(e => e.operation === 'exec_check' && e.connection === 'source' && e.state === 'complete'), true);
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
  assert.equal(events.at(-1).operation, 'session'); assert.equal(events.at(-1).ok, true);
  assert.equal((await runInWorker({ command: 'apply', ...f })).noop, true);
});

test('worker business failures roll back and report the failed progress operation', async t => {
  const f = fixture(t), events = [];
  writeFileSync(join(f.dir, '000001_upgrade.checks.json'), JSON.stringify({ checks: [{ name: 'fail', sql: 'SELECT 0;' }] }));
  const result = await runInWorker({ command: 'apply', ...f }, { onProgress: e => events.push(e) });
  assert.equal(result.kind, 'policy'); assert.equal(result.stage, 'rehearse'); assert.equal(value(f.db), 10);
  assert.equal(events.some(e => e.operation === 'exec_check' && e.state === 'failed'), true);
});

test('two workers use SQLite write locking to apply exactly once', async t => {
  const f = fixture(t);
  const results = await Promise.all([runInWorker({ command: 'apply', ...f }), runInWorker({ command: 'apply', ...f })]);
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(results.filter(r => r.noop).length, 1); assert.equal(value(f.db), 11);
});

test('parent event loop can release a database lock while worker waits', async t => {
  const f = fixture(t);
  const lock = new DatabaseSync(f.db); lock.exec('BEGIN IMMEDIATE;');
  let released = false, timer;
  const pending = runInWorker({ command: 'apply', ...f, busy_timeout_ms: 2000 }, {
    onProgress: e => {
      if (e.operation === 'begin' && e.connection === 'source' && e.state === 'start') {
        timer = setTimeout(() => { lock.exec('ROLLBACK;'); released = true; }, 100);
      }
    },
  });
  let result;
  try { result = await pending; } finally { clearTimeout(timer); lock.close(); }
  assert.equal(released, true); assert.equal(result.ok, true, JSON.stringify(result));
});

test('observer exceptions and rejected async callbacks cannot abort a committed migration', async t => {
  for (const execute of [run, runInWorker]) {
    const f = fixture(t);
    const result = await execute({ command: 'apply', ...f }, { onProgress: () => { throw new Error('view disconnected'); } });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(value(f.db), 11);
    assert.deepEqual(result.progress_warnings, ['onProgress: view disconnected']);
    const status = await execute({ command: 'status', ...f }, { onProgress: async () => { throw new Error('async observer failure'); } });
    assert.equal(status.ok, true); assert.equal(status.progress_warnings.length, 1);
  }
});

test('worker captures relative paths and ignores noncloneable fixture properties', async t => {
  const f = fixture(t), request = { command: 'apply', db: relative(process.cwd(), f.db), dir: relative(process.cwd(), f.dir), unused: () => {} };
  const pending = runInWorker(request); request.db = 'wrong.db';
  const cwd = process.cwd(); let result;
  try { process.chdir(tmpdir()); result = await pending; } finally { process.chdir(cwd); }
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(value(f.db), 11);
  assert.equal((await runInWorker(null)).kind, 'input');
  assert.equal((await runInWorker({ ...f }, { onProgress: 'invalid' })).kind, 'input');
});

test('stdin/eval callers do not forward input-type flags into file workers', t => {
  const f = fixture(t), runtime = new URL('../node/runtime.mjs', import.meta.url).href;
  const code = `import {runInWorker} from ${JSON.stringify(runtime)}; console.log(JSON.stringify(await runInWorker(${JSON.stringify({ command: 'apply', db: f.db, dir: f.dir })})));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout.trim()).ok, true);
});

test('worker exits after COMMIT are uncertain without replaying or hiding the backup', async t => {
  const f = fixture(t), runtime = new URL('../node/runtime.mjs', import.meta.url).href;
  const adapter = new URL('../node/adapter.mjs', import.meta.url).href;
  const preload = join(f.root, 'fault.mjs');
  writeFileSync(preload, `import {Adapter} from ${JSON.stringify(adapter)}; const original=Adapter.prototype.dispatch; Adapter.prototype.dispatch=function(op,args){const result=original.call(this,op,args);if(op==='commit'&&args.id==='source')process.exit(9);return result;};`);
  const code = `import {runInWorker} from ${JSON.stringify(runtime)};console.log(JSON.stringify(await runInWorker(${JSON.stringify({ command: 'apply', db: f.db, dir: f.dir })})));`;
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout.trim()); assert.equal(report.kind, 'commit_outcome_unknown');
  assert.equal(value(f.db), 11); assert.equal(value(report.backup), 10);
  assert.equal((await runInWorker({ command: 'apply', ...f })).noop, true);
});

test('CLI worker progress leaves stdout as a single JSON result', t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ['node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--worker', '--progress', '--format', 'json'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).ok, true);
  const events = child.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(events.every(e => e.type === 'progress'), true);
  assert.equal(events.some(e => e.operation === 'commit' && e.connection === 'source' && e.state === 'complete'), true);
});
