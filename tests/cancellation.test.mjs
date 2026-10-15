import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { run, runInWorker } from '../node/runtime.mjs';
import { Adapter } from '../node/adapter.mjs';

function fixture(t) {
  const prefix = join(tmpdir(), 'moonmolt-cancel-'), root = mkdtempSync(prefix);
  t.after(() => { assert.equal(root.startsWith(prefix), true); rmSync(root, { recursive: true, force: true }); });
  const db = join(root, 'app.db'), dir = join(root, 'migrations'); mkdirSync(dir);
  const connection = new DatabaseSync(db);
  connection.exec('CREATE TABLE t(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO t VALUES(1,10);'); connection.close();
  writeFileSync(join(dir, '000001_change.sql'), 'UPDATE t SET value=value+1; ALTER TABLE t ADD COLUMN label TEXT;');
  return { root, db, dir };
}
function original(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { value: db.prepare('SELECT value FROM t').get().value,
      columns: db.prepare('PRAGMA table_info(t)').all().length,
      history: db.prepare("SELECT name FROM sqlite_schema WHERE name='__moonmigrate_history'").all().length };
  } finally { db.close(); }
}
const initial = { value: 10, columns: 2, history: 0 };

test('pre-aborted calls create no database, backup or worker session', async t => {
  for (const execute of [run, runInWorker]) {
    const f = fixture(t), path = join(f.root, 'new.db');
    const result = await execute({ command: 'apply', db: path, dir: f.dir, create: true }, { signal: AbortSignal.abort(() => 'noncloneable reason') });
    assert.equal(result.kind, 'cancelled'); assert.equal(result.exit_code, 4);
    assert.equal(existsSync(path), false); assert.equal(existsSync(path + '.moonmolt-backups'), false);
    assert.equal((await execute({ ...f }, { signal: { aborted: false } })).kind, 'input');
  }
});

test('queued cancellation does not replace another session or open the queued database', async t => {
  const first = fixture(t), second = fixture(t), controller = new AbortController();
  const a = run({ command: 'apply', ...first });
  const b = run({ command: 'apply', ...second }, { signal: controller.signal }); controller.abort();
  assert.equal((await a).ok, true); assert.equal((await b).kind, 'cancelled');
  assert.deepEqual(original(second.db), initial);
});

test('cancellation during backup retains the completed snapshot and stops before rehearsal', async t => {
  const f = fixture(t), controller = new AbortController();
  const result = await run({ command: 'apply', ...f }, {
    signal: controller.signal, onProgress: e => { if (e.operation === 'backup' && e.state === 'start') controller.abort(); },
  });
  assert.equal(result.kind, 'cancelled'); assert.equal(result.stage, 'backup');
  assert.deepEqual(original(f.db), initial); assert.deepEqual(original(result.backup), initial);
  assert.equal(result.incomplete_backup, undefined);
  assert.equal(JSON.parse(readFileSync(result.report_path)).kind, 'cancelled');
});

test('cancelling after source SQL or just before COMMIT rolls back data schema and history', async t => {
  for (const checkpoint of ['exec_script', 'commit']) {
    const f = fixture(t), controller = new AbortController();
    const result = await run({ command: 'apply', ...f }, {
      signal: controller.signal, onProgress: e => {
        if (e.connection === 'source' && e.operation === checkpoint && e.state === (checkpoint === 'commit' ? 'start' : 'complete')) controller.abort();
      },
    });
    assert.equal(result.kind, 'cancelled', JSON.stringify(result)); assert.equal(result.stage, 'apply');
    assert.deepEqual(original(f.db), initial);
    assert.equal((await run({ command: 'apply', ...f })).ok, true);
    assert.equal(original(f.db).value, 11);
  }
});

test('a completed COMMIT wins over late cancellation and is never replayed', async t => {
  const f = fixture(t), controller = new AbortController();
  const result = await run({ command: 'apply', ...f }, {
    signal: controller.signal, onProgress: e => { if (e.connection === 'source' && e.operation === 'commit' && e.state === 'complete') controller.abort(); },
  });
  assert.equal(controller.signal.aborted, true); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await runInWorker({ command: 'apply', ...f })).noop, true); assert.equal(original(f.db).value, 11);
});

