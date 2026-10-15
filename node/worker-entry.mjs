import { parentPort, workerData } from 'node:worker_threads';
import { queueSession } from './session.mjs';
import { captureRequest } from './request.mjs';
import { progressObserver } from './progress.mjs';

const request = captureRequest(workerData.request);
const flag = new Int32Array(workerData.cancellation);
parentPort.postMessage({ type: 'started' });
const observer = progressObserver({
  onProgress: event => { parentPort.postMessage({ type: 'progress', event }); },
});
const report = await queueSession(request, observer, () => Atomics.load(flag, 0) !== 0);
parentPort.postMessage({ type: 'result', report });
parentPort.close();
