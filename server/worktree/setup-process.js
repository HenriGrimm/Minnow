import { runProcess } from '../process-runner.js';
import { killProcessTree, killProcessTreeAndWait } from '../terminal-runner.js';

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
