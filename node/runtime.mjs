import * as core from '../dist/engine.mjs';
import { Adapter } from './adapter.mjs';

// The generated module calls a host function. Serialize sessions so two callers
// cannot replace one another's connection context during asynchronous backup.
let tail = Promise.resolve();
export function run(request) {
  const work = tail.then(() => execute(request));
  tail = work.catch(() => {});
  return work;
}

async function execute(input) {
  let adapter;
  let report;
  const request = { command: 'status', db: '', dir: 'migrations', rebuild: false, create: false, to: null, ...input };
  if (request.to == null) delete request.to;
  try {
    adapter = new Adapter();
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
      report.backup = adapter.backupPath;
      try { report.report_path = adapter.saveReport(report); }
      catch (error) { report.report_warning = error.message; }
    }
  }
  return report;
}

/** Pure MoonBit schema planning. Generated SQL is a draft to review and version. */
export function plan({ before, after, hints = { tables: [], columns: [] }, allow_destructive = false }) {
  return JSON.parse(core.plan_json(JSON.stringify({ before, after, hints, allow_destructive })));
}
