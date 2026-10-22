import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runProcess } from '../process-runner.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { withWorktreeMutation } from './action-run-lock.js';
import { slugifyGitRefName } from '../../src/lib/git-branch-slug.mjs';

const PREFIX = '[minnow-checkout:';
const git = (cwd, args) => runProcess('git', args, { cwd, timeout: 120_000 });
const error = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() || `Git exited with code ${r.code}`;

async function context(cwd) {
  const resolved = cwd?.trim() || getEffectiveWorkspaceRoot();
  const root = await git(resolved, ['rev-parse', '--show-toplevel']);
  if (root.code !== 0) throw new Error(error(root));
  const real = await fs.realpath(root.stdout.trim());
  const worktree = process.platform === 'win32' ? real.toLowerCase() : real;
  return { cwd: path.resolve(real), worktree };
}

async function inspect(cwd) {
  const head = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const state = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (state.code !== 0) throw new Error(error(state));
  // Rename/copy records have a second NUL-delimited path. Count each file once.
  const records = state.stdout.split('\0');
  const paths = new Set();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    paths.add(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) i++;
  }
  return { branch: head.code === 0 ? head.stdout.trim() : 'HEAD', fileCount: paths.size };
}

async function savedEntries(cwd, worktree) {
  const list = await git(cwd, ['stash', 'list', '--format=%H%x00%gd%x00%gs']);
  if (list.code !== 0) throw new Error(error(list));
  return list.stdout.split('\n').flatMap((line) => {
    const [sha, ref, subject = ''] = line.split('\0');
    const offset = subject.indexOf(PREFIX);
    if (offset < 0) return [];
    try {
      const encoded = subject.slice(offset + PREFIX.length).replace(/\]$/, '');
      const metadata = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      if (metadata.worktree !== worktree || typeof metadata.branch !== 'string') return [];
      return [{ sha, ref, branch: metadata.branch, fileCount: metadata.fileCount, createdAt: metadata.createdAt, id: metadata.id }];
    } catch { return []; }
  });
}

async function dropSaved(ctx, sha) {
  // Stash indices move whenever another stash is added or removed. Resolve by SHA.
  const entry = (await savedEntries(ctx.cwd, ctx.worktree)).find((s) => s.sha === sha);
  if (!entry) return;
  const dropped = await git(ctx.cwd, ['stash', 'drop', entry.ref]);
  if (dropped.code !== 0) throw new Error(`Changes restored, but the saved stash could not be removed: ${error(dropped)}`);
}

export async function checkoutSavedChanges({ cwd } = {}) {
  const ctx = await context(cwd);
  return { ok: true, savedChanges: await savedEntries(ctx.cwd, ctx.worktree) };
}

/** A dirty checkout always asks first unless the caller supplies an explicit choice. */
export async function checkoutSwitch({ cwd, branch, create, startPoint, dirtyHandling, expectedBranch } = {}) {
  const ctx = await context(cwd);
  if (typeof branch !== 'string' || !branch.trim() || branch.trim().startsWith('-')) {
    return { ok: false, error: 'A valid branch is required' };
  }
  if (startPoint && (typeof startPoint !== 'string' || startPoint.trim().startsWith('-'))) {
    return { ok: false, error: 'Invalid start point' };
  }
  const target = create ? slugifyGitRefName(branch, 'branch') : branch.trim();
  return withWorktreeMutation(ctx.cwd, async () => {
    const state = await inspect(ctx.cwd);
    if (expectedBranch && state.branch !== expectedBranch) {
      return { ok: false, error: 'The current branch changed. Choose the branch again.' };
    }
    if (!create && target === state.branch) return { ok: true, branch: target };
    if (state.fileCount && !['bring', 'leave'].includes(dirtyHandling)) {
      return { ok: false, needsChoice: true, ...state };
    }
    if (state.branch === 'HEAD' && state.fileCount && dirtyHandling === 'leave') {
      return { ok: false, error: 'Create a branch before leaving changes from a detached HEAD.' };
    }
    let saved;
    if (state.fileCount && dirtyHandling === 'leave') {
      const metadata = { ...state, worktree: ctx.worktree, createdAt: new Date().toISOString(), id: randomUUID() };
      const marker = `Minnow saved changes on ${state.branch} ${PREFIX}${Buffer.from(JSON.stringify(metadata)).toString('base64url')}]`;
      const result = await git(ctx.cwd, ['stash', 'push', '--include-untracked', '-m', marker]);
      if (result.code !== 0) return { ok: false, error: error(result) };
      saved = (await savedEntries(ctx.cwd, ctx.worktree)).find((s) => s.id === metadata.id);
      if (!saved) return { ok: false, error: 'Could not identify saved changes. Check Git stashes before switching.' };
      if ((await inspect(ctx.cwd)).fileCount) {
        return { ok: false, error: 'Some changes could not be saved. The branch was not switched; your saved stash is retained.' };
      }
    }
    const args = create ? ['checkout', '-b', target, ...(startPoint ? [startPoint] : [])] : ['checkout', target];
    const result = await git(ctx.cwd, args);
    if (result.code !== 0) {
      if (saved) {
        const rollback = await git(ctx.cwd, ['stash', 'apply', '--index', saved.sha]);
        if (rollback.code === 0) {
          await dropSaved(ctx, saved.sha);
        } else {
          return { ok: false, error: `${error(result)}\nYour changes remain saved in Git stash (${saved.sha}). Restoring them also failed: ${error(rollback)}` };
        }
      }
      return { ok: false, error: error(result) };
    }
    return { ok: true, branch: target };
  });
}

export async function checkoutRestoreChanges({ cwd, sha, expectedBranch } = {}) {
  const ctx = await context(cwd);
  return withWorktreeMutation(ctx.cwd, async () => {
    const state = await inspect(ctx.cwd);
    if (state.branch !== expectedBranch) return { ok: false, error: 'The current branch changed. Return to the saved branch before restoring.' };
    if (state.fileCount) return { ok: false, error: 'Commit or stash your current changes before restoring saved changes.' };
    const saved = (await savedEntries(ctx.cwd, ctx.worktree)).find((s) => s.sha === sha && s.branch === state.branch);
    if (!saved) return { ok: false, error: 'These saved changes are no longer available in this worktree.' };
    const applied = await git(ctx.cwd, ['stash', 'apply', '--index', saved.sha]);
    if (applied.code !== 0) {
      return { ok: false, conflict: true, error: `${error(applied)}\nThe saved stash is retained. Resolve any conflicts before continuing.` };
    }
    await dropSaved(ctx, saved.sha);
    return { ok: true };
  });
}
