#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { run, runInWorker, plan } from './runtime.mjs';

const help = `MoonMolt · 月蜕 — 结构焕新，数据如初

moonmolt inspect --db app.db [--format json]
moonmolt status --db app.db --dir migrations [--to 3]
moonmolt rehearse --db app.db --dir migrations [--rebuild]
moonmolt apply --db app.db --dir migrations [--to 3] [--rebuild] [--create]
              [--backup-dir backups] [--busy-timeout-ms 5000] [--worker] [--progress]
moonmolt plan --before v1.json --after v2.json [--hints renames.json]
              [--allow-destructive] [--out upgrade.sql] [--format json]

Node.js >=24.10.0. No down migrations. Apply always rehearses first.
Exit codes: 0 success, 1 input/database/runtime, 2 history/policy, 3 lock timeout.
`;

function parse(argv) {
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') return { help: true };
  const command = argv.shift();
  if (!['inspect', 'status', 'rehearse', 'apply', 'plan'].includes(command)) throw new Error(`unknown command: ${command}`);
  const result = { command, format: 'text' };
  const bools = new Set(['--rebuild', '--create', '--allow-destructive', '--worker', '--progress']);
  const values = new Set(['--db', '--dir', '--to', '--format', '--before', '--after', '--hints', '--out', '--backup-dir', '--busy-timeout-ms']);
  const seen = new Set();
  while (argv.length) {
    const option = argv.shift();
    if (seen.has(option)) throw new Error(`duplicate option: ${option}`);
    seen.add(option);
    if (bools.has(option)) result[option.slice(2).replaceAll('-', '_')] = true;
    else if (values.has(option)) {
      if (!argv.length || argv[0].startsWith('--')) throw new Error(`missing value: ${option}`);
      result[option.slice(2).replaceAll('-', '_')] = argv.shift();
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!['text', 'json'].includes(result.format)) throw new Error('--format must be text or json');
  const allowed = command === 'plan' ? new Set(['command', 'format', 'before', 'after', 'hints', 'out', 'allow_destructive']) : command === 'inspect' ? new Set(['command', 'format', 'db', 'busy_timeout_ms']) : new Set(['command', 'format', 'db', 'dir', 'to', 'rebuild', 'create', 'busy_timeout_ms', ...(command === 'apply' ? ['backup_dir'] : [])]);
  if (command !== 'plan') { allowed.add('worker'); allowed.add('progress'); }
  for (const key of Object.keys(result)) if (!allowed.has(key)) throw new Error(`${key} does not apply to ${command}`);
  if (command === 'plan') { if (!result.before || !result.after) throw new Error('plan requires --before and --after'); }
  else {
    if (!result.db) throw new Error(`${command} requires --db`);
    if (command !== 'inspect' && !result.dir) throw new Error(`${command} requires --dir`);
    if (result.create && command !== 'apply') throw new Error('--create only applies to apply');
    if (result.busy_timeout_ms !== undefined) {
      if (!/^\d+$/.test(result.busy_timeout_ms)) throw new Error('--busy-timeout-ms must be a nonnegative integer');
      result.busy_timeout_ms = Number(result.busy_timeout_ms);
    }
    if (result.to !== undefined) {
      if (!/^[1-9]\d{0,5}$/.test(result.to)) throw new Error('--to must be a positive six-digit-or-smaller version');
      result.to = Number(result.to);
    }
  }
  return result;
}

function text(report) {
  if (!report.ok) return `MoonMolt: ${report.kind}: ${report.message}${report.backup ? '\nBackup: ' + report.backup : ''}`;
  if (report.snapshot) return JSON.stringify(report.snapshot, null, 2);
  if (report.sql !== undefined) return report.sql + (report.requires_rebuild ? '\nApply this draft with --rebuild after review.\n' : '');
  if (report.command === 'status') return `Applied: ${report.applied.length}\nPending: ${report.pending.join(', ') || 'none'}`;
  if (report.noop) return 'Database is up to date. No migration or backup created.';
  const applied = report.result?.applied ?? report.rehearsal?.applied ?? [];
  const checks = report.result?.checks ?? report.rehearsal?.checks ?? [];
  return `${report.command === 'rehearse' ? 'Rehearsed' : 'Applied'} ${applied.length} migration(s): ${applied.map(m => m.version).join(', ')}${checks.length ? '\nBusiness checks passed: ' + checks.length : ''}${report.backup ? '\nBackup: ' + report.backup : ''}`;
}

let report;
let format = process.argv.includes('json') ? 'json' : 'text';
try {
  const options = parse(process.argv.slice(2));
  if (options.help) { console.log(help); process.exit(0); }
  format = options.format;
  if (options.command === 'plan') {
    const read = path => JSON.parse(readFileSync(path, 'utf8'));
    report = plan({ before: read(options.before), after: read(options.after), hints: options.hints ? read(options.hints) : undefined, allow_destructive: options.allow_destructive });
    if (report.ok && options.out) writeFileSync(options.out, report.sql, { flag: 'wx' });
  } else {
    const onProgress = options.progress ? event => {
      console.error(format === 'json' ? JSON.stringify({ type: 'progress', ...event }) : `${event.stage}: ${event.operation} ${event.state}${event.filename ? ' ' + event.filename : ''}`);
    } : undefined;
    report = await (options.worker ? runInWorker : run)(options, { onProgress });
  }
} catch (error) { report = { ok: false, kind: 'input', exit_code: 1, message: error.message }; }
console[report.ok ? 'log' : 'error'](format === 'json' ? JSON.stringify(report) : text(report));
process.exitCode = report.ok ? 0 : report.exit_code ?? 1;
