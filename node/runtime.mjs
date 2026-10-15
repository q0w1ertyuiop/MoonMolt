import * as core from '../dist/engine.mjs';
import { captureRequest, inputFailure } from './request.mjs';
import { progressObserver } from './progress.mjs';
import { captureSignal } from './control.mjs';
import { queueSession } from './session.mjs';
export { runInWorker } from './worker.mjs';

export function run(request, options = {}) {
  let captured, observer, signal;
  try {
    captured = captureRequest(request);
    observer = progressObserver(options);
    signal = captureSignal(options);
  } catch (error) {
    return Promise.resolve(inputFailure(error));
  }
  return queueSession(captured, observer, () => signal?.aborted ?? false);
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
