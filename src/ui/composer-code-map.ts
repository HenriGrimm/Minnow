import { nextThinkingTriStateOnClick } from './composer-thinking';
import {
  chatUsesDesktopSandboxWorkspace,
  fetchCodeMapInjectionDefault,
  resolveCodeMapInjectionEnabled,
  resolveCodeMapInjectionTriState,
} from '../brain/code-injection-config';
import { fetchBrainCodeConfig } from '../brain/client';
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

function formatCodeMapTitle(
  tri: ThinkingTriState,
  resolvedOn: boolean,
  globalDefault: boolean,
): string {
  if (tri === 'inherit') {
    const inherited = globalDefault ? 'on' : 'off';
    return `Code map: Inherit (${inherited}) — click to set ${resolvedOn ? 'off' : 'on'}`;
  }
  if (tri === 'on') {
    return 'Code map: On (chat override) — click to turn off';
  }
  return 'Code map: Off (chat override) — click to reset to inherit';
}

function applyChatCodeMapInjection(mode: ThinkingTriState): void {
  const chat = getActiveChat();
  if (mode === 'inherit') {
    delete chat.codeMapInjection;
  } else {
    chat.codeMapInjection = mode;
  }
  touchChat(chat);
  scheduleSaveSessions();
  void syncComposerCodeMapFromActiveChat();
  refreshContextUsageRing();
}

async function onToggleClick(): Promise<void> {
  if (toggleBtn?.disabled) return;
  const globalDefault =
    cachedGlobalDefault ?? (await fetchCodeMapInjectionDefault());
  cachedGlobalDefault = globalDefault;
  const chat = getActiveChat();
  const tri = resolveCodeMapInjectionTriState(chat);
  const resolvedOn = resolveCodeMapInjectionEnabled(chat, globalDefault);
  const resolvedMode = resolvedOn ? 'on' : 'off';
  applyChatCodeMapInjection(nextThinkingTriStateOnClick(tri, resolvedMode));
}

/** Mount code map toggle into #composerCodeMapControl. */
export function initCodeMapInjectionControl(): void {
  rootEl = document.getElementById('composerCodeMapControl');
  if (!rootEl) return;

  rootEl.innerHTML = '';
  rootEl.className = 'code-map-toggle-host';

  toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'code-map-toggle-btn thinking-toggle-btn';
  toggleBtn.setAttribute('aria-label', 'Code map injection');
  toggleBtn.addEventListener('click', () => {
    void onToggleClick();
  });

  const icon = createIcon('codeMapInjection', { className: 'thinking-toggle-icon' });
  toggleBtn.appendChild(icon);
  rootEl.appendChild(toggleBtn);
  void ensureSessionsReady().then(() => syncComposerCodeMapFromActiveChat());
}

/** Sync code map toggle visibility and pressed state from active chat. */
export async function syncComposerCodeMapFromActiveChat(): Promise<void> {
  if (!sessionState) return;

  const wrap = document.getElementById('composerCodeMapWrap');
  const chat = getActiveChat();
  const workspace = getWorkspacePath().trim() || chat.workspacePath?.trim() || '';
  const code = await fetchBrainCodeConfig();
  const globalDefault = await fetchCodeMapInjectionDefault();
  cachedGlobalDefault = globalDefault;
  const onDesktopSandbox = await chatUsesDesktopSandboxWorkspace(chat);
  const show = Boolean(workspace && code?.enabled && globalDefault && !onDesktopSandbox);

  if (wrap) {
    wrap.classList.toggle('hidden', !show);
  }
  if (rootEl) {
    rootEl.classList.toggle('hidden', !show);
  }
  if (!toggleBtn || !show) return;

  const tri = resolveCodeMapInjectionTriState(chat);
  const resolvedOn = resolveCodeMapInjectionEnabled(chat, globalDefault);
  const disabled = isActiveChatStreaming() || isComposerRecoveryBlocked();

  toggleBtn.setAttribute('aria-pressed', resolvedOn ? 'true' : 'false');
  toggleBtn.dataset.inherit = tri === 'inherit' ? 'true' : 'false';
  toggleBtn.dataset.codeMapTri = tri;
  toggleBtn.disabled = disabled;
  toggleBtn.title = formatCodeMapTitle(tri, resolvedOn, globalDefault);
}

export function refreshCodeMapControlDisabled(): void {
  void syncComposerCodeMapFromActiveChat();
}
