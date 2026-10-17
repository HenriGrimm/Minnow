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

/** Compatibility bridge for callers that previously wrote to the header. */
export type StatusState = 'idle' | 'ok' | 'err' | 'spin';

/**
 * Only errors interrupt globally. Visible results and routine saves stay quiet;
 * meaningful completions opt in through showToast, and progress belongs inline.
 */
export function setStatus(state: StatusState | string, msg: string): void {
  if (state === 'err' || state === 'error') showToast(msg, 'error');
}

/** @deprecated Progress is owned by the initiating control, not the header. */
export function clearStaleGenerationStatus(_anyChatStreaming: boolean): void {}

/** @deprecated Idle readiness is not a notification. */
export function setReadyStatus(): void {}

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
