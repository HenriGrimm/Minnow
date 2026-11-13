import { getWorkspacePath } from '../state/workspace';
import { panelPathsEqual, resolvePanelWorktreeCwd } from './panel-worktree-cwd';

let listingWorkspaceRoot: string | undefined;

/** Absolute worktree path when the tree lists a non-main root; undefined for main workspace. */
export function getFileTreeListingWorkspaceRoot(): string | undefined {
  return listingWorkspaceRoot;
}

/** Update listing root after sync compares panel cwd to the previous value. */
export function setFileTreeListingWorkspaceRoot(root: string | undefined): void {
  listingWorkspaceRoot = root;
}

/** Context for file-tree-scoped reads and writes. */
export function buildFileTreeToolContext(): { workspaceRoot?: string } {
  if (listingWorkspaceRoot) {
    return { workspaceRoot: listingWorkspaceRoot };
  }
  return {};
}

/** Muted sidebar suffix when browsing a task worktree (e.g. " · task-abc"). */
export function getFileTreeSidebarTitleSuffix(): string {
  const root = listingWorkspaceRoot?.trim();
  if (!root) return '';
  const main = getWorkspacePath().trim();
  if (main && panelPathsEqual(root, main)) return '';
  const base = root.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return base ? ` · ${base}` : '';
}

/** True when two listing roots are equivalent (undefined ≡ main workspace path). */
export function fileTreeListingRootsEqual(
  a: string | undefined,
  b: string | undefined,
): boolean {
  const main = getWorkspacePath().trim();
  const normA = a?.trim() || undefined;
  const normB = b?.trim() || undefined;
  if (!normA && !normB) return true;
  if (!normA || !normB) {
    const defined = normA ?? normB!;
    return Boolean(main && panelPathsEqual(defined, main));
  }
  return panelPathsEqual(normA, normB);
}

/** Resolve next listing root from git panel cwd. */
export function resolveFileTreeListingRoot(panelCwd?: string): string | undefined {
  return resolvePanelWorktreeCwd(panelCwd);
}

/** Test helper — reset module state. */
export function resetFileTreeListingRootForTests(): void {
  listingWorkspaceRoot = undefined;
}
