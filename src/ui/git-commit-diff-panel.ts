import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { gitDiff, gitShow } from '../state/git-api';
import { showViewerSplit, hideViewerSplit } from './file-layout';
import { basename } from './file-tree-path';
import {
  countPatchLineStats,
  splitPatchIntoFiles,
  type GitPatchFileEntry,
} from './git-patch-files';
import {
  getGitCommitDiffWordWrap,
  setGitCommitDiffWordWrap,
} from './git-commit-diff-prefs';
import {
  renderSideBySidePatchDiff,
  setSideBySidePatchDiffWordWrap,
} from './side-by-side-patch-diff';
import { iconHtml } from './icon';

export interface GitCommitDiffPanelOptions {
  sha: string;
  cwd?: string;
  subject?: string;
}

export interface GitWorkingFileDiffPanelOptions {
  path: string;
  staged: boolean;
  cwd?: string;
}

/** Dispatched when the commit diff panel closes (any path). */
export const GIT_COMMIT_DIFF_CLOSED_EVENT = 'minnow:git-commit-diff-closed';

export {
  GIT_COMMIT_DIFF_WORD_WRAP_KEY,
  getGitCommitDiffWordWrap,
  setGitCommitDiffWordWrap,
} from './git-commit-diff-prefs';

let openSha: string | null = null;
let openRecorded = false;
let openWorkingFile: { path: string; staged: boolean } | null = null;
let paneMarked = false;
let activeFileIndex = 0;
let fileEntries: GitPatchFileEntry[] = [];
let diffBodyEl: HTMLElement | null = null;
let fileTabsEl: HTMLElement | null = null;
let wrapToggleBtn: HTMLButtonElement | null = null;
let diffMountEl: HTMLElement | null = null;

// ── Queries ──────────────────────────────────────────────────────────────────

function getViewerPane(): HTMLElement | null {
  return document.getElementById('fileViewerPane');
}

function getViewerHost(): HTMLElement | null {
  return document.getElementById('fileViewerHost');
}

/** True when the commit diff panel is showing in the file viewer split. */
export function isGitCommitDiffPanelOpen(): boolean {
  return openSha !== null || openRecorded;
}

