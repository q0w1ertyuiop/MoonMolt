import * as core from '../dist/engine.mjs';
import { Adapter } from './adapter.mjs';
import { captureRequest, inputFailure } from './request.mjs';
import { progressObserver } from './progress.mjs';
export { runInWorker } from './worker.mjs';

// The generated module calls a host function. Serialize sessions so two callers
// cannot replace one another's connection context during asynchronous backup.
const SESSION_QUEUE = Symbol.for('moonmolt.session.queue');
export function run(request, options = {}) {
  let captured, observer;
  try {
    captured = captureRequest(request);
    observer = progressObserver(options);
  } catch (error) {
    return Promise.resolve(inputFailure(error));
  }
  const work = (globalThis[SESSION_QUEUE] ?? Promise.resolve()).then(() => execute(captured, observer));
  globalThis[SESSION_QUEUE] = work.catch(() => {});
  return work;
}

async function execute(input, observer) {
  let adapter;
  let report;
  const request = { command: 'status', db: '', dir: 'migrations', rebuild: false, create: false, to: null, ...input };
  if (request.to == null) delete request.to;
  observer.emit({ stage: 'prepare', operation: 'session', state: 'start' });
  try {
    if (request.to !== undefined && (!Number.isInteger(request.to) || request.to <= 0 || request.to > 999999)) {
      throw Object.assign(new Error('target version must be an integer between 1 and 999999'), { kind: 'input' });
    }
    adapter = new Adapter({ ...request, onProgress: observer.emit });
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
  if (adapter) report.stage = adapter.stage;
  observer.emit({ stage: adapter?.stage ?? 'prepare', operation: 'session', state: 'complete', ok: report.ok });
  observer.finish(report);
  if (adapter) {
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
