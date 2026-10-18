import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { getChatWorktreePath, getRepoWorktreesDir } from './paths.js';
import { invalidateRegisteredWorktreeCache } from './allowlist.js';

const queues = new Map();
const output = result => `${result.stderr || ''}\n${result.stdout || ''}`.trim();
const git = (cwd, args) => runProcess('git', args, { cwd, timeout: 120_000 });

/** Serialize approvals per repository, including approvals from other windows. */
export async function mergeChatWorktree(input) {
  const root = getEffectiveWorkspaceRoot();
  const common = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0) return { ok: false, error: output(common) };
  const key = common.stdout.trim();
  const previous = queues.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => merge(root, input));
  queues.set(key, pending);
  try { return await pending; }
  finally { if (queues.get(key) === pending) queues.delete(key); }
}

async function merge(root, { chatId, branch, targetBranch = 'main' }) {
  if (typeof chatId !== 'string' || !chatId.trim() || typeof branch !== 'string' || !branch.trim() || typeof targetBranch !== 'string') return { ok: false, error: 'A chat, branch, and target branch are required.' };
  if (branch === targetBranch) return { ok: false, error: 'The worktree branch must differ from its target.' };
  for (const ref of [branch, targetBranch]) {
    if ((await git(root, ['check-ref-format', '--branch', ref])).code !== 0 || ref.startsWith('-')) return { ok: false, error: 'Invalid branch name.' };
  }
  const worktree = getChatWorktreePath(chatId, root);
  const head = await git(worktree, ['symbolic-ref', '--short', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== branch) return { ok: false, error: 'The managed worktree no longer belongs to this branch. It has been kept.' };
  const dirty = await git(worktree, ['status', '--porcelain']);
  if (dirty.code !== 0 || dirty.stdout.trim()) return { ok: false, error: 'Commit the agent’s worktree changes before approving. The worktree has been kept.' };
  const target = await git(root, ['rev-parse', '--verify', `refs/heads/${targetBranch}`]);
  const source = await git(worktree, ['rev-parse', 'HEAD']);
  if (target.code !== 0 || source.code !== 0) return { ok: false, error: 'The source or target branch is unavailable.' };
  const baseSha = target.stdout.trim(), sourceSha = source.stdout.trim();
  const dir = getRepoWorktreesDir(root);
  await fs.mkdir(dir, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(dir, 'merge-check-'));
  try {
    const added = await git(root, ['worktree', 'add', '--detach', scratch, baseSha]);
    if (added.code !== 0) return { ok: false, error: output(added) };
    const checked = await git(scratch, ['merge', '--no-ff', '--no-edit', sourceSha]);
    if (checked.code !== 0) {
      await git(scratch, ['merge', '--abort']);
      return { ok: false, conflict: true, error: `Merge stopped before updating ${targetBranch}. Ask the agent to rebase and resolve the conflict. ${output(checked)}` };
    }
    const merged = await git(scratch, ['rev-parse', 'HEAD']);
    const sha = merged.stdout.trim();
    const current = await git(root, ['rev-parse', `refs/heads/${targetBranch}`]);
    if (current.stdout.trim() !== baseSha) return { ok: false, error: `${targetBranch} changed during the merge check. Review and approve again.` };
    const trees = await git(root, ['worktree', 'list', '--porcelain']);
    const checkout = trees.stdout.split(/\r?\n\r?\n/).find(block => block.split(/\r?\n/).includes(`branch refs/heads/${targetBranch}`));
    const checkoutPath = checkout?.split(/\r?\n/).find(line => line.startsWith('worktree '))?.slice(9);
    // Git refuses overlapping dirty changes. No checkout, reset, stash, or conflict
    // resolution is performed on the user's checkout.
    const landed = checkoutPath
      ? await git(checkoutPath, ['merge', '--ff-only', '--no-edit', sha])
      : await git(root, ['update-ref', `refs/heads/${targetBranch}`, sha, baseSha]);
    if (landed.code !== 0) return { ok: false, error: `Could not update ${targetBranch}. Your checkout and agent worktree have been kept. ${output(landed)}` };
    const after = await git(worktree, ['status', '--porcelain']);
    const tip = await git(worktree, ['rev-parse', 'HEAD']);
    let removed = false;
    if (after.code === 0 && !after.stdout.trim() && tip.stdout.trim() === sourceSha) {
      removed = (await git(root, ['worktree', 'remove', worktree])).code === 0;
    }
    invalidateRegisteredWorktreeCache();
    return { ok: true, sha, removed, path: worktree };
  } finally {
    // Only the scratch checkout created above is disposable.
    await git(root, ['worktree', 'remove', '--force', scratch]);
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
