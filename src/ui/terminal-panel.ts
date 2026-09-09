import '../styles/terminal.css';

import {
  cancelTerminalRun,
  fetchTerminalLog,
  loadTerminalHistory,
  startTerminalRun,
  streamTerminalRun,
} from '../api/terminal';
import {
  getTerminalMetaCached,
  loadTerminalMeta,
  saveTerminalMeta,
} from '../config/terminal-meta';
import {
  ensureSessionsReady,
  getActiveChat,
  scheduleSaveSessions,
  sessionState,
} from '../state/sessions';
import type { TerminalRunRecord } from '../types';
import { getLocalServerAvailable } from '../tools/client';
import { registerShellRun, unregisterShellRun } from './shell-run-registry';
import { refreshShellKillUi } from './shell-run-ui';
import {
  detachAllTerminalTabs,
  flushTerminalTabsForUnload,
  initTerminalTabs,
  isTerminalTabsInitialized,
  onTerminalPanelResize,
  setAgentTabActivityBadge,
  setTerminalNewTabScope,
  setTerminalTabChangeHandler,
  activePtyDiffersFromTargetCwd,
  switchToAgentTab,
  type TerminalTabKind,
} from './terminal-tabs';
import { stripAnsi } from '../lib/strip-ansi';
import {
  capTextOutput,
  PROCESS_MAX_ACCUMULATE_BYTES,
  resolveOutputCapPolicy,
  runWithOutputCapPolicy,
  sliceStreamLines,
} from '../../server/tools/output-cap.js';
import { loadToolConfig } from '../tools/config';
import {
  focusTerminalXterm,
  initTerminalXterm,
  isTerminalXtermReady,
} from './terminal-xterm';
import { initTerminalWorkspaceDrop } from './terminal-workspace-drop';
import { appendConsoleOutputWithLinks } from './terminal-console-links';
import {
  shouldShowAgentTabActivityBadge,
  shouldSwitchToAgentTab,
} from './terminal-agent-follow-policy';
import {
  formatTerminalCwdHeader,
  formatTerminalShellHint,
  isTerminalWorktreeCwd,
  resolveFileExplorerTerminalCwd,
  terminalCwdsEqual,
} from './terminal-worktree-cwd';
import { resolveTerminalPanelMinHeightPx } from './terminal-layout';
import { notifyChatStreamActivity } from '../chat/streaming-state';
const MAX_HEIGHT_RATIO = 0.5;
const MAIN_COLUMN_TERMINAL_MAX_CLASS = 'main-column--terminal-maximized';

let panelEl: HTMLElement | null = null;
let agentPaneEl: HTMLElement | null = null;
let ptyPaneEl: HTMLElement | null = null;
let outputEl: HTMLElement | null = null;
let xtermHostEl: HTMLElement | null = null;
let agentRunSelectEl: HTMLSelectElement | null = null;
let offlineBannerEl: HTMLElement | null = null;
let terminalCwdLabelEl: HTMLElement | null = null;
let activeRunId: string | null = null;
/** Active SSE subscriptions for agent background shell runs (MIN-402). */
const agentBackgroundStreams = new Map<string, AbortController>();
/** Last docked height before the user expanded the terminal over chat. */
let heightBeforeMaximize: number | null = null;
let terminalMaximized = false;
let stickToBottom = true;
let displayBytes = 0;
const MAX_DISPLAY_BYTES = 2 * 1024 * 1024;
let activeTabKind: TerminalTabKind = 'pty';
/** Depth of agent runs that requested the top-bar hint while the panel was closed. */
let agentRunHintDepth = 0;
/** Depth of agent runs that should badge the Agent tab while the user is on another tab. */
let agentTabActivityDepth = 0;
/** Last synced target cwd for new PTY tabs (file-explorer scope change detection). */
let terminalTargetCwd: string | undefined;
let terminalScopeChangePending = false;

const TERMINAL_BTN_DEFAULT_TITLE = 'Terminal (Ctrl+`)';
const TERMINAL_BTN_AGENT_RUN_TITLE =
  'Agent command running — click Terminal to view';

/** Hooks for tool loop streaming integration. */
export interface TerminalStreamHooks {
  onRunStart?: (runId: string, command: string) => void;
  onChunk?: (runId: string, stream: 'stdout' | 'stderr', text: string) => void;
  onRunEnd?: (runId: string) => void;
}