/** Currently displayed commit sha, if any. */
export function getOpenGitCommitDiffSha(): string | null {
  return openSha;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function appendFileTabStats(parent: HTMLElement, entry: GitPatchFileEntry): void {
  const { additions, deletions } = countPatchLineStats(entry.patch);
  const badge = document.createElement('span');
  badge.className = 'git-commit-diff__file-tab-stats';

  if (additions > 0) {
    const add = document.createElement('span');
    add.className = 'code-change-strip__add';
    add.textContent = `+${additions}`;
    badge.appendChild(add);
  }
  if (deletions > 0) {
    if (additions > 0) badge.appendChild(document.createTextNode(' '));
    const del = document.createElement('span');
    del.className = 'code-change-strip__del';
    del.textContent = `−${deletions}`;
    badge.appendChild(del);
  }

  parent.appendChild(badge);
}

function syncWrapToggleUi(enabled: boolean): void {
  if (!wrapToggleBtn) return;
  wrapToggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  wrapToggleBtn.classList.toggle('is-active', enabled);
  wrapToggleBtn.title = enabled ? 'Disable word wrap' : 'Enable word wrap';
}

function applyWordWrapToMount(enabled: boolean): void {
  if (!diffMountEl) return;
  setSideBySidePatchDiffWordWrap(diffMountEl, enabled);
}

function renderFileDiff(index: number): void {
  if (!diffBodyEl) return;
  const entry = fileEntries[index];
  diffMountEl = null;
  if (!entry) {
    diffBodyEl.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'git-commit-diff__empty';
    empty.textContent = 'No file changes in this commit.';
    diffBodyEl.appendChild(empty);
    return;
  }

  diffBodyEl.replaceChildren();

  if (entry.notice) {
    const note = document.createElement('p');
    note.className = 'git-commit-diff__empty';
    note.textContent = entry.notice;
    diffBodyEl.append(note);
  }

  const labels = document.createElement('div');
  labels.className = 'git-commit-diff__column-labels';
  const leftLabel = document.createElement('span');
  leftLabel.className = 'git-commit-diff__column-label';
  const rightLabel = document.createElement('span');
  rightLabel.className = 'git-commit-diff__column-label';
  if (openRecorded) {
    leftLabel.textContent = 'Before';
    rightLabel.textContent = 'After';
  } else if (openWorkingFile) {
    leftLabel.textContent = 'HEAD';
    rightLabel.textContent = openWorkingFile.staged ? 'Staged' : 'Working tree';
  } else {
    leftLabel.textContent = entry.oldPath ? `${entry.oldPath} (parent)` : `${entry.path} (parent)`;
    rightLabel.textContent = entry.path;
  }
  labels.append(leftLabel, rightLabel);
  diffBodyEl.appendChild(labels);

  if (entry.binary) {
    const note = document.createElement('p');
    note.className = 'git-commit-diff__binary';
    note.textContent = 'Binary file changed (no text diff).';
    diffBodyEl.appendChild(note);
    return;
  }

  const mount = document.createElement('div');
  mount.className = 'git-commit-diff__diff-mount';
  diffBodyEl.appendChild(mount);
  diffMountEl = mount;
  renderSideBySidePatchDiff(mount, entry.patch, { wordWrap: getGitCommitDiffWordWrap() });
}

function selectFile(index: number): void {
  if (index < 0 || index >= fileEntries.length) return;
  activeFileIndex = index;
  if (!fileTabsEl) return;

  const tabs = fileTabsEl.querySelectorAll<HTMLButtonElement>('.git-commit-diff__file-tab');
  tabs.forEach((tab, i) => {
    const selected = i === index;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
  });

  renderFileDiff(index);
}

function buildFileTabs(): void {
  const tabs = fileTabsEl;
  if (!tabs) return;
  tabs.replaceChildren();

  if (fileEntries.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'git-commit-diff__no-files';
    empty.textContent = 'No files changed';
    tabs.appendChild(empty);
    return;
  }

  fileEntries.forEach((entry, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'git-commit-diff__file-tab';
    tab.setAttribute('role', 'tab');
    tab.title = entry.path;

    const name = document.createElement('span');
    name.className = 'git-commit-diff__file-tab-name';
    name.textContent = basename(entry.path);

    tab.append(name);
    appendFileTabStats(tab, entry);
    tab.addEventListener('click', () => selectFile(index));
    tabs.appendChild(tab);
  });
}

// ── Chrome ───────────────────────────────────────────────────────────────────

function markViewerPane(): void {
  const pane = getViewerPane();
  if (!pane || paneMarked) return;
  pane.classList.add('file-viewer-pane--commit-diff');
  paneMarked = true;
}

function unmarkViewerPane(): void {
  const pane = getViewerPane();
  if (!pane || !paneMarked) return;
  pane.classList.remove('file-viewer-pane--commit-diff');
  paneMarked = false;
}

function createCloseButton(): HTMLButtonElement {
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.id = 'btnGitCommitDiffClose';
  closeBtn.className = 'icon-btn git-commit-diff-close';
  closeBtn.setAttribute('aria-label', 'Close commit diff');
  closeBtn.title = 'Close';
  closeBtn.innerHTML =
    iconHtml('close');
  closeBtn.addEventListener('click', () => closeGitCommitDiffPanel());
  return closeBtn;
}

/** Wrap toggle in the meta bar — preference applies to the open mount immediately. */
function createWrapToggleButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'btnGitCommitDiffWrap';
  btn.className = 'git-commit-diff__wrap-toggle';
  btn.textContent = 'Wrap';
  btn.setAttribute('aria-label', 'Toggle word wrap in commit diff');
  const enabled = getGitCommitDiffWordWrap();
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btn.classList.toggle('is-active', enabled);
  btn.title = enabled ? 'Disable word wrap' : 'Enable word wrap';
  btn.addEventListener('click', () => {
    const next = !getGitCommitDiffWordWrap();
    setGitCommitDiffWordWrap(next);
    syncWrapToggleUi(next);
    applyWordWrapToMount(next);
  });
  wrapToggleBtn = btn;
  return btn;
}

function createMetaActions(): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'git-commit-diff__meta-actions';
  actions.append(createWrapToggleButton(), createCloseButton());
  return actions;
}

function mountPanelShell(meta: HTMLElement, showFileTabs: boolean): void {
  const host = getViewerHost();
  if (!host) return;

  host.replaceChildren();
  host.classList.add('git-commit-diff-host');

  const shell = document.createElement('div');
  shell.className = 'git-commit-diff';

  fileTabsEl = document.createElement('div');
  fileTabsEl.className = 'git-commit-diff__file-tabs';
  fileTabsEl.setAttribute('role', 'tablist');
  fileTabsEl.setAttribute('aria-label', 'Changed files');
  fileTabsEl.hidden = !showFileTabs;

  diffBodyEl = document.createElement('div');
  diffBodyEl.className = 'git-commit-diff__body';

  shell.append(meta, fileTabsEl, diffBodyEl);
  host.appendChild(shell);
}

function mountCommitPanelChrome(shortSha: string, subject: string, statLine: string): void {
  const meta = document.createElement('div');
  meta.className = 'git-commit-diff__meta';

  const metaText = document.createElement('div');
  metaText.className = 'git-commit-diff__meta-text';
  const title = document.createElement('h2');
  title.className = 'git-commit-diff__title';
  title.textContent = expandGitmojiShortcodes(subject) || `Commit ${shortSha}`;
  const detail = document.createElement('p');
  detail.className = 'git-commit-diff__detail';
  detail.textContent = statLine ? `${shortSha} — ${statLine}` : shortSha;
  metaText.append(title, detail);

  meta.append(metaText, createMetaActions());
  mountPanelShell(meta, true);
}

