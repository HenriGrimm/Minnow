import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../process-runner.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import { invalidateRegisteredWorktreeCache } from '../worktree/allowlist.js';
import { withWorktreeMutation } from './action-run-lock.js';

const PATCH_LIMIT = 512 * 1024;
const git = (cwd, args) => runProcess('git', args, { cwd, timeout: 120_000 });
const failure = (r) => (r.stderr || r.stdout || `Git exited with code ${r.code}`).trim();
async function read(cwd, args) {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error(failure(result));
  return result.stdout;
}
const same = (a, b) => normalizeWorkspacePathKey(a) === normalizeWorkspacePathKey(b);

async function context(input) {
  if (typeof input.cwd !== 'string' || !input.cwd.trim()) throw new Error('Issue workspace is required');
  const cwd = await fs.realpath(input.cwd);
  const source = await fs.realpath(input.worktreePath || cwd);
  await validateAllowedWorkspaceRoot(cwd);
  await validateAllowedWorkspaceRoot(source);
  for (const root of [cwd, source]) {
    const top = (await read(root, ['rev-parse', '--show-toplevel'])).trim();
    if (!same(root, await fs.realpath(top))) throw new Error('Use the root of the workspace or worktree');
  }
  const common = async (root) => fs.realpath((await read(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if (!same(await common(cwd), await common(source))) throw new Error('The worktree belongs to a different repository');
  const registered = (await read(cwd, ['worktree', 'list', '--porcelain', '-z'])).split('\0')
    .filter((v) => v.startsWith('worktree ')).map((v) => v.slice(9));
  if (!registered.some((root) => same(root, source))) throw new Error('The issue worktree is no longer registered');
  const sourceRef = await git(source, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const targetRef = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const sourceBranch = sourceRef.stdout.trim() || 'HEAD';
  const targetBranch = targetRef.stdout.trim() || 'HEAD';
  const sourceHead = (await read(source, ['rev-parse', 'HEAD'])).trim();
  const targetHead = (await read(cwd, ['rev-parse', 'HEAD'])).trim();
  return { cwd, source, sourceBranch, targetBranch, sourceHead, targetHead, isolated: !same(cwd, source) };
}

async function idle(cwd) {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']) {
    const file = (await read(cwd, ['rev-parse', '--git-path', name])).trim();
    try { await fs.access(path.resolve(cwd, file)); } catch { continue; }
    throw new Error('Finish or abort the existing merge, rebase, or cherry-pick first');
  }
}

async function snapshot(cwd) {
  const status = await read(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const patch = await read(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']);
  const staged = await read(cwd, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--']);
  const untracked = (await read(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const hash = createHash('sha256').update(status).update(patch).update(staged);
  for (const file of untracked) {
    const absolute = path.join(cwd, file);
    const stat = await fs.lstat(absolute);
    hash.update(file).update(stat.isSymbolicLink() ? await fs.readlink(absolute) : await read(cwd, ['hash-object', '--', file]));
  }
  return { dirty: Boolean(status), fingerprint: hash.digest('hex'), untracked };
}

async function preflight(ctx) {
  const result = await git(ctx.cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', ctx.targetHead, ctx.sourceHead]);
  if (result.code !== 0 && result.code !== 1) throw new Error(failure(result));
  return { conflict: result.code === 1, conflictedFiles: result.code === 1 ? result.stdout.trim().split('\n').slice(1).filter(Boolean) : [] };
}

/** Review the branch and working files together, without changing either checkout. */
export async function issueWorkInspect(input) {
  try {
    const ctx = await context(input);
    if (ctx.isolated && input.comparisonBranch) {
      if (typeof input.comparisonBranch !== 'string' || input.comparisonBranch.length > 512) throw new Error('Invalid comparison branch');
      await read(ctx.cwd, ['check-ref-format', `refs/heads/${input.comparisonBranch}`]);
      ctx.targetHead = (await read(ctx.cwd, ['rev-parse', '--verify', `refs/heads/${input.comparisonBranch}^{commit}`])).trim();
      ctx.targetBranch = input.comparisonBranch;
    }
    const state = await snapshot(ctx.source);
    const base = ctx.isolated ? (await read(ctx.cwd, ['merge-base', ctx.targetHead, ctx.sourceHead])).trim() : ctx.sourceHead;
    const changed = (await read(ctx.source, ['diff', '--name-only', '-z', base, '--'])).split('\0').filter(Boolean);
    let patch = await read(ctx.source, ['diff', '--no-ext-diff', '--no-textconv', base, '--']);
    let truncated = patch.length > PATCH_LIMIT;
    for (const file of state.untracked) {
      if (patch.length >= PATCH_LIMIT) { truncated = true; break; }
      const added = await git(ctx.source, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file]);
      if (added.code !== 0 && added.code !== 1) throw new Error(failure(added));
      patch += added.stdout;
      if (patch.length > PATCH_LIMIT) truncated = true;
    }
    const ahead = ctx.isolated ? Number((await read(ctx.source, ['rev-list', '--count', `${ctx.targetHead}..${ctx.sourceHead}`])).trim()) : 0;
    const merge = ctx.isolated && !state.dirty ? await preflight(ctx) : { conflict: false, conflictedFiles: [] };
    return { ok: true, ...ctx, ...state, ...merge, ahead, files: [...new Set([...changed, ...state.untracked])], patch: patch.slice(0, PATCH_LIMIT), truncated };
  } catch (error) { return { ok: false, error: error.message }; }
}

async function assertReviewed(input, ctx) {
  if (!input.sourceHead || !input.targetHead || !input.fingerprint) throw new Error('Refresh and review the work before continuing');
  const state = await snapshot(ctx.source);
  if (ctx.sourceHead !== input.sourceHead || ctx.targetHead !== input.targetHead || state.fingerprint !== input.fingerprint)
    throw new Error('The work or destination changed. Refresh and review it again');
  if (input.targetBranch !== ctx.targetBranch || input.sourceBranch !== ctx.sourceBranch)
    throw new Error('The checked-out branch changed. Refresh and review it again');
  return state;
}

async function commitSource(input, ctx, state) {
  if (!state.dirty) return ctx.sourceHead;
  if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('A commit message is required');
  await read(ctx.source, ['add', '--all', '--', '.']);
  await read(ctx.source, ['commit', '-m', input.message.trim()]);
  return (await read(ctx.source, ['rev-parse', 'HEAD'])).trim();
}

/** Commit the exact checkout snapshot the user reviewed. */
export async function issueWorkCommit(input) {
  try {
    const ctx = await context(input);
    if (ctx.sourceBranch === 'HEAD') throw new Error('Check out a branch before committing issue work');
    return await withWorktreeMutation(ctx.source, async () => {
      await idle(ctx.source);
      const state = await assertReviewed(input, await context(input));
      const sha = await commitSource(input, ctx, state);
      return { ok: true, sha, committed: state.dirty };
    });
  } catch (error) { return { ok: false, error: error.message }; }
}

async function cleanup(ctx, sha) {
  await idle(ctx.source);
  const branch = (await read(ctx.source, ['symbolic-ref', '--short', 'HEAD'])).trim();
  if (branch !== ctx.sourceBranch) throw new Error('The worktree branch changed; it was kept');
  if (!(await snapshot(ctx.source)).dirty) {
    const sourceHead = (await read(ctx.source, ['rev-parse', 'HEAD'])).trim();
    if (sourceHead !== sha) throw new Error('The worktree has new commits; it was kept');
    const merged = await git(ctx.cwd, ['merge-base', '--is-ancestor', sourceHead, 'HEAD']);
    if (merged.code !== 0) throw new Error('The worktree has unmerged commits; it was kept');
    await read(ctx.cwd, ['worktree', 'remove', ctx.source]);
    invalidateRegisteredWorktreeCache();
    const result = await git(ctx.cwd, ['branch', '-d', '--', ctx.sourceBranch]);
    return { worktreeRemoved: true, branchRemoved: result.code === 0, cleanupError: result.code ? failure(result) : undefined };
  }
  throw new Error('The worktree has uncommitted changes; it was kept');
}

/** Merge only into the reviewed destination, retaining all work after a conflict. */
export async function issueWorkMerge(input) {
  let committedSha;
  try {
    const initial = await context(input);
    if (initial.sourceBranch === 'HEAD' || initial.targetBranch === 'HEAD') throw new Error('Check out named source and destination branches before merging');
    if (!initial.isolated) throw new Error('Local workspace changes can be committed here; merging requires an isolated worktree');
    return await withWorktreeMutation(initial.cwd, () => withWorktreeMutation(initial.source, async () => {
      const ctx = await context(input);
      await idle(ctx.cwd);
      await idle(ctx.source);
      if ((await snapshot(ctx.cwd)).dirty) throw new Error('Commit or stash destination workspace changes before merging');
      const state = await assertReviewed(input, ctx);
      ctx.sourceHead = committedSha = await commitSource(input, ctx, state);
      if ((await snapshot(ctx.source)).dirty) throw new Error('The worktree changed during commit. Review the new changes before merging');
      const check = await preflight(ctx);
      if (check.conflict) return { ok: false, ...check, sha: committedSha, error: 'Merge conflict. The committed work and worktree are preserved. Resolve with the agent and retry' };
      const destinationHead = (await read(ctx.cwd, ['rev-parse', 'HEAD'])).trim();
      const destinationBranch = (await read(ctx.cwd, ['symbolic-ref', '--short', 'HEAD'])).trim();
      if (destinationHead !== ctx.targetHead || destinationBranch !== ctx.targetBranch || (await snapshot(ctx.cwd)).dirty)
        throw new Error('The destination changed. Refresh and review it again');
      const result = await git(ctx.cwd, ['merge', '--no-edit', '--', ctx.sourceHead]);
      if (result.code !== 0) return { ok: false, sha: committedSha, error: failure(result), conflict: true };
      const resultBase = { ok: true, merged: true, sha: committedSha, mergeSha: (await read(ctx.cwd, ['rev-parse', 'HEAD'])).trim(), sourceBranch: ctx.sourceBranch, targetBranch: ctx.targetBranch, worktreePath: ctx.source };
      if (input.cleanup !== true) return { ...resultBase, worktreeRemoved: false, branchRemoved: false };
      try { return { ...resultBase, ...await cleanup(ctx, committedSha) }; }
      catch (error) { return { ...resultBase, worktreeRemoved: false, branchRemoved: false, cleanupError: error.message }; }
    }));
  } catch (error) { return { ok: false, error: error.message, ...(committedSha ? { sha: committedSha } : {}) }; }
}

/** Cleanup retries verify reachability and refuse to remove dirty or changed work. */
export async function issueWorkCleanup(input) {
  try {
    if (!/^[a-f0-9]{40,64}$/i.test(input.sha || '')) throw new Error('A successfully merged commit is required');
    let exists = true;
    try { await fs.access(input.worktreePath || input.cwd); } catch { exists = false; }
    if (!exists && typeof input.sourceBranch === 'string' && input.sourceBranch.trim()) {
      const ctx = await context({ cwd: input.cwd });
      return await withWorktreeMutation(ctx.cwd, async () => {
        const ref = `refs/heads/${input.sourceBranch}`;
        const exists = await git(ctx.cwd, ['show-ref', '--verify', '--quiet', ref]);
        if (exists.code === 1) return { ok: true, worktreeRemoved: true, branchRemoved: true };
        if (exists.code !== 0) throw new Error(failure(exists));
        const tip = await git(ctx.cwd, ['show-ref', '--verify', '--hash', ref]);
        if (tip.code !== 0 || tip.stdout.trim() !== input.sha) throw new Error('The branch changed; it was kept');
        if ((await git(ctx.cwd, ['merge-base', '--is-ancestor', input.sha, 'HEAD'])).code !== 0) throw new Error('The branch is not merged into the destination');
        await read(ctx.cwd, ['branch', '-d', '--', input.sourceBranch]);
        return { ok: true, worktreeRemoved: true, branchRemoved: true };
      });
    }
    const ctx = await context(input);
    if (!ctx.isolated || !/^[a-f0-9]{40,64}$/i.test(input.sha || '')) throw new Error('An isolated, successfully merged worktree is required');
    if (ctx.sourceBranch !== input.sourceBranch) throw new Error('The worktree branch changed; it was kept');
    return await withWorktreeMutation(ctx.cwd, () => withWorktreeMutation(ctx.source, async () => {
      await idle(ctx.source);
      return { ok: true, ...await cleanup(ctx, input.sha) };
    }));
  } catch (error) { return { ok: false, error: error.message }; }
}