test('worker observes cancellation while blocked in SQLite and cleans up abort listeners', async t => {
  const f = fixture(t), controller = new AbortController();
  const lock = new DatabaseSync(f.db); lock.exec('BEGIN IMMEDIATE;');
  let timer;
  const pending = runInWorker({ command: 'apply', ...f, busy_timeout_ms: 2000 }, {
    signal: controller.signal, onProgress: e => {
      if (e.operation === 'begin' && e.state === 'start') {
        timer = setTimeout(() => { controller.abort(); lock.exec('ROLLBACK;'); }, 50);
      }
    },
  });
  let result;
  try { result = await pending; } finally { clearTimeout(timer); lock.close(); }
  assert.equal(result.kind, 'cancelled', JSON.stringify(result)); assert.deepEqual(original(f.db), initial);
  const { getEventListeners } = await import('node:events');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const completed = new AbortController();
  assert.equal((await runInWorker({ command: 'apply', ...f }, { signal: completed.signal })).ok, true);
  assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
});

test('worker cancellation after an actual source write rolls back instead of terminating', t => {
  const f = fixture(t), preload = join(f.root, 'pause.mjs');
  const adapter = new URL('../node/adapter.mjs', import.meta.url).href;
  const runtime = new URL('../node/runtime.mjs', import.meta.url).href;
  writeFileSync(preload, `import {Adapter} from ${JSON.stringify(adapter)};const original=Adapter.prototype.dispatch;Adapter.prototype.dispatch=function(op,args){const result=original.call(this,op,args);if(op==='exec_script'&&args.id==='source'){this.onProgress({stage:'apply',operation:'exec_script',state:'progress',filename:'written-checkpoint'});const deadline=Date.now()+5000;while(!this.isCancelled()){if(Date.now()>deadline)throw new Error('cancellation flag did not arrive');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}}return result;};`);
  const code = `import {runInWorker} from ${JSON.stringify(runtime)};const c=new AbortController();const result=await runInWorker(${JSON.stringify({ command: 'apply', db: f.db, dir: f.dir })},{signal:c.signal,onProgress:e=>{if(e.filename==='written-checkpoint')c.abort();}});console.log(JSON.stringify(result));`;
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout); assert.equal(result.kind, 'cancelled', child.stdout);
  assert.deepEqual(original(f.db), initial); assert.deepEqual(original(result.backup), initial);
});

test('CLI SIGINT handler waits for worker rollback and returns cancellation exit code', t => {
  const f = fixture(t), preload = join(f.root, 'signal.mjs');
  const lock = new DatabaseSync(f.db); lock.exec('BEGIN IMMEDIATE;');
  writeFileSync(preload, `const write=process.stderr.write.bind(process.stderr);let sent=false;process.stderr.write=function(chunk,...args){const result=write(chunk,...args);try{const e=JSON.parse(String(chunk));if(!sent&&e.type==='progress'&&e.operation==='begin'&&e.state==='start'){sent=true;queueMicrotask(()=>process.emit('SIGINT'));}}catch{}return result;};`);
  let child;
  try {
    child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'node/cli.mjs', 'apply', '--db', f.db, '--dir', f.dir, '--worker', '--progress', '--busy-timeout-ms', '150', '--format', 'json'], { encoding: 'utf8', timeout: 15000 });
  } finally { lock.close(); }
  assert.equal(child.status, 4, child.stderr);
  const report = child.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(e => e.kind === 'cancelled');
  assert.equal(report.exit_code, 4); assert.deepEqual(original(f.db), initial);
});

test('lost COMMIT acknowledgement stays uncertain even when cancellation is requested', async t => {
  const f = fixture(t), controller = new AbortController();
  const dispatch = Adapter.prototype.dispatch;
  Adapter.prototype.dispatch = function(op, args) {
    const result = dispatch.call(this, op, args);
    if (op === 'commit' && args.id === 'source') {
      controller.abort();
      throw Object.assign(new Error('lost acknowledgement'), { kind: 'commit_outcome_unknown' });
    }
    return result;
  };
  let result;
  try { result = await run({ command: 'apply', ...f }, { signal: controller.signal }); }
  finally { Adapter.prototype.dispatch = dispatch; }
  assert.equal(result.kind, 'commit_outcome_unknown'); assert.equal(original(f.db).value, 11);
  assert.equal((await run({ command: 'apply', ...f })).noop, true);
});