let externalHooks: TerminalStreamHooks = {};

/** Count live execute_command stdout/stderr as stream progress so the board stall watchdog does not kill a long but chatty tool. */
export function notifyProgressFromTerminalChunk(chatId: string, text: string): void {
  if (!chatId.trim() || !text) return;
  notifyChatStreamActivity(chatId);
}

// ── Height ───────────────────────────────────────────────────────────────────

function minPanelHeight(): number {
  return resolveTerminalPanelMinHeightPx(panelEl, xtermHostEl);
}

function maxPanelHeight(): number {
  const ratioCap = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
  if (!panelEl) return ratioCap;

  const mainColumn = document.getElementById('mainColumn');
  if (!mainColumn) return ratioCap;

  const panelBottom = panelEl.getBoundingClientRect().bottom;
  const columnTop = mainColumn.getBoundingClientRect().top;
  const structuralCap = Math.floor(panelBottom - columnTop - 8);

  return Math.max(minPanelHeight(), Math.min(ratioCap, structuralCap));
}

function clampHeight(px: number): number {
  return Math.min(maxPanelHeight(), Math.max(minPanelHeight(), px));
}

function isTerminalMaximized(): boolean {
  return terminalMaximized;
}

function syncTerminalMaximizeButton(): void {
  const btn = document.getElementById('btnTerminalMaximize');
  if (!btn) return;
  const maximized = isTerminalMaximized();
  btn.setAttribute('aria-pressed', maximized ? 'true' : 'false');
  btn.setAttribute(
    'aria-label',
    maximized ? 'Restore terminal size' : 'Expand terminal',
  );
  btn.setAttribute(
    'title',
    maximized ? 'Restore terminal size' : 'Expand terminal to fill chat',
  );
}

function clearTerminalMaximizedState(): void {
  document.getElementById('mainColumn')?.classList.remove(MAIN_COLUMN_TERMINAL_MAX_CLASS);
  panelEl?.classList.remove('is-maximized');
  terminalMaximized = false;
  syncTerminalMaximizeButton();
}

function setTerminalMaximized(maximized: boolean): void {
  const mainColumn = document.getElementById('mainColumn');
  if (!panelEl || !mainColumn) return;
  if (terminalMaximized === maximized) return;

  if (maximized) {
    if (!isTerminalPanelOpen()) {
      openTerminalPanel();
    }
    heightBeforeMaximize = panelEl.getBoundingClientRect().height;
    mainColumn.classList.add(MAIN_COLUMN_TERMINAL_MAX_CLASS);
    panelEl.classList.add('is-maximized');
    panelEl.style.removeProperty('height');
    terminalMaximized = true;
  } else {
    mainColumn.classList.remove(MAIN_COLUMN_TERMINAL_MAX_CLASS);
    panelEl.classList.remove('is-maximized');
    terminalMaximized = false;
    const restoreHeight = heightBeforeMaximize ?? getTerminalMetaCached().heightPx;
    heightBeforeMaximize = null;
    applyPanelHeight(restoreHeight);
  }

  syncTerminalMaximizeButton();
  requestAnimationFrame(() => onTerminalPanelResize());
}

function toggleTerminalMaximized(): void {
  setTerminalMaximized(!isTerminalMaximized());
}

// ── Chrome ───────────────────────────────────────────────────────────────────

function getElements(): void {
  panelEl = document.getElementById('terminalPanel');
  agentPaneEl = document.getElementById('terminalAgentPane');
  ptyPaneEl = document.getElementById('terminalPtyPane');
  outputEl = document.getElementById('terminalOutput');
  xtermHostEl = document.getElementById('terminalXtermHost');
  agentRunSelectEl = document.getElementById(
    'terminalAgentRunSelect',
  ) as HTMLSelectElement | null;
  offlineBannerEl = document.getElementById('terminalOfflineBanner');
  terminalCwdLabelEl = document.getElementById('terminalCwdLabel');
}

function updateTerminalCwdChrome(cwd: string): void {
  if (!terminalCwdLabelEl) return;
  const isWorktree = isTerminalWorktreeCwd(cwd);
  terminalCwdLabelEl.textContent = isWorktree ? formatTerminalCwdHeader(cwd) : '';
  terminalCwdLabelEl.title = isWorktree ? cwd : '';
  terminalCwdLabelEl.classList.toggle('hidden', !isWorktree);
}

