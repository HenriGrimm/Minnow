import { getWorkspacePath } from '../state/workspace';
import { getGitPanelCwd } from './git-panel';
import { getFileTreeListingWorkspaceRoot } from './file-tree-listing-root';
import { normalizePanelPath, panelPathsEqual } from './panel-worktree-cwd';

/** Absolute cwd for new PTY sessions: same root as the file explorer (listing worktree when set, else git panel cwd, else main workspace). */
export function resolveFileExplorerTerminalCwd(): string {
  const listingRoot = getFileTreeListingWorkspaceRoot()?.trim();
  if (listingRoot) return listingRoot;
  const panelCwd = getGitPanelCwd()?.trim();
  if (panelCwd) return panelCwd;
  return getWorkspacePath().trim() || '.';
}

/** True when cwd is a worktree distinct from the main workspace. */
export function isTerminalWorktreeCwd(cwd: string): boolean {
  const ws = getWorkspacePath().trim();
  if (!ws) return false;
  return !panelPathsEqual(cwd, ws);
}

/** Muted header suffix when browsing a task worktree (e.g. " · task-abc"). */
export function getTerminalCwdLabelSuffix(cwd: string): string {
  if (!isTerminalWorktreeCwd(cwd)) return '';
  const base = normalizePanelPath(cwd).split('/').filter(Boolean).pop();
  return base ? ` · ${base}` : '';
}

/** PTY tab title: shell label plus workspace or worktree scope (e.g. "PowerShell 7 · workspace"). */
export function formatTerminalTabTitle(shellLabel: string, cwd: string): string {
  const label = shellLabel.trim() || 'Terminal';
  if (!isTerminalWorktreeCwd(cwd)) {
    return `${label} · workspace`;
  }
  const suffix = getTerminalCwdLabelSuffix(cwd);
  return suffix ? `${label}${suffix}` : label;
}

/** Tooltip for a PTY tab — full shell label and absolute cwd. */
export function formatTerminalTabTooltip(shellLabel: string, cwd: string): string {
  const label = shellLabel.trim() || 'Terminal';
  const scope = isTerminalWorktreeCwd(cwd)
    ? formatTerminalCwdHeader(cwd)
    : 'main workspace';
  return `${label} — ${scope}\n${cwd}`;
}

/** Short label for the terminal header cwd chip. */
export function formatTerminalCwdHeader(cwd: string): string {
  const normalized = normalizePanelPath(cwd);
  const base = normalized.split('/').filter(Boolean).pop() ?? cwd;
  if (isTerminalWorktreeCwd(cwd)) {
    return `${base} (worktree)`;
  }
  return base;
}

export interface TerminalShellHintOptions {
  /** File explorer root changed while a PTY tab is open elsewhere. */
  scopeChanged?: boolean;
  activeShellDiffers?: boolean;
}

/** Shell cwd hint text; reflects file-explorer worktree cwd and scope-change guidance. Empty when there is nothing to say. */
export function formatTerminalShellHint(
  cwd: string,
  options?: TerminalShellHintOptions,
): string {
  if (options?.scopeChanged && options?.activeShellDiffers) {
    const suffix = getTerminalCwdLabelSuffix(cwd);
    const label = suffix ? suffix.slice(3) : formatTerminalCwdHeader(cwd);
    return `File root changed — open a new terminal tab (+) to start in ${label}. Current shell keeps its directory.`;
  }
  if (isTerminalWorktreeCwd(cwd)) {
    return `Shell cwd: ${cwd} (file explorer worktree).`;
  }
  return '';
}

/** Compare two terminal cwd paths (undefined-safe via panel normalization). */
export function terminalCwdsEqual(a: string, b: string): boolean {
  return panelPathsEqual(a, b);
}
