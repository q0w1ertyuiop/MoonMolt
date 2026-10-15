import { Worker } from 'node:worker_threads';
import { captureRequest, inputFailure } from './request.mjs';
import { progressObserver } from './progress.mjs';
import { captureSignal, cancelledReport } from './control.mjs';

/** Own one isolated engine session without blocking the caller's event loop. */
export function runInWorker(input, options = {}) {
  let request, observer, signal;
  try { request = captureRequest(input); observer = progressObserver(options); signal = captureSignal(options); }
  catch (error) { return Promise.resolve(inputFailure(error)); }
  if (signal?.aborted) return Promise.resolve(cancelledReport('cancelled before starting worker'));
  return new Promise(resolve => {
    let worker, result, fault, backupPath, backupComplete = false, started = false;
    const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const flag = new Int32Array(cancellation);
    const abort = () => { Atomics.store(flag, 0, 1); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      // Eval/stdin callers' --input-type applies to their input, not this file.
      let hasInputType = false;
      const execArgv = [];
      for (let i = 0; i < process.execArgv.length; i++) {
        const arg = process.execArgv[i];
        if (arg === '--input-type') { hasInputType = true; i++; continue; }
        if (arg.startsWith('--input-type=')) { hasInputType = true; continue; }
        execArgv.push(arg);
      }
      worker = new Worker(new URL('./worker-entry.mjs', import.meta.url), { workerData: { request, cancellation }, ...(hasInputType ? { execArgv } : {}) });
    } catch (error) { signal?.removeEventListener('abort', abort); resolve(inputFailure(error)); return; }
    worker.on('message', message => {
      if (message.type === 'started') started = true;
      else if (message.type === 'progress') {
        const event = message.event;
        if (event.operation === 'backup' && event.backup) {
          backupPath = event.backup;
          if (event.state === 'complete') backupComplete = true;
        }
        observer.emit(event);
      }
      else if (message.type === 'result') result = message.report;
    });
    worker.on('error', error => { fault = error; });
    worker.on('messageerror', error => { fault = error; });
    // Resolve after exit, so fixtures and callers may safely release resources.
    worker.on('exit', code => {
      signal?.removeEventListener('abort', abort);
      if (result) { resolve(observer.finish(result)); return; }
      const uncertain = started && request.command === 'apply';
      resolve(observer.finish({ ok: false, kind: uncertain ? 'commit_outcome_unknown' : 'runtime', exit_code: 1,
        message: uncertain ? `worker stopped without a final report; inspect history before retrying (${fault?.message ?? code})` : `worker failed: ${fault?.message ?? `exit ${code} without a report`}`,
        ...(request.command === 'apply' && backupPath ? { [backupComplete ? 'backup' : 'incomplete_backup']: backupPath } : {}),
      }));
    });
  });
}
