import path from 'node:path';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const owners = new Map();
const key = (cwd) => {
  let root = path.resolve(cwd);
  try {
    root = realpathSync(root);
  } catch {
    /* Removed worktrees still need to release their lock. */
  }
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
export function acquireActionWorktree(cwd, id) {
  assertActionWorktreeIdle(cwd);
  owners.set(key(cwd), id);
}
export function releaseActionWorktree(cwd, id) {
  if (owners.get(key(cwd)) === id) owners.delete(key(cwd));
}
export function assertActionWorktreeIdle(cwd) {
  if (owners.has(key(cwd)))
    throw new Error(
      'A local action is running in this worktree. Stop it before changing branches or removing the worktree.',
    );
}
export async function withWorktreeMutation(cwd, operation) {
  const id = `git-${randomUUID()}`;
  acquireActionWorktree(cwd, id);
  try {
    return await operation();
  } finally {
    releaseActionWorktree(cwd, id);
  }
}
