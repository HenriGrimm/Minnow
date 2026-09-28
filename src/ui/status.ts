import { parseServerBaseUrl as parseServerBaseUrlImpl } from '../lib/parse-server-base-url';
import { closeMobileFileSidebar } from './file-layout';
import { closeMobileSidebar } from './layout';
import { closeModelSelectMenu } from './model-select-picker';
import { closeSubAgentDrawer } from './sub-agent-drawer';
import { closeGoalEvalDrawer } from './goal-eval-drawer';
import { closeResearchPanel, isResearchPanelOpen } from './research-panel';
import { closeIssuesFileDrawer, isIssuesFileDrawerOpen } from './issues-file-drawer';
import { showToast } from './toast';

/** Legacy settings field; when #serverUrl is absent, default LM Studio port for Vite-only mode. */
export function serverUrl(): string {
  if (typeof document === 'undefined') return 'http://localhost:1234';
  const el = document.getElementById('serverUrl') as HTMLInputElement | null;
  if (!el) return 'http://localhost:1234';
  return el.value.trim().replace(/\/$/, '');
}

/** Display base URL for the active provider (read-only field in settings). */
export function setActiveProviderBaseUrl(baseUrl: string): void {
  const el = document.getElementById('serverUrl') as HTMLInputElement | null;
  if (el) {
    el.value = baseUrl;
  }
}

/** Validate LM Studio base URL before network calls. */
export function parseServerBaseUrl(raw: string): string | null {
  return parseServerBaseUrlImpl(raw);
}

/** Topbar pill states — operational feedback only, not model inventory. */
export type StatusState = 'idle' | 'ok' | 'err' | 'spin';

/** Legacy topbar and Minnow menubar status targets (same pill semantics). */
const STATUS_PILL_TARGETS: ReadonlyArray<{ dotId: string; textId: string }> = [
  { dotId: 'sDot', textId: 'sText' },
  { dotId: 'osStatusDot', textId: 'osStatusText' },
];

/** Last status message — used so error clicks can copy even when the pill truncates or uses title. */
let lastStatusState: StatusState | string = 'idle';
let lastStatusMsg = '';

const COPYABLE_CLASS = 'status-pill__text--copyable';

/** Copy the current error status text to the clipboard (skips when the user is selecting text). */
function copyStatusErrorIfIdleSelection(): void {
  if (lastStatusState !== 'err' || !lastStatusMsg.trim()) return;
  const selected = window.getSelection()?.toString() ?? '';
  if (selected.length > 0) return;

  void navigator.clipboard.writeText(lastStatusMsg).then(
    () => showToast('Error copied'),
    () => showToast('Could not copy error', 'error'),
  );
}

/** Bind one-shot click / keyboard copy handlers on status text nodes as they appear. */
function ensureStatusCopyHandlers(): void {
  for (const { textId } of STATUS_PILL_TARGETS) {
    const text = document.getElementById(textId);
    if (!text || text.dataset.statusCopyBound === '1') continue;
    text.dataset.statusCopyBound = '1';
    text.addEventListener('click', () => {
      copyStatusErrorIfIdleSelection();
    });
    text.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      if (lastStatusState !== 'err') return;
      ev.preventDefault();
      copyStatusErrorIfIdleSelection();
    });
  }
}

function applyStatusPill(
  dot: HTMLElement,
  text: HTMLElement,
  state: StatusState | string,
  msg: string,
): void {
  dot.className = `s-dot ${state}`;
  text.textContent = msg;
  const trimmed = msg.trim();
  const isErr = state === 'err';

  text.classList.toggle(COPYABLE_CLASS, isErr);
  if (isErr) {
    text.setAttribute('role', 'button');
    text.setAttribute('tabindex', '0');
    const hint = trimmed ? `${trimmed} (click to copy)` : 'Click to copy error';
    text.setAttribute('title', hint);
    text.setAttribute('aria-label', hint);
  } else {
    text.removeAttribute('role');
    text.removeAttribute('tabindex');
    text.removeAttribute('aria-label');
    if (trimmed.length > 24) {
      text.setAttribute('title', trimmed);
    } else {
      text.removeAttribute('title');
    }
  }
}

/** Update status pills in the legacy topbar and OS menubar (connection, streaming, workspace). */
export function setStatus(state: StatusState | string, msg: string): void {
  lastStatusState = state;
  lastStatusMsg = msg;
  ensureStatusCopyHandlers();
  for (const { dotId, textId } of STATUS_PILL_TARGETS) {
    const dot = document.getElementById(dotId);
    const text = document.getElementById(textId);
    if (!dot || !text) continue;
    applyStatusPill(dot, text, state, msg);
  }
}

/** Default idle success after model list refresh (matches chat loop). */
export function setReadyStatus(): void {
  setStatus('ok', 'Ready');
}

/** Close settings drawer, Research embed, or mobile chat/file overlays when Escape is pressed. */
export function dismissOpenLayers(): void {
  closeModelSelectMenu();
  closeSubAgentDrawer();
  closeGoalEvalDrawer();
  if (isResearchPanelOpen()) {
    closeResearchPanel();
    return;
  }
  void import('./code-brain-map').then((m) => {
    if (m.isCodeBrainMapOpen()) m.closeCodeBrainMap();
  });
  const drawer = document.getElementById('drawer');
  if (drawer && drawer.classList.contains('open')) {
    void import('./settings').then(({ closeDrawer }) => closeDrawer());
    return;
  }
  if (isIssuesFileDrawerOpen()) {
    closeIssuesFileDrawer();
    return;
  }
  const fileSide = document.getElementById('fileSidebar');
  if (fileSide && fileSide.classList.contains('mobile-open')) {
    closeMobileFileSidebar();
    return;
  }
  const side = document.getElementById('chatSidebar');
  if (side && side.classList.contains('mobile-open')) {
    closeMobileSidebar();
  }
}
