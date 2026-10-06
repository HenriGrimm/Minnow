import { Worker } from 'node:worker_threads';

const active = new Map();

export async function stopPlugin(id) {
  await Promise.all([...active.values()].filter(job => job.id === id).map(job => job.stop('Plugin disabled, removed or reloaded')));
}

export function runPlugin(id, handler, args, context, timeoutMs, signal, parameters) {
  if (signal?.aborted) return Promise.reject(new Error('Plugin call cancelled'));
  if (active.size >= 16) return Promise.reject(new Error('Plugin concurrency limit reached; retry shortly'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { handler, args, context, timeoutMs, parameters },
      execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: true, stderr: true,
    });
    let settled = false;
    const finish = async (error, content) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await worker.terminate();
      active.delete(worker);
      if (error) reject(new Error(error)); else resolve(content);
    };
    const abort = () => void finish('Plugin call cancelled');
    const timer = setTimeout(() => void finish(`Plugin timed out after ${timeoutMs} ms`), timeoutMs);
    active.set(worker, { id, stop: message => finish(message) });
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on('message', message => void finish(message.error, message.content));
    worker.on('error', error => void finish(error.message));
    worker.on('exit', code => { if (!settled) void finish(`Plugin exited before returning a result (code ${code})`); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
