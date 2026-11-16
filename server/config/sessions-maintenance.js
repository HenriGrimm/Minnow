import { Worker } from 'node:worker_threads';
import { getMinnowHome } from './home.js';

/** Run an integrity operation without blocking the desktop or HTTP host. */
export function runSessionsMaintenance(operation, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sessions-maintenance-worker.js', import.meta.url), {
      workerData: { operation, ...options },
      execArgv: [],
      env: { ...process.env, MINNOW_HOME: getMinnowHome() },
    });
    worker.once('message', (result) => {
      if (result.ok) resolve(result.value);
      else reject(Object.assign(new Error(result.message), { code: result.code }));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`Session maintenance exited without a result (${code})`)));
  });
}
