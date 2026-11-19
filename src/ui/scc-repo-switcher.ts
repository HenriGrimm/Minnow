/**
 * Source Control repo switcher for workspace folders that hold several repos.
 *
 * The center and the sidebar git panel already run every git/forge call in one
 * panel cwd. Choosing a repo points that cwd at the repo's root; the server
 * accepts a repo root discovered inside the workspace (server/git/middleware.js).
 */

import type { MenuItem } from './context-menu';
import { resolveRepoForPath, type WorkspaceRepo } from '../state/workspace-repos';
import { worktreePathsEqual } from '../lib/worktree-list-parse';

const STORAGE_PREFIX = 'minnow.scc.repo:';
const repoPicks = new Map<string, string>();

function storageKey(workspacePath: string): string {
  return `${STORAGE_PREFIX}${workspacePath.replace(/\\/g, '/').toLowerCase()}`;
}

/** Last repo the viewer picked for this workspace (per-viewer convenience). */
export function readRememberedRepo(workspacePath: string): string | null {
  const key = storageKey(workspacePath);
  const picked = repoPicks.get(key);
  if (picked) return picked;
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function rememberRepo(workspacePath: string, repoId: string): void {
  const key = storageKey(workspacePath);
  repoPicks.set(key, repoId);
  try {
    globalThis.localStorage?.setItem(key, repoId);
  } catch {
    /* Storage may be blocked. Keep the pick for this view. */
  }
}

/**
 * The panel cwd for a repo: undefined for a repo at the workspace root (the
 * panels' "main checkout"), else the repo's absolute root.
 */
export function repoPanelCwd(repo: WorkspaceRepo): string | undefined {
  return repo.isRoot ? undefined : repo.absPath;
}

/** The repo a panel cwd points at, or null (e.g. a worktree outside the workspace). */
export function repoForPanelCwd(
  panelCwd: string | undefined,
  repos: readonly WorkspaceRepo[],
  workspacePath: string,
): WorkspaceRepo | null {
  if (!panelCwd || worktreePathsEqual(panelCwd, workspacePath)) {
    return repos.find((repo) => repo.isRoot) ?? null;
  }
  return repos.find((repo) => worktreePathsEqual(repo.absPath, panelCwd)) ?? null;
}

/**
 * The repo to show when the center opens on the workspace itself: the
 * remembered pick, else the repo of the active editor file, else the root
 * repo, else the first. Null when there is nothing to choose.
 */
export function pickDefaultRepo(
  repos: readonly WorkspaceRepo[],
  input: { workspacePath: string; activeFilePath?: string | null; remembered?: string | null },
): WorkspaceRepo | null {
  if (!repos.length) return null;
  const remembered = input.remembered ? repos.find((repo) => repo.id === input.remembered) : undefined;
  if (remembered) return remembered;
  if (input.activeFilePath) {
    const hit = resolveRepoForPath(input.activeFilePath, repos, input.workspacePath);
    if (hit) return hit;
  }
  return repos.find((repo) => repo.isRoot) ?? repos[0];
}

/** Short label for a repo row: the id, with `owner/name` as the hint. */
export function repoLabel(repo: WorkspaceRepo): { label: string; hint?: string } {
  const slug = repo.remote?.owner && repo.remote.name ? `${repo.remote.owner}/${repo.remote.name}` : undefined;
  return { label: repo.isRoot ? `${repo.id === '.' ? 'Workspace root' : repo.id}` : repo.id, hint: slug };
}

/** Menu rows for the switcher. */
export function buildRepoMenuItems(
  repos: readonly WorkspaceRepo[],
  currentId: string | null,
  onPick: (repo: WorkspaceRepo) => void,
): MenuItem[] {
  return [
    { kind: 'heading', label: 'Repository' },
    ...repos.map((repo): MenuItem => {
      const { label, hint } = repoLabel(repo);
      return { id: `repo:${repo.id}`, label, hint, checked: repo.id === currentId, onSelect: () => onPick(repo) };
    }),
  ];
}