function updateTerminalShellHintText(cwd: string): void {
  const hintEl = document.getElementById('terminalShellHint');
  if (!hintEl) return;
  const activeShellDiffers =
    terminalScopeChangePending && activePtyDiffersFromTargetCwd(cwd);
  hintEl.textContent = formatTerminalShellHint(cwd, {
    scopeChanged: terminalScopeChangePending,
    activeShellDiffers,
  });
}

function maybeClearScopeChangePending(): void {
  if (!terminalTargetCwd || !terminalScopeChangePending) return;
  if (!activePtyDiffersFromTargetCwd(terminalTargetCwd)) {
    terminalScopeChangePending = false;
    updateTerminalShellHintText(terminalTargetCwd);
  }
}

/** Align terminal cwd with the file explorer / git panel root (MIN-349). */
export function syncTerminalFromFileExplorer(): void {
  getElements();

  const cwd = resolveFileExplorerTerminalCwd();
  const prevCwd = terminalTargetCwd;
  const cwdChanged =
    prevCwd !== undefined && !terminalCwdsEqual(prevCwd, cwd);

  terminalTargetCwd = cwd;
  terminalScopeChangePending = cwdChanged;
  setTerminalNewTabScope(cwd);
  updateTerminalCwdChrome(cwd);
  updateTerminalShellHintText(cwd);
}

function applyActiveTabView(kind: TerminalTabKind): void {
  activeTabKind = kind;
  const isAgent = kind === 'agent';
  const isPty = kind === 'pty';

  agentPaneEl?.classList.toggle('hidden', !isAgent);
  ptyPaneEl?.classList.toggle('hidden', !isPty);

  document.getElementById('terminalShellHint')?.classList.toggle('hidden', isAgent);
  document.getElementById('terminalHeaderShell')?.classList.toggle('hidden', isAgent);
  const clearBtn = document.getElementById('btnTerminalClear');
  clearBtn?.classList.toggle('hidden', !isAgent);
  if (clearBtn) {
    clearBtn.textContent = 'Clear agent output';
  }

  if (isAgent) {
    setAgentTabActivityBadge(false);
    scrollOutputIfPinned();
    refreshShellKillUi();
    return;
  }

  requestAnimationFrame(() => {
    onTerminalPanelResize();
    focusTerminalXterm();
  });
}

/** Switch to the Agent tab only when the user opted in or explicitly requested history. */
function maybeFollowAgentTab(userInitiated = false): void {
  const meta = getTerminalMetaCached();
  if (
    shouldSwitchToAgentTab({
      panelOpen: isTerminalPanelOpen(),
      userInitiated,
      autoFollowAgentTab: meta.autoFollowAgentTab,
    })
  ) {
    void switchToAgentTab();
  }
}

function syncAgentTabActivityBadge(): void {
  setAgentTabActivityBadge(
    shouldShowAgentTabActivityBadge({
      panelOpen: isTerminalPanelOpen(),
      activeTabKind,
      activityDepth: agentTabActivityDepth,
    }),
  );
}

function bumpAgentTabActivity(delta: number): void {
  agentTabActivityDepth = Math.max(0, agentTabActivityDepth + delta);
  syncAgentTabActivityBadge();
}

function updateOfflineBanner(): void {
  if (!offlineBannerEl || !xtermHostEl) return;
  const offline = !getLocalServerAvailable();
  offlineBannerEl.classList.toggle('hidden', !offline);
  xtermHostEl.classList.toggle('terminal-xterm-host--offline', offline);
}

function scrollOutputIfPinned(): void {
  if (!outputEl || !stickToBottom || activeTabKind !== 'agent') return;
  outputEl.scrollTop = outputEl.scrollHeight;
}

// ── Output ───────────────────────────────────────────────────────────────────

function appendOutputText(text: string, stream: 'stdout' | 'stderr'): void {
  if (!outputEl || !text) return;

  const plain = stripAnsi(text);
  if (!plain) return;

  const addBytes = new TextEncoder().encode(plain).length;
  if (displayBytes + addBytes > MAX_DISPLAY_BYTES) {
    if (!outputEl.dataset.truncated) {
      outputEl.appendChild(document.createTextNode('\n…[truncated]\n'));
      outputEl.dataset.truncated = '1';
    }
    return;
  }
  displayBytes += addBytes;

  appendConsoleOutputWithLinks(outputEl, plain, { stderr: stream === 'stderr' });
  scrollOutputIfPinned();
}

