import { nextThinkingTriStateOnClick } from './composer-thinking';
import {
  fetchContextDocumentsInjectionDefault,
  hasConfiguredContextDocumentPaths,
  loadContextDocumentsSettings,
  resolveContextDocumentsInjectionEnabled,
  resolveContextDocumentsInjectionTriState,
} from '../chat/context-documents/config';
import { isActiveChatStreaming } from '../chat/streaming-state';
import {
  ensureSessionsReady,
  getActiveChat,
  scheduleSaveSessions,
  sessionState,
  touchChat,
} from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import type { ThinkingTriState } from '../agents/thinking-types';
import { createIcon } from './icon';
import { isComposerRecoveryBlocked } from './composer-send';
import { refreshContextUsageRing } from './context-usage-ring';

let rootEl: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let cachedGlobalDefault: boolean | null = null;

function formatContextDocumentsTitle(
  tri: ThinkingTriState,
  resolvedOn: boolean,
  globalDefault: boolean,
): string {
  if (tri === 'inherit') {
    const inherited = globalDefault ? 'on' : 'off';
    return `Context documents: Inherit (${inherited}) — click to set ${resolvedOn ? 'off' : 'on'}`;
  }
  if (tri === 'on') {
    return 'Context documents: On (chat override) — click to turn off';
  }
  return 'Context documents: Off (chat override) — click to reset to inherit';
}

function applyChatContextDocumentsInjection(mode: ThinkingTriState): void {
  const chat = getActiveChat();
  if (mode === 'inherit') {
    delete chat.contextDocumentsInjection;
  } else {
    chat.contextDocumentsInjection = mode;
  }
  touchChat(chat);
  scheduleSaveSessions();
  void syncComposerContextDocumentsFromActiveChat();
  refreshContextUsageRing();
}

async function onToggleClick(): Promise<void> {
  if (toggleBtn?.disabled) return;
  const globalDefault =
    cachedGlobalDefault ?? (await fetchContextDocumentsInjectionDefault());
  cachedGlobalDefault = globalDefault;
  const chat = getActiveChat();
  const tri = resolveContextDocumentsInjectionTriState(chat);
  const resolvedOn = resolveContextDocumentsInjectionEnabled(chat, globalDefault);
  const resolvedMode = resolvedOn ? 'on' : 'off';
  applyChatContextDocumentsInjection(nextThinkingTriStateOnClick(tri, resolvedMode));
}

/** Mount context documents toggle into #composerContextDocumentsControl. */
export function initContextDocumentsInjectionControl(): void {
  rootEl = document.getElementById('composerContextDocumentsControl');
  if (!rootEl) return;

  rootEl.innerHTML = '';
  rootEl.className = 'context-documents-toggle-host';

  toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'context-documents-toggle-btn thinking-toggle-btn';
  toggleBtn.setAttribute('aria-label', 'Workspace context documents injection');
  toggleBtn.addEventListener('click', () => {
    void onToggleClick();
  });

  const icon = createIcon('contextDocuments', { className: 'thinking-toggle-icon' });
  toggleBtn.appendChild(icon);
  rootEl.appendChild(toggleBtn);
  void ensureSessionsReady().then(() => syncComposerContextDocumentsFromActiveChat());
}

/** Sync context documents toggle visibility and pressed state from active chat. */
export async function syncComposerContextDocumentsFromActiveChat(): Promise<void> {
  if (!sessionState) return;

  const wrap = document.getElementById('composerContextDocumentsWrap');
  const workspace = getWorkspacePath().trim() || getActiveChat().workspacePath?.trim() || '';
  const { injectionDefault, documents } = await loadContextDocumentsSettings();
  cachedGlobalDefault = injectionDefault;
  const show = Boolean(
    workspace && injectionDefault && hasConfiguredContextDocumentPaths(documents),
  );

  if (wrap) {
    wrap.classList.toggle('hidden', !show);
  }
  if (rootEl) {
    rootEl.classList.toggle('hidden', !show);
  }
  if (!toggleBtn || !show) return;

  const chat = getActiveChat();
  const tri = resolveContextDocumentsInjectionTriState(chat);
  const resolvedOn = resolveContextDocumentsInjectionEnabled(chat, injectionDefault);
  const disabled = isActiveChatStreaming() || isComposerRecoveryBlocked();

  toggleBtn.setAttribute('aria-pressed', resolvedOn ? 'true' : 'false');
  toggleBtn.dataset.inherit = tri === 'inherit' ? 'true' : 'false';
  toggleBtn.dataset.contextDocumentsTri = tri;
  toggleBtn.disabled = disabled;
  toggleBtn.title = formatContextDocumentsTitle(tri, resolvedOn, injectionDefault);
}

export function refreshContextDocumentsControlDisabled(): void {
  void syncComposerContextDocumentsFromActiveChat();
}
