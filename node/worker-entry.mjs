import { parentPort, workerData } from 'node:worker_threads';
import { run } from './runtime.mjs';

parentPort.postMessage({ type: 'started' });
const report = await run(workerData, {
  onProgress: event => { parentPort.postMessage({ type: 'progress', event }); },
});
parentPort.postMessage({ type: 'result', report });
parentPort.close();
