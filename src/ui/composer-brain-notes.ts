import { nextThinkingTriStateOnClick } from './composer-thinking';
import {
  fetchMemoryInjectionEnabled,
  resolveBrainNotesInjectionEnabled,
  resolveBrainNotesInjectionTriState,
} from '../memory/config';
import { fetchMemoryEnabled } from '../memory/client';
import { isActiveChatStreaming } from '../chat/streaming-state';
import {
  ensureSessionsReady,
  getActiveChat,
  scheduleSaveSessions,
  sessionState,
  touchChat,
} from '../state/sessions';
import type { ThinkingTriState } from '../agents/thinking-types';
import { createIcon } from './icon';
import { isComposerRecoveryBlocked } from './composer-send';
import { refreshContextUsageRing } from './context-usage-ring';

interface BrainNotesMount {
  rootId: string;
  wrapId?: string;
  buttonClass: string;
  rootEl: HTMLElement | null;
  toggleBtn: HTMLButtonElement | null;
}

const mounts: BrainNotesMount[] = [
  {
    rootId: 'composerBrainNotesControl',
    wrapId: 'composerBrainNotesWrap',
    buttonClass: 'brain-notes-toggle-btn thinking-toggle-btn',
    rootEl: null,
    toggleBtn: null,
  },
  {
    rootId: 'desktopBrainNotesControl',
    wrapId: 'desktopBrainNotesWrap',
    buttonClass: 'mn-os-desktop-comp-btn brain-notes-toggle-btn thinking-toggle-btn',
    rootEl: null,
    toggleBtn: null,
  },
];

let cachedGlobalDefault: boolean | null = null;

function formatBrainNotesTitle(
  tri: ThinkingTriState,
  resolvedOn: boolean,
  globalDefault: boolean,
): string {
  if (tri === 'inherit') {
    const inherited = globalDefault ? 'on' : 'off';
    return `Brain notes: Inherit (${inherited}) — click to set ${resolvedOn ? 'off' : 'on'}`;
  }
  if (tri === 'on') {
    return 'Brain notes: On (chat override) — click to turn off';
  }
  return 'Brain notes: Off (chat override) — click to reset to inherit';
}

function applyChatBrainNotesInjection(mode: ThinkingTriState): void {
  const chat = getActiveChat();
  if (mode === 'inherit') {
    delete chat.brainNotesInjection;
  } else {
    chat.brainNotesInjection = mode;
  }
  touchChat(chat);
  scheduleSaveSessions();
  void syncComposerBrainNotesFromActiveChat();
  refreshContextUsageRing();
}

async function onToggleClick(): Promise<void> {
  const globalDefault =
    cachedGlobalDefault ?? (await fetchMemoryInjectionEnabled());
  cachedGlobalDefault = globalDefault;
  const chat = getActiveChat();
  const tri = resolveBrainNotesInjectionTriState(chat);
  const resolvedOn = resolveBrainNotesInjectionEnabled(chat, globalDefault);
  const resolvedMode = resolvedOn ? 'on' : 'off';
  applyChatBrainNotesInjection(nextThinkingTriStateOnClick(tri, resolvedMode));
}

function mountBrainNotesControl(config: (typeof mounts)[number]): void {
  const rootEl = document.getElementById(config.rootId);
  if (!rootEl) return;

  rootEl.innerHTML = '';
  rootEl.className = 'brain-notes-toggle-host';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = config.buttonClass;
  toggleBtn.setAttribute('aria-label', 'Brain notes injection');
  toggleBtn.addEventListener('click', () => {
    void onToggleClick();
  });

  const icon = createIcon('brainMemories', { className: 'thinking-toggle-icon' });
  toggleBtn.appendChild(icon);
  rootEl.appendChild(toggleBtn);

  config.rootEl = rootEl;
  config.toggleBtn = toggleBtn;
}

/** Mount Brain notes toggles for Code and desktop composers. */
export function initBrainNotesInjectionControl(): void {
  for (const mount of mounts) {
    mountBrainNotesControl(mount);
  }
  void ensureSessionsReady().then(() => syncComposerBrainNotesFromActiveChat());
}

/** Sync Brain notes toggle visibility and pressed state from active chat. */
export async function syncComposerBrainNotesFromActiveChat(): Promise<void> {
  if (!sessionState) return;

  const storeEnabled = await fetchMemoryEnabled();
  if (!sessionState) return;
  const globalDefault = await fetchMemoryInjectionEnabled();
  if (!sessionState) return;
  cachedGlobalDefault = globalDefault;
  const show = storeEnabled && globalDefault;

  const chat = getActiveChat();
  const tri = resolveBrainNotesInjectionTriState(chat);
  const resolvedOn = resolveBrainNotesInjectionEnabled(chat, globalDefault);
  const disabled = isActiveChatStreaming() || isComposerRecoveryBlocked();
  const title = formatBrainNotesTitle(tri, resolvedOn, globalDefault);

  for (const mount of mounts) {
    if (mount.wrapId) {
      const wrap = document.getElementById(mount.wrapId);
      wrap?.classList.toggle('hidden', !show);
    }
    if (mount.rootEl) {
      mount.rootEl.classList.toggle('hidden', !show);
    }
    const toggleBtn = mount.toggleBtn;
    if (!toggleBtn || !show) continue;

    toggleBtn.setAttribute('aria-pressed', resolvedOn ? 'true' : 'false');
    toggleBtn.dataset.inherit = tri === 'inherit' ? 'true' : 'false';
    toggleBtn.dataset.brainNotesTri = tri;
    toggleBtn.disabled = disabled;
    toggleBtn.title = title;
  }
}

export function refreshBrainNotesControlDisabled(): void {
  void syncComposerBrainNotesFromActiveChat();
}
