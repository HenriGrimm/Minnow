import { runProcess } from '../process-runner.js';
import { killProcessTree, killProcessTreeAndWait } from '../terminal-runner.js';

/** Bound expensive background setup without holding a slot for cancelled waiters. */
export function createWorktreeSetupQueue(limit) {
  const waiting = [];
  let running = 0;
  function drain() {
    while (running < limit && waiting.length) {
      const start = waiting.shift();
      running++;
      start();
    }
  }
  return (run, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const cancel = () => {
      const index = waiting.indexOf(start);
      if (index !== -1) waiting.splice(index, 1);
      reject(signal.reason);
    };
    const start = () => {
      signal?.removeEventListener('abort', cancel);
      void Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return run();
      }).then(resolve, reject).finally(() => {
        running--;
        drain();
      });
    };
    waiting.push(start);
    signal?.addEventListener('abort', cancel, { once: true });
    drain();
  });
}

/** Opt-in setup cancellation waits for owned processes before returning control. */
export async function runWorktreeSetupProcess(command, args, options = {}) {
  if (!options.signal) return runProcess(command, args, options);
  let child;
  try {
    return await runProcess(command, args, { ...options, killTree: options.killTree ?? killProcessTree,
      onSpawn(value) { child = value; options.onSpawn?.(value); } });
  } catch (error) {
    if (child && child.exitCode == null && child.signalCode == null) {
      await killProcessTreeAndWait(child);
      if (child.exitCode == null && child.signalCode == null) {
        const failed = new Error('Workspace setup process has not confirmed shutdown; retain the checkout for recovery');
        failed.code = 'recovery_required';
        throw failed;
      }
    }
    throw error;
  }
}
