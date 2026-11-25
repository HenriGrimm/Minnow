import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { boardDir } from '../orchestrator/journal.js';
import { runProcess } from '../process-runner.js';
import { getEffectiveWorkspaceRoot, runWithToolContext } from '../runtime/path-access.js';
import { discoverWorkspaceRepos } from '../workspace/repos.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import { getWorktreeSlotPath } from './paths.js';
export { boardRevisionRepos } from '../orchestrator/core/revision.js';

const repoScope = new AsyncLocalStorage();
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const pendingLayouts = new Map();

export function boardGit(cwd, args, options) {
  return runProcess('git', ['-c', 'core.longpaths=true', ...args], { cwd, timeout: 120_000, ...options });
}

async function gitValue(cwd, args) {
  const result = await boardGit(cwd, args);
  return result.code === 0 && !result.accumulationTruncated ? result.stdout.trim() : '';
}

const commonDir = cwd => gitValue(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

export function runInBoardRepo(layout, repo, fn) {
  return runWithToolContext(
    () => repoScope.run({ layout, repo }, fn),
    { workspaceRoot: repo.source },
  );
}

export function boardRepoSlotPath(boardId, slotId) {
  const scope = repoScope.getStore();
  if (scope?.layout.boardId !== boardId) return getWorktreeSlotPath(boardId, slotId);
  return path.join(getWorktreeSlotPath(boardId, slotId, scope.layout.workspace), scope.repo.id);
}

export function boardRepoLockKey(boardId) {
  const scope = repoScope.getStore();
  return scope?.layout.boardId === boardId ? JSON.stringify([boardId, scope.repo.id]) : boardId;
}

export function boardRepoPathspec() {
  const scope = repoScope.getStore();
  if (!scope) return [];
  const prefix = scope.repo.id === '.' ? '' : scope.repo.id + '/';
  return scope.layout.repos.filter(repo => repo.id !== scope.repo.id && repo.id.startsWith(prefix))
    .map(repo => `:(exclude,top,literal)${repo.id.slice(prefix.length)}`);
}

export async function verifyScopedBoardCheckout(target, branch) {
  const scope = repoScope.getStore();
  if (!scope) return;
  const [common, top, head] = await Promise.all([
    commonDir(target),
    gitValue(target, ['rev-parse', '--show-toplevel']),
    gitValue(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  ]);
  if (!common || !top || normalizeWorkspacePathKey(common) !== normalizeWorkspacePathKey(scope.repo.common) ||
    normalizeWorkspacePathKey(top) !== normalizeWorkspacePathKey(target) || head !== branch) {
    throw new Error(`Board checkout ${target} no longer belongs to ${scope.repo.id} on ${branch}. Preserve its files before repairing the checkout.`);
  }
}

export function inBoardRepo() {
  return Boolean(repoScope.getStore());
}

async function supportFiles(layout, root, prefix = '') {
  const files = [];
  const names = await fs.readdir(path.join(root, prefix), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of names) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (layout.repos.some(repo => repo.id === name)) continue;
    if (entry.isDirectory()) files.push(...await supportFiles(layout, root, name));
    else files.push(name);
  }
  return files;
}

/** Only the preflight's copied plan and inputs belong outside Git worktrees. */
export async function changedBoardSupport(layout, slotId) {
  if (layout.repos.some(repo => repo.id === '.') || slotId === 'integration') return [];
  const base = getWorktreeSlotPath(layout.boardId, 'integration', layout.workspace);
  const task = getWorktreeSlotPath(layout.boardId, slotId, layout.workspace);
  const expected = await supportFiles(layout, base);
  const actual = await supportFiles(layout, task);
  const changed = [];
  for (const file of new Set([...expected, ...actual])) {
    if (!expected.includes(file) || !actual.includes(file)) { changed.push(file); continue; }
    const [a, b] = [path.join(base, file), path.join(task, file)];
    const stats = await Promise.all([fs.lstat(a), fs.lstat(b)]);
    if (stats.some(stat => !stat.isFile()) || stats[0].size !== stats[1].size ||
      !(await fs.readFile(a)).equals(await fs.readFile(b))) changed.push(file);
  }
  return changed;
}

export function boardRepoRelativePath(repo, name) {
  return repo.id === '.' ? name : `${repo.id}/${name}`;
}

export async function eachBoardRepo(layout, operation) {
  const rows = [];
  for (const repo of layout.repos) {
    const result = await runInBoardRepo(layout, repo, () => operation(repo));
    rows.push([repo.id, result]);
  }
  return rows;
}

export function boardRevision(rows) {
  return 'repos:' + Buffer.from(JSON.stringify(Object.keys(rows).sort().map(id => [id, rows[id]]))).toString('base64url');
}

function layoutPath(boardId) {
  return path.join(boardDir(boardId), 'repositories.json');
}

export async function readBoardRepos(boardId, workspace = getEffectiveWorkspaceRoot()) {
  if (repoScope.getStore()?.layout.boardId === boardId) return null;
  let layout;
  try { layout = JSON.parse(await fs.readFile(layoutPath(boardId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (layout.version !== 1 || layout.boardId !== boardId ||
    normalizeWorkspacePathKey(layout.workspace) !== normalizeWorkspacePathKey(workspace) ||
    !Array.isArray(layout.repos) || layout.repos.length < 1) throw new Error('Board repository layout does not match this workspace.');
  const seen = new Set();
  for (const repo of layout.repos) {
    const id = repo.id;
    if (typeof id !== 'string' || !id || path.isAbsolute(id) || /[\\:\0]/.test(id) ||
      (id !== '.' && id.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))) ||
      seen.has(id) || !shaPattern.test(repo.baseSha) || typeof repo.common !== 'string' ||
      normalizeWorkspacePathKey(repo.source) !== normalizeWorkspacePathKey(path.resolve(workspace, id))) {
      throw new Error('Invalid saved board repository layout.');
    }
    seen.add(id);
  }
  return layout;
}

export async function verifyBoardRepoSources(layout) {
  for (const repo of layout.repos) {
    const common = await commonDir(repo.source);
    if (!common || normalizeWorkspacePathKey(common) !== normalizeWorkspacePathKey(repo.common)) {
      throw Object.assign(new Error(`Board repository ${repo.id} moved or was replaced. Restore its original checkout before resuming.`), {
        failure: { category: 'prerequisite', scope: 'workspace' },
      });
    }
  }
}

export async function discoverBoardRepos(boardId, workspace, baseBranch) {
  const candidates = await discoverWorkspaceRepos(workspace);
  if (!candidates.length || (candidates.length === 1 && candidates[0].isRoot)) return null;
  // Prefer primary checkouts over linked previews of the same Git database.
  const locations = await Promise.all(candidates.map(async candidate => ({
    ...candidate, common: await commonDir(candidate.absPath),
  })));
  locations.sort((a, b) => Number(b.isRoot) - Number(a.isRoot) ||
    Number(normalizeWorkspacePathKey(b.common || b.absPath) === normalizeWorkspacePathKey(path.join(b.absPath, '.git'))) -
    Number(normalizeWorkspacePathKey(a.common || a.absPath) === normalizeWorkspacePathKey(path.join(a.absPath, '.git'))));
  const seen = new Set();
  const repos = [];
  for (const candidate of locations) {
    if (!candidate.common) throw new Error(`Could not identify board repository ${candidate.id}.`);
    const key = normalizeWorkspacePathKey(candidate.common);
    if (seen.has(key)) continue;
    seen.add(key);
    const source = candidate.absPath;
    if (baseBranch && !(await gitValue(source, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${baseBranch}^{commit}`]))) {
      throw new Error(`Starting branch ${baseBranch} does not exist in ${candidate.id}.`);
    }
    const branch = baseBranch || await gitValue(source, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const baseSha = await gitValue(source, ['rev-parse', '--verify', '--end-of-options', `${baseBranch || 'HEAD'}^{commit}`]);
    if (!shaPattern.test(baseSha)) throw new Error(`Board repository ${candidate.id} has no commit at ${baseBranch || 'HEAD'}.`);
    repos.push({ id: candidate.id, source, common: candidate.common, baseSha, baseBranch: branch });
  }
  if (repos.length === 1 && repos[0].id === '.') return null;
  return { version: 1, boardId, workspace, repos };
}

export async function ensureBoardRepos(boardId, workspace, baseBranch) {
  const key = layoutPath(boardId);
  if (pendingLayouts.has(key)) return pendingLayouts.get(key);
  const setup = (async () => {
    const saved = await readBoardRepos(boardId, workspace);
    if (saved) { await verifyBoardRepoSources(saved); return saved; }
    // An existing single-repository board keeps its original integration history.
    try { await fs.access(path.join(getWorktreeSlotPath(boardId, 'integration', workspace), '.git')); return null; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const layout = await discoverBoardRepos(boardId, workspace, baseBranch);
    if (!layout) return null;
    const temporary = `${key}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(layout) + '\n', { flag: 'wx', flush: true });
      await fs.rename(temporary, key);
    } finally { await fs.rm(temporary, { force: true }); }
    return layout;
  })();
  pendingLayouts.set(key, setup);
  try { return await setup; }
  finally { pendingLayouts.delete(key); }
}