function clearOutput(): void {
  if (!outputEl) return;
  outputEl.textContent = '';
  delete outputEl.dataset.truncated;
  displayBytes = 0;
}

function isTerminalPanelOpen(): boolean {
  return Boolean(panelEl && !panelEl.classList.contains('hidden'));
}

function beginCommandOutput(command: string, options: { clear?: boolean } = {}): void {
  maybeFollowAgentTab();
  if (options.clear) {
    clearOutput();
    appendOutputText(`$ ${command}\n`, 'stdout');
    stickToBottom = true;
    return;
  }
  if (outputEl?.textContent?.trim()) {
    appendOutputText('\n', 'stdout');
  }
  appendOutputText(`$ ${command}\n`, 'stdout');
  stickToBottom = true;
}

function setActiveHistoryRun(runId: string): void {
  if (!agentRunSelectEl) return;
  agentRunSelectEl.value = runId;
}

export function appendTerminalOutput(
  runId: string,
  stream: 'stdout' | 'stderr',
  text: string,
): void {
  if (activeRunId && runId !== activeRunId) return;
  appendOutputText(text, stream);
  externalHooks.onChunk?.(runId, stream, text);
}

function syncTerminalAgentRunHint(): void {
  const btn = document.getElementById('btnTerminal');
  if (!btn) return;
  const show = agentRunHintDepth > 0;
  btn.classList.toggle('icon-btn--agent-run', show);
  btn.setAttribute('title', show ? TERMINAL_BTN_AGENT_RUN_TITLE : TERMINAL_BTN_DEFAULT_TITLE);
}

function bumpAgentRunHint(delta: number): void {
  agentRunHintDepth = Math.max(0, agentRunHintDepth + delta);
  syncTerminalAgentRunHint();
}

// ── Panel visibility ─────────────────────────────────────────────────────────

function setPanelOpen(open: boolean): void {
  if (!panelEl) return;
  const currentlyOpen = isTerminalPanelOpen();
  const btn = document.getElementById('btnTerminal');
  btn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (currentlyOpen === open) return;

  if (!open && terminalMaximized) {
    clearTerminalMaximizedState();
    heightBeforeMaximize = null;
  }

  panelEl.classList.toggle('hidden', !open);
  panelEl.classList.toggle('is-collapsed', !open);
  void saveTerminalMeta({ open });
  if (open) {
    agentRunHintDepth = 0;
    syncTerminalAgentRunHint();
    void ensureTerminalTabsWhenOpen();
    requestAnimationFrame(() => {
      onTerminalPanelResize();
      focusTerminalXterm();
    });
  }
}

function ensureTerminalPanelVisible(): void {
  if (!isTerminalPanelOpen()) {
    setPanelOpen(true);
  }
}

/** Wire PTY tabs and attach the active tab only after the user opens the panel. */
async function ensureTerminalTabsWhenOpen(): Promise<void> {
  if (!isTerminalPanelOpen()) return;

  const tabBar = document.getElementById('terminalTabBar');
  const shellSelect = document.getElementById(
    'terminalShellSelect',
  ) as HTMLSelectElement | null;
  if (
    !tabBar ||
    !shellSelect ||
    !getLocalServerAvailable() ||
    !isTerminalXtermReady()
  ) {
    return;
  }

  try {
    await initTerminalTabs(tabBar, shellSelect);
  } catch (err) {
    console.error('Terminal tabs failed to initialize', err);
  }
}

export function openTerminalPanel(): void {
  ensureTerminalPanelVisible();
  void ensureTerminalTabsWhenOpen();
  void refreshTerminalHistoryForActiveChat();
}

interface AgentBackgroundStreamUiState {
  showAgentRunHint: boolean;
  showAgentTabBadge: boolean;
}

// ── Agent stream ─────────────────────────────────────────────────────────────

