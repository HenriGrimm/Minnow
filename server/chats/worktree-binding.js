import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runProcess } from '../process-runner.js';
import { getChatWorktreePath } from '../worktree/paths.js';
import { multiRepoSources, readMirrorManifest } from '../worktree/multi-repo.js';
import { ChatContractError } from './contracts.js';
import { checkoutKey as key, directory, readChatCheckoutIdentity } from './checkout-identity.js';

const denied = message => new ChatContractError('workspace_denied', message, { retryable: true });

async function git(args, cwd) {
  const result = await runProcess('git', args, { cwd, timeout: 10_000 });
  if (result.code !== 0 || result.accumulationTruncated) {
    throw denied('Cannot verify the worktree repository. Inspect it in Source Control before retrying.');
  }
  return result.stdout.trim();
}

export async function readGitBinding(cwd, { exactRoot = false, registered = false, rebasingBranch } = {}) {
  const canonical = await directory(cwd);
  const [locations, current, head] = await Promise.all([
    git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'], canonical),
    runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: canonical, timeout: 10_000 }),
    git(['rev-parse', '--verify', 'HEAD'], canonical),
  ]);
  const [top, common, gitDir] = locations.split(/\r?\n/);
  let branch = current.code === 0 && !current.accumulationTruncated ? current.stdout.trim() : '';
  if (!branch && current.code === 1 && rebasingBranch) {
    for (const state of ['rebase-merge', 'rebase-apply']) {
      const ref = await fs.readFile(path.join(gitDir, state, 'head-name'), 'utf8').catch(() => '');
      if (ref.trim() === `refs/heads/${rebasingBranch}`) { branch = rebasingBranch; break; }
    }
  }
  if (!branch) throw denied('Cannot verify the worktree branch. Inspect it in Source Control before retrying.');
  if (exactRoot && (key(canonical) !== key(cwd) || key(await directory(top)) !== key(canonical))) {
    throw denied('A repository checkout moved or points outside the workspace.');
  }
  if (registered) {
    const listed = await git(['worktree', 'list', '--porcelain', '-z'], canonical);
    if (!listed.split('\0').some(entry => entry.startsWith('worktree ') && key(entry.slice(9)) === key(canonical))) {
      throw denied('A repository checkout is no longer registered with Git.');
    }
  }
  const [checkoutIdentity, commonIdentity, gitIdentity] = await Promise.all([
    readChatCheckoutIdentity(canonical), readChatCheckoutIdentity(common), readChatCheckoutIdentity(gitDir),
  ]);
  return { path: canonical, checkoutIdentity, commonIdentity, gitIdentity, branch, head };
}

export async function readWorktreeSource(cwd, { mirror } = {}) {
  if (mirror === false) return readGitBinding(cwd);
  const canonical = await directory(cwd);
  const children = await multiRepoSources(canonical, { refresh: true });
  if (!children && mirror) throw denied('The source workspace repositories changed before setup.');
  if (!children) return readGitBinding(canonical);
  const repos = [];
  for (const child of children) repos.push({ id: child.id, ...await readGitBinding(child.absPath, { exactRoot: true }) });
  return { path: canonical, checkoutIdentity: await readChatCheckoutIdentity(canonical), repos };
}

/** Verify an owned allocation using the admitted roster and Git registrations. */
export async function readMirroredBinding(intent, expected, { ready = false } = {}) {
  const { source, slotPath, chatId } = intent;
  const canonical = await directory(slotPath);
  if (key(canonical) !== key(getChatWorktreePath(chatId, source.path))) throw denied('The managed worktree storage location changed.');
  const manifest = await readMirrorManifest(canonical);
  if (!manifest || manifest.version !== 1 || manifest.workspaceRoot !== source.path ||
      typeof manifest.branch !== 'string' || manifest.repos.length !== source.repos.length) {
    throw denied('The prepared worktree does not match the workspace repositories.');
  }
  const repos = [];
  for (const original of source.repos) {
    const repo = manifest.repos.find(row => row?.id === original.id);
    const location = path.join(canonical, original.id);
    if (!repo || repo.relPath !== original.id || repo.source !== original.path || typeof repo.worktreePath !== 'string' || key(repo.worktreePath) !== key(location) ||
        repo.baseSha !== original.head || repo.baseBranch !== original.branch) {
      throw denied(`The prepared worktree no longer matches ${original.id}.`);
    }
    const [checkout, originalCommon] = await Promise.all([
      readGitBinding(location, { exactRoot: true, registered: true, rebasingBranch: ready ? expected?.branch : undefined }),
      git(['rev-parse', '--path-format=absolute', '--git-common-dir'], original.path).then(readChatCheckoutIdentity),
    ]);
    if (checkout.commonIdentity !== original.commonIdentity || originalCommon !== original.commonIdentity ||
        checkout.gitIdentity === original.gitIdentity || checkout.branch !== manifest.branch || !ready && checkout.head !== original.head) {
      throw denied(`The Git checkout for ${repo.id} changed. Inspect it in Source Control before continuing.`);
    }
    repos.push({ id: repo.id, ...checkout });
  }
  const current = { path: canonical, checkoutIdentity: await readChatCheckoutIdentity(canonical), branch: manifest.branch, repos };
  const comparable = binding => ready ? { ...binding, repos: binding.repos.map(repo => ({ ...repo, head: null })) } : binding;
  if (expected && !isDeepStrictEqual(comparable(current), comparable(expected))) {
    throw denied('The prepared worktree was replaced or its branch changed. Inspect it in Source Control before continuing.');
  }
  return current;
}
