import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
const owners = new Map();
const mutationScope = new AsyncLocalStorage();
const queues = new Map();
const key = (cwd) => {
  let root = path.resolve(cwd);
  try {
    root = realpathSync(root);
  } catch {
    /* Removed worktrees still need to release their lock. */
  }
  // Subdirectory chats share the checkout's index; linked worktrees have their
  // own .git file and keep an independent lock.
  for (let parent = root; ; parent = path.dirname(parent)) {
    if (existsSync(path.join(parent, '.git'))) { root = parent; break; }
    if (path.dirname(parent) === parent) break;
  }
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
export const canonicalWorktreeMutationKey = key;
export function acquireActionWorktree(cwd, id) {
  assertActionWorktreeIdle(cwd);
  owners.set(key(cwd), id);
}
export function releaseActionWorktree(cwd, id) {
  if (owners.get(key(cwd)) === id) owners.delete(key(cwd));
}
export function assertActionWorktreeIdle(cwd) {
  if (owners.has(key(cwd)) && owners.get(key(cwd)) !== mutationScope.getStore()?.id)
    throw new Error(
      'A local action is running in this worktree. Stop it before changing branches or removing the worktree.',
    );
}
export async function withWorktreeMutation(cwd, operation) {
  if (owners.get(key(cwd)) === mutationScope.getStore()?.id && mutationScope.getStore()) return operation();
  const id = `git-${randomUUID()}`;
  acquireActionWorktree(cwd, id);
  try {
    return await operation();
  } finally {
    releaseActionWorktree(cwd, id);
  }
}

/** Serialize checkpoint/effect boundaries, not entire turns or causal waits.
 * The same async owner can call guarded Git helpers without relocking itself.
 * Existing actions outside this queue still refuse an occupied checkout.
 */
export async function withCoordinatedWorktreeMutation(cwd, operation, { signal } = {}) {
  const canonical = key(cwd);
  const parent = mutationScope.getStore();
  if (parent && owners.get(canonical) === parent.id) return operation();
  const previous = queues.get(canonical) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  queues.set(canonical, tail);
  let abort;
  try {
    signal?.throwIfAborted();
    await (signal ? Promise.race([previous.catch(() => {}), new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('Stopped', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
    })]) : previous.catch(() => {}));
    signal?.throwIfAborted();
    // Replaced symlinks/directories cannot move a queued operation to another lock.
    if (key(cwd) !== canonical) throw new Error('Checkout identity changed while waiting for its mutation boundary');
    const id = `checkpoint-${randomUUID()}`;
    acquireActionWorktree(cwd, id);
    try { return await mutationScope.run({ id }, operation); }
    finally { if (owners.get(canonical) === id) owners.delete(canonical); }
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    release();
    if (queues.get(canonical) === tail) void tail.then(() => { if (queues.get(canonical) === tail) queues.delete(canonical); });
  }
}
