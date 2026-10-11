import * as core from '../dist/engine.mjs';
import { Adapter } from './adapter.mjs';
import { resolve } from 'node:path';

// The generated module calls a host function. Serialize sessions so two callers
// cannot replace one another's connection context during asynchronous backup.
const SESSION_QUEUE = Symbol.for('moonmolt.session.queue');
export function run(request) {
  let captured;
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('request must be an object');
    const { command = 'status', db, dir = 'migrations', rebuild = false, create = false, to, busy_timeout_ms = 5000, backup_dir } = request;
    if (!['inspect', 'status', 'rehearse', 'apply'].includes(command)) throw new Error('unknown command');
    if (typeof db !== 'string' || !db.trim()) throw new Error('db must be a nonempty file path');
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('dir must be a nonempty directory path');
    if (typeof rebuild !== 'boolean' || typeof create !== 'boolean') throw new Error('rebuild and create must be booleans');
    if (create && command !== 'apply') throw new Error('create only applies to apply');
    if (command === 'inspect' && (to != null || rebuild)) throw new Error('to and rebuild do not apply to inspect');
    if (to != null && (!Number.isInteger(to) || to <= 0 || to > 999999)) throw new Error('target version must be an integer between 1 and 999999');
    if (!Number.isInteger(busy_timeout_ms) || busy_timeout_ms < 0 || busy_timeout_ms > 2147483647) throw new Error('busy_timeout_ms must be an integer between 0 and 2147483647');
    if (backup_dir !== undefined && (command !== 'apply' || typeof backup_dir !== 'string' || !backup_dir.trim())) throw new Error('backup_dir requires apply and a nonempty directory path');
    captured = Object.freeze({ command, db: resolve(db), dir: resolve(dir), rebuild, create, busy_timeout_ms, ...(to == null ? {} : { to }), ...(backup_dir === undefined ? {} : { backup_dir: resolve(backup_dir) }) });
  } catch (error) {
    return Promise.resolve({ ok: false, kind: 'input', exit_code: 1, message: error.message });
  }
  const work = (globalThis[SESSION_QUEUE] ?? Promise.resolve()).then(() => execute(captured));
  globalThis[SESSION_QUEUE] = work.catch(() => {});
  return work;
}

async function execute(input) {
  let adapter;
  let report;
  const request = { command: 'status', db: '', dir: 'migrations', rebuild: false, create: false, to: null, ...input };
  if (request.to == null) delete request.to;
  try {
    if (request.to !== undefined && (!Number.isInteger(request.to) || request.to <= 0 || request.to > 999999)) {
      throw Object.assign(new Error('target version must be an integer between 1 and 999999'), { kind: 'input' });
    }
    adapter = new Adapter(request);
    globalThis.__moonmolt_dispatch = (op, args) => adapter.call(op, args);
    const result = JSON.parse(core.prepare_json(JSON.stringify(request)));
    if (!result.ok) report = result;
    else {
      const prepared = result.prepared;
      if (prepared.backup_required) await adapter.makeBackup(request.command);
      report = JSON.parse(core.complete_json(JSON.stringify(prepared)));
    }
  } catch (error) {
    report = { ok: false, kind: error.kind ?? 'runtime', exit_code: 1, message: error.message };
  } finally {
    if (adapter) {
      const warnings = adapter.cleanup();
      if (warnings.length) {
        if (report?.ok) report = { ok: false, kind: 'cleanup', exit_code: 1, message: warnings.join('; '), completed: report };
        else report.cleanup_warnings = warnings;
      }
      delete globalThis.__moonmolt_dispatch;
    }
  }
  if (adapter) {
    report.stage = adapter.stage;
    if (request.command === 'apply' && adapter.backupPath) {
      if (adapter.backupComplete) report.backup = adapter.backupPath;
      else report.incomplete_backup = adapter.backupPath;
      try { report.report_path = adapter.saveReport(report); }
      catch (error) { report.report_warning = error.message; }
    }
  }
  return report;
}

/** Pure MoonBit schema planning. Generated SQL is a draft to review and version. */
export function plan(input) {
  try {
    const { before, after, hints = { tables: [], columns: [] }, allow_destructive = false } = input;
    if (typeof allow_destructive !== 'boolean') throw new Error('allow_destructive must be a boolean');
    return JSON.parse(core.plan_json(JSON.stringify({ before, after, hints, allow_destructive })));
  } catch (error) {
    return { ok: false, kind: 'input', exit_code: 1, message: error.message };
  }
}
