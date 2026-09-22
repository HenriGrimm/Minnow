import type { ToolExecutionResult } from '../types';
import { getWorkspacePath } from '../state/workspace';
import { affectedDirsFromTool } from './file-tree-invalidation';
import { panelPathsEqual } from './panel-worktree-cwd';
import { getFileTreeListingWorkspaceRoot } from './file-tree-listing-root';
import { isFileTreeServerAvailable } from './file-tree-server';

/** Built-in tools that mutate workspace files or directories (aligned with path-args writes). */
export const FILE_TREE_MUTATING_TOOLS = new Set<string>([
  'save_file',
  'apply_patch',
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
  'make_directory',
  'move_file',
  'copy_file',
  'delete_path',
  'create_pdf',
  'create_spreadsheet',
  'create_word_document',
]);

/** Debounce window — resets on every tool call; coalesces a burst of rapid agent writes into one tree reload when the burst pauses for this long. */
export const FILE_TREE_AUTO_REFRESH_DEBOUNCE_MS = 500;

/** Hard ceiling on how long we wait before forcing a refresh even under continuous agent load (pure debounce would never fire if agents write faster than the window). */
export const FILE_TREE_AUTO_REFRESH_MAX_DELAY_MS = 10_000;

/** Delay after tree interaction ends before flushing a deferred refresh. */
export const FILE_TREE_INTERACTION_FLUSH_MS = 300;

import { scheduleChatAppOutputsRefreshAfterTool } from './chat-app-outputs';
import {
  refreshDirectoriesViaBridge,
  refreshFileTreeViaBridge,
} from './file-tree-refresh-bridge';

const defaultRefreshRunner = async (dirs: string[] | null): Promise<void> => {
  if (dirs && dirs.length > 0) {
    await refreshDirectoriesViaBridge(dirs);
    return;
  }
  await refreshFileTreeViaBridge();
};

/** Swappable runner for unit tests (counts invocations without loading file-tree). */
let refreshRunner: (dirs: string[] | null) => Promise<void> = defaultRefreshRunner;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let maxDelayTimer: ReturnType<typeof setTimeout> | null = null;
let interactionFlushTimer: ReturnType<typeof setTimeout> | null = null;
let userInteractingWithTree = false;
/** True after a mutating tool schedules refresh; cleared when the refresh runs or is reset. */
let refreshPending = false;
let pendingRefreshDirs: Set<string> | null = null;
let interactionTrackingBound = false;

// ── Schedule ─────────────────────────────────────────────────────────────────

/** True when a mutating tool's workspaceRoot matches the file tree listing root. */
function toolWorkspaceMatchesFileTreeListing(workspaceRoot?: string): boolean {
  const treeRoot = getFileTreeListingWorkspaceRoot();
  const main = getWorkspacePath().trim();
  const toolRoot = workspaceRoot?.trim() || undefined;

  if (!treeRoot) {
    if (!toolRoot) return true;
    return Boolean(main && panelPathsEqual(toolRoot, main));
  }

  if (!toolRoot) return false;
  return panelPathsEqual(treeRoot, toolRoot);
}

/** True when a successful mutating tool result should trigger a debounced file tree refresh. */
export function shouldScheduleFileTreeRefresh(
  toolName: string,
  result: ToolExecutionResult,
  workspaceRoot?: string,
): boolean {
  if (!isFileTreeServerAvailable()) {
    return false;
  }
  if (!toolWorkspaceMatchesFileTreeListing(workspaceRoot)) {
    return false;
  }
  if (!FILE_TREE_MUTATING_TOOLS.has(toolName)) {
    return false;
  }
  const text = typeof result.content === 'string' ? result.content : '';
  if (text.startsWith('Error:')) {
    return false;
  }
  return true;
}

function mergePendingDirs(toolName: string, args?: Record<string, unknown>): void {
  const affected = args ? affectedDirsFromTool(toolName, args) : null;
  if (!affected || affected.length === 0) {
    pendingRefreshDirs = null;
    return;
  }
  if (pendingRefreshDirs === null) {
    pendingRefreshDirs = new Set(affected);
    return;
  }
  for (const dir of affected) {
    pendingRefreshDirs.add(dir);
  }
}

function showPendingRefreshIndicator(): void {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('btnFileTreeRefresh');
  if (!btn) return;
  btn.classList.add('file-tree-refresh--pending');
  btn.setAttribute('aria-live', 'polite');
  btn.setAttribute('aria-label', 'File tree refresh pending');
}

function clearPendingRefreshIndicator(): void {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('btnFileTreeRefresh');
  if (!btn) return;
  btn.classList.remove('file-tree-refresh--pending');
  btn.removeAttribute('aria-live');
  btn.setAttribute('aria-label', 'Refresh file tree');
}

