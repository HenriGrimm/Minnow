import path from 'node:path';
import { runProcess } from '../process-runner.js';

/** Stamp the checkout at mutation time, never infer it from a chat's later branch. */
export async function withCodeChangeCheckout(change, cwd) {
  if (!change || change.workspacePath) return change;
  const recorded = { ...change, workspacePath: path.resolve(cwd) };
  try {
    const result = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd, timeout: 5_000,
    });
    if (result.code === 0) {
      if (result.stdout.trim()) recorded.gitBranch = result.stdout.trim();
    } else {
      const head = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], { cwd, timeout: 5_000 });
      if (head.code === 0) recorded.gitBranch = 'HEAD';
    }
  } catch { /* Non-Git folders still retain their recorded workspace. */ }
  return recorded;
}
