import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runProcess } from '../process-runner.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { actionWorktreeOwner, assertActionWorktreeIdle, withWorktreeMutation } from './action-run-lock.js';
import { checkoutForgePullRequest, requireForge } from './forge-ops.js';
import { readGitOperation } from './git-ops.js';
import { slugifyGitRefName } from '../../src/lib/git-branch-slug.mjs';

const PREFIX = '[minnow-checkout:';
const git = (cwd, args) => runProcess('git', args, { cwd, timeout: 120_000 });
const error = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() || `Git exited with code ${r.code}`;
const pathKey = (p) => {
  const resolved = path.resolve(String(p ?? '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * Stable failure codes so clients offer recovery instead of matching English
 * Git output. `worktreePath` accompanies `in_worktree`.
 * @param {string} text
 * @returns {{ code?: string, worktreePath?: string }}
 */
export function classifyCheckoutFailure(text) {
  const value = String(text ?? '');
  const inUse = /(?:already (?:used by|checked out at) worktree at|is already checked out at)\s+'([^']+)'/i.exec(value);
  if (inUse) return { code: 'in_worktree', worktreePath: inUse[1] };
  if (/already used by worktree|is already checked out at/i.test(value)) return { code: 'in_worktree' };
  if (/would be overwritten by checkout|Please commit your changes or stash them/i.test(value)) return { code: 'overwrite' };
  if (/index\.lock|Unable to create '.*\.lock'/i.test(value)) return { code: 'lock_file' };
  if (/did not match any file\(s\) known to git|invalid reference|not a valid (?:object name|ref)|unknown revision/i.test(value)) {
    return { code: 'missing_ref' };
  }
  return {};
}

/** Linked worktrees from porcelain output: path, HEAD sha and short branch. */
async function listWorktreeEntries(cwd) {
  const listed = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) return [];
  const entries = [];
  let current = null;
  for (const raw of listed.stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: '', branch: '' };
      entries.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

/** Local branches whose upstream is this pull request (`gh pr checkout` on forks). */
async function branchesTrackingPull(cwd, number) {
  const config = await git(cwd, ['config', '--get-regexp', '^branch\\..*\\.merge$']);
  if (config.code !== 0) return new Set();
  const names = new Set();
  for (const line of config.stdout.split('\n')) {
    const match = /^branch\.(.+)\.merge\s+(\S+)$/.exec(line.trim());
    if (match && match[2] === `refs/pull/${number}/head`) names.add(match[1]);
  }
  return names;
}

/**
 * Another worktree that already has the branch or pull request checked out.
 * Git refuses a second checkout of one branch; callers route there instead.
 */
async function findOwningWorktree(ctx, { branch, pullRequest }) {
  const entries = await listWorktreeEntries(ctx.cwd);
  const here = pathKey(ctx.cwd);
  // A fork PR's head name (often `main`) says nothing about local branches;
  // only its tracking ref or head commit identify it.
  const byName = !pullRequest?.crossRepository;
  const names = new Set(branch && byName ? [branch] : []);
  if (pullRequest) {
    if (pullRequest.headRef && byName) names.add(String(pullRequest.headRef));
    for (const name of await branchesTrackingPull(ctx.cwd, pullRequest.number)) names.add(name);
  }
  const oid = typeof pullRequest?.headRefOid === 'string' && /^[a-f\d]{40}$/i.test(pullRequest.headRefOid)
    ? pullRequest.headRefOid.toLowerCase() : '';
  for (const entry of entries) {
    if (pathKey(entry.path) === here) continue;
    if (entry.branch && names.has(entry.branch)) return { worktreePath: path.normalize(entry.path), worktreeBranch: entry.branch };
    if (oid && entry.head.toLowerCase() === oid) return { worktreePath: path.normalize(entry.path), worktreeBranch: entry.branch || undefined };
  }
  return null;
}

async function busyState(cwd) {
  try {
    assertActionWorktreeIdle(cwd);
    return null;
  } catch (err) {
    const owner = actionWorktreeOwner(cwd);
    const runId = typeof owner === 'string' && owner.startsWith('local-') ? owner : undefined;
    // Loaded only when busy: the action module pulls in the terminal stack.
    const label = runId ? (await import('./local-action-ops.js')).activeLocalRunLabel(runId) : undefined;
    return {
      error: err instanceof Error ? err.message : String(err),
      ...(runId ? { runId } : {}),
      ...(label ? { label: String(label) } : {}),
    };
  }
}

async function context(cwd) {
  const resolved = cwd?.trim() || getEffectiveWorkspaceRoot();
  const root = await git(resolved, ['rev-parse', '--show-toplevel']);
  if (root.code !== 0) throw new Error(error(root));
  const real = await fs.realpath(root.stdout.trim());
  const worktree = process.platform === 'win32' ? real.toLowerCase() : real;
  return { cwd: path.resolve(real), worktree };
}

async function currentBranch(cwd) {
  const head = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return head.code === 0 ? head.stdout.trim() : 'HEAD';
}

async function inspect(cwd) {
  const branch = await currentBranch(cwd);
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
  return { branch, fileCount: paths.size };
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

async function pendingOperation(cwd) {
  const operation = await readGitOperation(cwd);
  if (!operation) return null;
  const label = operation === 'sequencer' ? 'operation' : operation;
  return { ok: false, code: 'operation_in_progress', error: `Finish or abort the current Git ${label} first.` };
}

export async function checkoutSavedChanges({ cwd } = {}) {
  const ctx = await context(cwd);
  return { ok: true, savedChanges: await savedEntries(ctx.cwd, ctx.worktree) };
}

/**
 * Read-only pre-flight: where the target lives and what switching would cost.
 * `location` is `current` (already here), `worktree` (checked out elsewhere)
 * or `here` (a switch in this checkout).
 */
export async function checkoutPlan({ cwd, branch, pullRequest } = {}) {
  const ctx = await context(cwd);
  const isPull = pullRequest !== undefined;
  if (isPull && (!Number.isSafeInteger(pullRequest?.number) || pullRequest.number <= 0)) {
    return { ok: false, error: 'A valid pull request is required' };
  }
  const target = typeof branch === 'string' ? branch.trim() : '';
  if (!isPull && (!target || target.startsWith('-'))) return { ok: false, error: 'A valid branch is required' };
  const state = await inspect(ctx.cwd);
  const busy = await busyState(ctx.cwd);
  const tracking = isPull ? await branchesTrackingPull(ctx.cwd, pullRequest.number) : new Set();
  const isCurrent = (!pullRequest?.crossRepository && target === state.branch) || tracking.has(state.branch);
  const owner = isCurrent ? null : await findOwningWorktree(ctx, { branch: target, pullRequest });
  return {
    ok: true,
    branch: state.branch,
    fileCount: state.fileCount,
    location: isCurrent ? 'current' : owner ? 'worktree' : 'here',
    ...(owner ?? {}),
    ...(busy ? { busy: true, busyReason: busy.error, ...(busy.runId ? { busyRunId: busy.runId } : {}), ...(busy.label ? { busyLabel: busy.label } : {}) } : {}),
  };
}

/** A dirty checkout always asks first unless the caller supplies an explicit choice. */
export async function checkoutSwitch({ cwd, branch, pullRequest, create, startPoint, dirtyHandling, expectedBranch } = {}) {
  const ctx = await context(cwd);
  const isPull = pullRequest !== undefined;
  if (isPull && (!Number.isSafeInteger(pullRequest?.number) || pullRequest.number <= 0 || typeof pullRequest.url !== 'string')) {
    return { ok: false, error: 'A valid pull request is required' };
  }
  if (!isPull && (typeof branch !== 'string' || !branch.trim() || branch.trim().startsWith('-'))) {
    return { ok: false, error: 'A valid branch is required' };
  }
  if (startPoint && (typeof startPoint !== 'string' || startPoint.trim().startsWith('-'))) {
    return { ok: false, error: 'Invalid start point' };
  }
  let gate;
  if (isPull) {
    gate = await requireForge(ctx.cwd);
    if (!gate.ok) return gate;
    const expectedUrl = `https://${gate.status.hostname}/${gate.status.repo}/pull/${pullRequest.number}`;
    if (pullRequest.url.toLowerCase() !== expectedUrl.toLowerCase()) {
      return { ok: false, error: 'The pull request is from a different repository. Reopen the checkout picker.' };
    }
  }
  const target = isPull ? '' : create ? slugifyGitRefName(branch, 'branch') : branch.trim();
  const busy = await busyState(ctx.cwd);
  if (busy) {
    return { ok: false, code: 'busy', error: busy.error, ...(busy.runId ? { busyRunId: busy.runId } : {}), ...(busy.label ? { busyLabel: busy.label } : {}) };
  }
  return withWorktreeMutation(ctx.cwd, async () => {
    const state = await inspect(ctx.cwd);
    if (expectedBranch && state.branch !== expectedBranch) {
      return { ok: false, code: 'stale_branch', branch: state.branch, error: 'The current branch changed. Choose the branch again.' };
    }
    if (!create && target === state.branch) return { ok: true, branch: target };
    if (!create) {
      // Git refuses a branch another worktree has checked out. Report where it
      // lives before anything is stashed or handed to gh.
      const owner = await findOwningWorktree(ctx, { branch: isPull ? String(branch ?? '').trim() : target, pullRequest });
      if (owner) {
        const label = isPull ? `PR #${pullRequest.number}` : target;
        return {
          ok: false, code: 'in_worktree', ...owner, branch: state.branch,
          error: `${label} is already checked out in another worktree at ${owner.worktreePath}.`,
        };
      }
    }
    const pending = await pendingOperation(ctx.cwd);
    if (pending) return pending;
    if (state.fileCount && !['bring', 'leave'].includes(dirtyHandling)) {
      return { ok: false, needsChoice: true, code: 'needs_choice', ...state };
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
    const result = gate
      ? await checkoutForgePullRequest(gate, pullRequest.number)
      : await git(ctx.cwd, args).then((r) => ({ ok: r.code === 0, error: r.code === 0 ? undefined : error(r) }));
    const checkedOutBranch = gate ? await currentBranch(ctx.cwd) : target;
    if (!result.ok) {
      if (gate && checkedOutBranch !== state.branch) {
        const stash = saved ? ` Your changes remain saved on ${state.branch}.` : '';
        return { ok: false, code: 'partial', branch: checkedOutBranch, error: `${result.error}\nGit switched to ${checkedOutBranch} before checkout finished.${stash}` };
      }
      const failure = classifyCheckoutFailure(result.error);
      if (saved) {
        const rollback = await git(ctx.cwd, ['stash', 'apply', '--index', saved.sha]);
        if (rollback.code === 0) {
          await dropSaved(ctx, saved.sha);
        } else {
          return { ok: false, ...failure, error: `${result.error}\nYour changes remain saved in Git stash (${saved.sha}). Restoring them also failed: ${error(rollback)}` };
        }
      }
      return { ok: false, ...failure, error: result.error };
    }
    return { ok: true, branch: checkedOutBranch };
  });
}

export async function checkoutRestoreChanges({ cwd, sha, expectedBranch } = {}) {
  const ctx = await context(cwd);
  return withWorktreeMutation(ctx.cwd, async () => {
    const state = await inspect(ctx.cwd);
    if (state.branch !== expectedBranch) return { ok: false, error: 'The current branch changed. Return to the saved branch before restoring.' };
    const pending = await pendingOperation(ctx.cwd);
    if (pending) return pending;
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