// ── Flush ────────────────────────────────────────────────────────────────────

function flushDebouncedRefresh(): void {
  if (!refreshPending) {
    return;
  }

  if (debounceTimer != null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (maxDelayTimer != null) {
    clearTimeout(maxDelayTimer);
    maxDelayTimer = null;
  }

  if (userInteractingWithTree) {
    showPendingRefreshIndicator();
    return;
  }

  refreshPending = false;
  const dirs = pendingRefreshDirs ? [...pendingRefreshDirs] : null;
  pendingRefreshDirs = null;
  clearPendingRefreshIndicator();

  void refreshRunner(dirs).catch(() => {
  });
}

function scheduleInteractionFlush(): void {
  if (!refreshPending) {
    return;
  }
  if (interactionFlushTimer != null) {
    clearTimeout(interactionFlushTimer);
  }
  interactionFlushTimer = setTimeout(() => {
    interactionFlushTimer = null;
    if (!userInteractingWithTree) {
      flushDebouncedRefresh();
    }
  }, FILE_TREE_INTERACTION_FLUSH_MS);
}

/** Track pointer and keyboard focus inside the file tree so agent refreshes can defer until the user finishes browsing (VS Code-style non-disruptive updates). */
export function initFileTreeAutoRefreshInteractionTracking(): void {
  if (interactionTrackingBound || typeof document === 'undefined') return;
  const host = document.getElementById('fileTreeHost');
  if (!host) return;
  interactionTrackingBound = true;

  let pointerDownInTree = false;

  host.addEventListener('pointerdown', () => {
    pointerDownInTree = true;
    userInteractingWithTree = true;
  });

  host.addEventListener('pointerup', () => {
    pointerDownInTree = false;
    userInteractingWithTree = false;
    scheduleInteractionFlush();
  });

  host.addEventListener('pointercancel', () => {
    pointerDownInTree = false;
    userInteractingWithTree = false;
    scheduleInteractionFlush();
  });

  host.addEventListener('focusin', () => {
    userInteractingWithTree = true;
  });

  host.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && host.contains(next)) return;
    if (pointerDownInTree) return;
    userInteractingWithTree = false;
    scheduleInteractionFlush();
  });
}

// ── Public ───────────────────────────────────────────────────────────────────

export function scheduleFileTreeRefreshAfterTool(
  toolName: string,
  result: ToolExecutionResult,
  workspaceRoot?: string,
  args?: Record<string, unknown>,
): void {
  if (!shouldScheduleFileTreeRefresh(toolName, result, workspaceRoot)) {
    return;
  }

  refreshPending = true;
  mergePendingDirs(toolName, args);

  if (debounceTimer != null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(flushDebouncedRefresh, FILE_TREE_AUTO_REFRESH_DEBOUNCE_MS);

  if (maxDelayTimer == null) {
    maxDelayTimer = setTimeout(flushDebouncedRefresh, FILE_TREE_AUTO_REFRESH_MAX_DELAY_MS);
  }

  if (userInteractingWithTree) {
    showPendingRefreshIndicator();
  }
}

/** Runs a tool executor, then applies file-tree auto-refresh rules to the result. */
export async function runWithFileTreeAutoRefresh<T extends ToolExecutionResult>(
  toolName: string,
  fn: () => Promise<T>,
  context?: { workspaceRoot?: string },
  args?: Record<string, unknown>,
): Promise<T> {
  const result = await fn();
  scheduleFileTreeRefreshAfterTool(toolName, result, context?.workspaceRoot, args);
  scheduleChatAppOutputsRefreshAfterTool(toolName, result);
  return result;
}

/** Test helper: restore default refresh runner and cancel any pending timers. */
export function resetFileTreeAutoRefreshForTests(): void {
  refreshRunner = defaultRefreshRunner;
  userInteractingWithTree = false;
  refreshPending = false;
  pendingRefreshDirs = null;
  interactionTrackingBound = false;
  clearPendingRefreshIndicator();
  if (debounceTimer != null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (maxDelayTimer != null) {
    clearTimeout(maxDelayTimer);
    maxDelayTimer = null;
  }
  if (interactionFlushTimer != null) {
    clearTimeout(interactionFlushTimer);
    interactionFlushTimer = null;
  }
}

/** Test helper: replace the refresh implementation (e.g. counter stub). */
export function setFileTreeAutoRefreshRunnerForTests(
  fn: (dirs: string[] | null) => Promise<void>,
): void {
  refreshRunner = fn;
}

/** Test helper: simulate user interaction state. */
export function setFileTreeUserInteractingForTests(interacting: boolean): void {
  userInteractingWithTree = interacting;
  if (!interacting) {
    scheduleInteractionFlush();
  }
}
