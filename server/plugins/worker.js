import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { validateArguments } from './schema.js';

try {
  validateArguments(workerData.parameters, workerData.args);
  const mod = await import(pathToFileURL(workerData.handler).href);
  if (typeof mod.default !== 'function') throw new Error('Handler must export a default function');
  const ctx = Object.freeze({ ...workerData.context, signal: AbortSignal.timeout(workerData.timeoutMs) });
  const result = await mod.default(workerData.args, ctx);
  const content = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Plugin result exceeds 1 MiB');
  parentPort.postMessage({ content });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