function mountWorkingFilePanelChrome(path: string, staged: boolean): void {
  const meta = document.createElement('div');
  meta.className = 'git-commit-diff__meta';

  const metaText = document.createElement('div');
  metaText.className = 'git-commit-diff__meta-text';
  const title = document.createElement('h2');
  title.className = 'git-commit-diff__title';
  title.textContent = basename(path);
  title.title = path;
  const detail = document.createElement('p');
  detail.className = 'git-commit-diff__detail';
  detail.textContent = `${staged ? 'Staged' : 'Unstaged'} — ${path}`;
  metaText.append(title, detail);

  meta.append(metaText, createMetaActions());
  mountPanelShell(meta, false);
}

/** Result of attempting to open the commit diff panel. */
export type GitCommitDiffOpenResult =
  | { ok: true }
  | { ok: false; error?: string; cancelled?: boolean };

// ── Open ─────────────────────────────────────────────────────────────────────

/** Open or focus the commit diff panel for `sha`. Re-clicking the same sha closes it. */
export async function openGitCommitDiffPanel(
  options: GitCommitDiffPanelOptions,
): Promise<GitCommitDiffOpenResult> {
  const sha = options.sha.trim();
  if (!sha) return { ok: false, error: 'sha is required' };

  if (openSha === sha) {
    closeGitCommitDiffPanel();
    return { ok: true };
  }

  openWorkingFile = null;

  const result = await gitShow({ sha, cwd: options.cwd });
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Could not load commit' };
  }

  const { dismissFileViewerForPreview } = await import('./file-viewer');
  if (!(await dismissFileViewerForPreview())) {
    return { ok: false, cancelled: true };
  }

  showViewerSplit();
  openRecorded = false;
  markViewerPane();

  openSha = sha;
  fileEntries = splitPatchIntoFiles(result.patch ?? '');
  activeFileIndex = 0;

  const shortSha = sha.slice(0, 7);
  const statLine = result.stat?.trim().split('\n').pop()?.trim() ?? '';
  const subject = options.subject?.trim() ?? '';

  mountCommitPanelChrome(shortSha, subject, statLine);
  buildFileTabs();
  selectFile(0);

  return { ok: true };
}

/** Open the side-by-side diff viewer for a staged or unstaged working-tree file. */
export async function openGitWorkingFileDiffPanel(
  options: GitWorkingFileDiffPanelOptions,
): Promise<GitCommitDiffOpenResult> {
  const path = options.path.trim();
  if (!path) return { ok: false, error: 'path is required' };

  const staged = options.staged;
  if (openWorkingFile?.path === path && openWorkingFile.staged === staged) {
    closeGitCommitDiffPanel();
    return { ok: true };
  }

  const result = await gitDiff({ path, cached: staged, cwd: options.cwd });
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Could not load diff' };
  }

  const { dismissFileViewerForPreview } = await import('./file-viewer');
  if (!(await dismissFileViewerForPreview())) {
    return { ok: false, cancelled: true };
  }

  showViewerSplit();
  openRecorded = false;
  markViewerPane();

  openSha = null;
  openWorkingFile = { path, staged };
  fileEntries = splitPatchIntoFiles(result.patch ?? '');
  activeFileIndex = 0;

  mountWorkingFilePanelChrome(path, staged);
  if (fileEntries.length > 1) {
    if (fileTabsEl) fileTabsEl.hidden = false;
    buildFileTabs();
    const focusIndex = Math.max(
      0,
      fileEntries.findIndex((entry) => entry.path === path),
    );
    selectFile(focusIndex);
  } else {
    selectFile(0);
  }

  return { ok: true };
}

/** Review recorded chat changes using the same chrome and renderer as Git history. */
export async function openRecordedChangesDiffPanel(entries: GitPatchFileEntry[]): Promise<GitCommitDiffOpenResult> {
  const { dismissFileViewerForPreview } = await import('./file-viewer');
  if (!(await dismissFileViewerForPreview())) return { ok: false, cancelled: true };
  showViewerSplit();
  markViewerPane();
  openSha = null;
  openWorkingFile = null;
  openRecorded = true;
  fileEntries = entries;
  activeFileIndex = 0;
  mountCommitPanelChrome('Recorded changes', 'Chat changes', `${entries.length} files`);
  buildFileTabs();
  selectFile(0);
  return { ok: true };
}

/** Close the commit diff panel and hide the viewer split when empty. */
export function closeGitCommitDiffPanel(): void {
  if (!openSha && !openWorkingFile && !openRecorded) return;

  openSha = null;
  openRecorded = false;
  openWorkingFile = null;
  fileEntries = [];
  activeFileIndex = 0;
  fileTabsEl = null;
  diffBodyEl = null;
  wrapToggleBtn = null;
  diffMountEl = null;

  const host = getViewerHost();
  if (host) {
    host.classList.remove('git-commit-diff-host');
    host.replaceChildren();
  }

  unmarkViewerPane();

  hideViewerSplit();

  window.dispatchEvent(new CustomEvent(GIT_COMMIT_DIFF_CLOSED_EVENT));
}