async function pumpAgentBackgroundStream(
  runId: string,
  label: string,
  chatId: string,
  startedAt: number,
  toolCallId: string | undefined,
  abort: AbortController,
  ui: AgentBackgroundStreamUiState,
): Promise<void> {
  let finished = false;
  let exitCode: number | null = null;
  let timedOut = false;

  try {
    await streamTerminalRun(
      runId,
      (ev) => {
        if (!agentBackgroundStreams.has(runId)) return;
        if (ev.type === 'stdout') {
          appendTerminalOutput(runId, 'stdout', ev.text);
        } else if (ev.type === 'stderr') {
          appendTerminalOutput(runId, 'stderr', ev.text);
        } else if (ev.type === 'exit') {
          finished = true;
          exitCode = ev.code;
          timedOut = ev.timedOut;
          const stoppedSuffix = ev.stopped ? ', stopped' : '';
          appendTerminalOutput(
            runId,
            'stderr',
            `\n[exit ${ev.code ?? '?'}${ev.timedOut ? ', timed out' : ''}${stoppedSuffix}]\n`,
          );
        } else if (ev.type === 'error') {
          appendTerminalOutput(runId, 'stderr', `\nError: ${ev.message}\n`);
        }
      },
      abort.signal,
    );
  } catch (err) {
    if (abort.signal.aborted) return;
    appendTerminalOutput(
      runId,
      'stderr',
      `\nError: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  } finally {
    agentBackgroundStreams.delete(runId);
    unregisterShellRun(runId);
    refreshShellKillUi();

    if (activeRunId === runId) {
      activeRunId = null;
    }

    if (ui.showAgentRunHint) {
      bumpAgentRunHint(-1);
    }
    if (ui.showAgentTabBadge) {
      bumpAgentTabActivity(-1);
    }

    const chat = getActiveChat();
    if (chat?.id === chatId && (finished || !abort.signal.aborted)) {
      upsertChatTerminalRun(chat, {
        id: runId,
        command: label,
        cwd: '.',
        source: 'agent',
        ...(toolCallId ? { toolCallId } : {}),
        startedAt,
        finishedAt: Date.now(),
        exitCode,
        timedOut,
        logPath: `logs/terminal/${runId}.log`,
      });
      await refreshTerminalHistoryForActiveChat();
      scheduleSaveSessions();
    }
  }
}

/** Mirror a background agent shell run in the Agent terminal tab (SSE log tail + kill UI). */
export function attachAgentBackgroundRun(options: {
  runId: string;
  command: string;
  chatId: string;
  toolCallId?: string;
  startedAt?: number;
  initialOutput?: string;
}): void {
  getElements();

  const runId = options.runId.trim();
  if (!runId) return;

  if (agentBackgroundStreams.has(runId)) return;

  const command = options.command.trim() || 'background command';
  const chatId = options.chatId.trim();
  const startedAt = options.startedAt ?? Date.now();
  const toolCallId = options.toolCallId?.trim() || undefined;

  const panelWasClosed = !isTerminalPanelOpen();
  const showAgentRunHint = panelWasClosed;
  const showAgentTabBadge = !panelWasClosed;
  if (showAgentRunHint) {
    bumpAgentRunHint(1);
  }
  if (showAgentTabBadge) {
    bumpAgentTabActivity(1);
  }

  if (getTerminalMetaCached().autoOpenOnAgentRun) {
    openTerminalPanel();
  }

  maybeFollowAgentTab();
  activeRunId = runId;
  beginCommandOutput(command, { clear: true });
  if (options.initialOutput?.trim()) {
    appendOutputText(options.initialOutput, 'stdout');
  }

  registerShellRun({
    runId,
    command,
    toolCallId,
    chatId,
  });
  refreshShellKillUi();
  setActiveHistoryRun(runId);

  const abort = new AbortController();
  agentBackgroundStreams.set(runId, abort);
  void pumpAgentBackgroundStream(runId, command, chatId, startedAt, toolCallId, abort, {
    showAgentRunHint,
    showAgentTabBadge,
  });
}

export function closeTerminalPanel(): void {
  setPanelOpen(false);
}

export function toggleTerminalPanel(): void {
  setPanelOpen(!isTerminalPanelOpen());
}

function applyPanelHeight(px: number): void {
  if (!panelEl) return;
  const height = clampHeight(px);
  if (!terminalMaximized) {
    panelEl.style.height = `${height}px`;
  }
  void saveTerminalMeta({ heightPx: height });
  onTerminalPanelResize();
}

const MAX_TERMINAL_HISTORY = 50;

// ── History ──────────────────────────────────────────────────────────────────

function historyCommandLabel(run: TerminalRunRecord): string {
  const cmd = typeof run.command === 'string' ? run.command.trim() : '';
  if (cmd) return cmd;
  if (run.toolCallId) return `Tool ${run.toolCallId.slice(0, 8)}…`;
  return `Run ${run.id.slice(0, 8)}…`;
}

function mergeTerminalHistory(
  local: TerminalRunRecord[],
  remote: TerminalRunRecord[],
): TerminalRunRecord[] {
  const byId = new Map<string, TerminalRunRecord>();
  for (const run of [...local, ...remote]) {
    if (!run?.id) continue;
    const existing = byId.get(run.id);
    if (!existing || run.finishedAt >= existing.finishedAt) {
      byId.set(run.id, run);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_TERMINAL_HISTORY);
}

function upsertChatTerminalRun(
  chat: { terminalHistory?: TerminalRunRecord[] },
  record: TerminalRunRecord,
): void {
  const history = chat.terminalHistory ?? [];
  const next = [record, ...history.filter((r) => r.id !== record.id)].slice(
    0,
    MAX_TERMINAL_HISTORY,
  );
  chat.terminalHistory = next;
  renderHistoryList(next);
}

function renderHistoryList(runs: TerminalRunRecord[]): void {
  if (!agentRunSelectEl) return;

  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  agentRunSelectEl.innerHTML = '';

  if (sorted.length === 0) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'No agent runs yet';
    empty.disabled = true;
    empty.selected = true;
    agentRunSelectEl.appendChild(empty);
    return;
  }

  for (const run of sorted) {
    const label = historyCommandLabel(run);
    const opt = document.createElement('option');
    opt.value = run.id;
    opt.textContent = label;
    opt.title = label;
    agentRunSelectEl.appendChild(opt);
  }
}

function wireAgentRunSelect(): void {
  agentRunSelectEl?.addEventListener('change', () => {
    const runId = agentRunSelectEl?.value?.trim();
    if (!runId) return;
    void loadHistoryRun(runId);
  });
}

async function loadHistoryRun(runId: string): Promise<void> {
  maybeFollowAgentTab(true);
  clearOutput();
  setActiveHistoryRun(runId);
  const text = await fetchTerminalLog(runId);
  if (text) {
    appendOutputText(text, 'stdout');
  }
}

export async function refreshTerminalHistoryForActiveChat(): Promise<void> {
  await ensureSessionsReady();
  if (!sessionState) return;

  const chat = getActiveChat();
  if (!chat) return;

  const local = chat.terminalHistory ?? [];
  let remote: TerminalRunRecord[] = [];
  if (getLocalServerAvailable()) {
    try {
      remote = await loadTerminalHistory(chat.id);
    } catch {
    }
  }
  const merged = mergeTerminalHistory(local, remote);
  chat.terminalHistory = merged.length ? merged : undefined;
  renderHistoryList(merged);
}

function setupResizeHandle(): void {
  const handle = document.getElementById('terminalResize');
  if (!handle || !panelEl) return;

  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startHeight = panelEl!.getBoundingClientRect().height;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging || !panelEl) return;
    const delta = startY - e.clientY;
    applyPanelHeight(startHeight + delta);
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
  });
}

function setupOutputScroll(): void {
  outputEl?.addEventListener('scroll', () => {
    if (!outputEl) return;
    const atBottom =
      outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 24;
    stickToBottom = atBottom;
  });
}

// ── Command stream ───────────────────────────────────────────────────────────

export async function runCommandWithTerminalStream(
  command: string,
  options: {
    chatId: string;
    source: 'user' | 'agent';
    toolCallId?: string;
    displayLabel?: string;
    args?: string[];
    shell?: boolean;
    hooks?: TerminalStreamHooks;
    /** When aborted (e.g. user Stop), cancel the server run. */
    abortSignal?: AbortSignal;
    /** Allow-listed workspace root for agent runs (user runs stay global). */
    workspaceRoot?: string;
    /** Working directory relative to workspaceRoot. */
    cwd?: string;
    /** Custom timeout in ms forwarded to the server (1000–600000; default 30s). */
    timeoutMs?: number;
    /** Prefer-mode approval to run without sandbox when unavailable. */
    allowUnsandboxed?: boolean;
    /** Skip product result-size caps for this persisted tool string (MIN-667). */
    fullResult?: boolean;
    /** Keep only these head/tail lines of stdout/stderr in the tool result. */
    outputSlice?: { headLines?: number; tailLines?: number };
    /** Lower the character budget for this call (never raises the configured one). */
    maxOutputChars?: number;
  },
): Promise<string> {
  const isAgentRun = options.source === 'agent';
  if (isAgentRun && getTerminalMetaCached().autoOpenOnAgentRun) {
    openTerminalPanel();
  }

  const panelWasClosed = !isTerminalPanelOpen();
  const showAgentRunHint = isAgentRun && panelWasClosed;
  const showAgentTabBadge = isAgentRun && !panelWasClosed;
  if (showAgentRunHint) {
    bumpAgentRunHint(1);
  }
  if (showAgentTabBadge) {
    bumpAgentTabActivity(1);
  }

  try {
  const label = options.displayLabel ?? command;
  beginCommandOutput(label, { clear: true });

  const { runId, startedAt } = await startTerminalRun({
    command,
    args: options.args,
    shell: options.shell,
    chatId: options.chatId,
    source: options.source,
    toolCallId: options.toolCallId,
    workspaceRoot: options.workspaceRoot,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    allowUnsandboxed: options.allowUnsandboxed,
  });

  activeRunId = runId;
  registerShellRun({
    runId,
    command: label,
    toolCallId: options.toolCallId,
    chatId: options.chatId,
  });
  refreshShellKillUi();
  setActiveHistoryRun(runId);
  options.hooks?.onRunStart?.(runId, label);
  externalHooks.onRunStart?.(runId, label);

  let exitCode: number | null = 0;
  let timedOut = false;
  let stopped = false;
  let stdoutAcc = '';
  let stderrAcc = '';
  let accTruncated = false;
  let aborted = false;

  const accumulate = (current: string, text: string): string => {
    if (current.length >= PROCESS_MAX_ACCUMULATE_BYTES) {
      accTruncated = true;
      return current;
    }
    const room = PROCESS_MAX_ACCUMULATE_BYTES - current.length;
    if (text.length <= room) return current + text;
    accTruncated = true;
    return current + text.slice(0, room);
  };

  const onAbort = () => {
    aborted = true;
    void cancelTerminalRun(runId);
  };
  options.abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    await streamTerminalRun(
      runId,
      (ev) => {
        if (ev.type === 'stdout') {
          stdoutAcc = accumulate(stdoutAcc, ev.text);
          appendTerminalOutput(runId, 'stdout', ev.text);
          notifyProgressFromTerminalChunk(options.chatId, ev.text);
          options.hooks?.onChunk?.(runId, 'stdout', ev.text);
        } else if (ev.type === 'stderr') {
          stderrAcc = accumulate(stderrAcc, ev.text);
          appendTerminalOutput(runId, 'stderr', ev.text);
          notifyProgressFromTerminalChunk(options.chatId, ev.text);
          options.hooks?.onChunk?.(runId, 'stderr', ev.text);
        } else if (ev.type === 'exit') {
          exitCode = ev.code;
          timedOut = ev.timedOut;
          stopped = ev.stopped ?? false;
        } else if (ev.type === 'error') {
          appendOutputText(`\nError: ${ev.message}\n`, 'stderr');
        }
      },
      options.abortSignal,
    );
  } catch (err) {
    if (!aborted && !options.abortSignal?.aborted) {
      throw err;
    }
    aborted = true;
  } finally {
    options.abortSignal?.removeEventListener('abort', onAbort);
  }

  activeRunId = null;
  unregisterShellRun(runId);
  refreshShellKillUi();
  options.hooks?.onRunEnd?.(runId);
  externalHooks.onRunEnd?.(runId);

  const chat = getActiveChat();
  if (chat?.id === options.chatId) {
    upsertChatTerminalRun(chat, {
      id: runId,
      command: label,
      cwd: '.',
      source: options.source,
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      startedAt,
      finishedAt: Date.now(),
      exitCode,
      timedOut,
      logPath: `logs/terminal/${runId}.log`,
    });
    await refreshTerminalHistoryForActiveChat();
    scheduleSaveSessions();
  }

  const timeoutSecs = options.timeoutMs ? options.timeoutMs / 1000 : 30;
  const parts = [
    aborted
      ? `${label} (cancelled)`
      : stopped
        ? `${label} (stopped by user — process terminated, not a failure)`
        : timedOut
          ? `${label} (timed out after ${timeoutSecs}s)`
          : `${label} (exit ${exitCode ?? 1})`,
  ];
  if (accTruncated) {
    parts.push(
      `(subprocess output exceeded ${PROCESS_MAX_ACCUMULATE_BYTES} bytes and was cut during capture)`,
    );
  }
  const policy = resolveOutputCapPolicy(loadToolConfig().toolOutput, {
    full_result: options.fullResult === true,
    ...(options.maxOutputChars != null ? { max_output_chars: options.maxOutputChars } : {}),
  });
  // Same shape as the Node path's formatProcessOutput: keep the tail, where a
  // build or test run puts its failure.
  const capOptions = {
    middleElide: true,
    footerHint:
      'narrow the command scope, or re-run with tail_lines / max_output_chars, or background it and page read_command_log',
  };
  return runWithOutputCapPolicy(policy, () => {
  if (stdoutAcc.trim()) {
    const sliced = sliceStreamLines(stdoutAcc.trimEnd(), options.outputSlice);
    const { text } = capTextOutput(sliced, capOptions);
    parts.push(`stdout:\n${text}`);
  }
  if (stderrAcc.trim()) {
    const sliced = sliceStreamLines(stderrAcc.trimEnd(), options.outputSlice);
    const { text } = capTextOutput(sliced, capOptions);
    parts.push(`stderr:\n${text}`);
  }
  if (!stdoutAcc.trim() && !stderrAcc.trim()) {
    parts.push('(no output)');
  }
  return parts.join('\n\n');
  });
  } finally {
    if (showAgentRunHint) {
      bumpAgentRunHint(-1);
    }
    if (showAgentTabBadge) {
      bumpAgentTabActivity(-1);
    }
  }
}

export function setTerminalStreamHooks(hooks: TerminalStreamHooks): void {
  externalHooks = hooks;
}

function wireTerminalPanelButtons(): void {
  if (panelEl?.dataset.buttonsWired === 'true') return;
  if (panelEl) panelEl.dataset.buttonsWired = 'true';

  document.getElementById('btnTerminal')?.addEventListener('click', () => {
    toggleTerminalPanel();
  });

  document.getElementById('btnTerminalClear')?.addEventListener('click', () => {
    if (activeTabKind === 'agent') {
      clearOutput();
    }
  });

  document.getElementById('btnTerminalCollapse')?.addEventListener('click', () => {
    closeTerminalPanel();
  });

  document.getElementById('btnTerminalMaximize')?.addEventListener('click', () => {
    toggleTerminalMaximized();
  });

  syncTerminalMaximizeButton();
}

// ── Init ─────────────────────────────────────────────────────────────────────

export async function initTerminalPanel(): Promise<void> {
  getElements();
  if (!panelEl) return;

  wireTerminalPanelButtons();
  setTerminalTabChangeHandler((_tabId, kind) => {
    applyActiveTabView(kind);
    if (kind === 'pty') {
      maybeClearScopeChangePending();
    }
  });
  wireAgentRunSelect();

  const meta = await loadTerminalMeta();
  applyPanelHeight(meta.heightPx);
  setPanelOpen(meta.open);
  updateOfflineBanner();
  applyActiveTabView('pty');

  if (xtermHostEl) {
    initTerminalXterm(xtermHostEl);
    initTerminalWorkspaceDrop(xtermHostEl);
  }

  if (meta.open) {
    await ensureTerminalTabsWhenOpen();
  }

  window.addEventListener('pagehide', () => {
    flushTerminalTabsForUnload();
    void detachAllTerminalTabs();
  });

  setupResizeHandle();
  setupOutputScroll();
  syncTerminalFromFileExplorer();
  await refreshTerminalHistoryForActiveChat();
}

export function registerTerminalKeyboardShortcut(): void {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      toggleTerminalPanel();
    }
  });
}

export function onTerminalServerAvailabilityChanged(): void {
  updateOfflineBanner();
  if (!getLocalServerAvailable()) return;

  getElements();
  if (xtermHostEl && !isTerminalXtermReady()) {
    initTerminalXterm(xtermHostEl);
    initTerminalWorkspaceDrop(xtermHostEl);
  }
  if (isTerminalPanelOpen()) {
    void ensureTerminalTabsWhenOpen();
  }
}
