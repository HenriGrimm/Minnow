import { getSharedChatHost } from './shared-chat-host-state';
import { getForegroundAppId } from '../os/instances';
const GLOBAL_PROMPT_HOST_IDS = new Set(['globalToolApprovalHost', 'globalQuestionHost']);

/** True when an element can be shown to the user (not display:none / hidden). */
export function isPromptHostVisible(host: HTMLElement | null): boolean {
  if (!host || host.hidden) return false;
  if (host.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(host);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}

/** True when the host's owning chat shell is on screen. */
export function isPromptHostShellVisible(host: HTMLElement): boolean {
  if (GLOBAL_PROMPT_HOST_IDS.has(host.id)) return true;
  if (getSharedChatHost()?.shell.contains(host)) return true;

  const chatView = host.closest('#chatView');
  if (chatView) {
    return chatView.classList.contains('is-open');
  }

  if (host.closest('#desktopComposerRoot')) {
    return false;
  }
  if (host.closest('#mainColumn')) {
    const fg = getForegroundAppId();
    return fg === 'code' || fg == null;
  }

  return true;
}

/** Pick the first host whose shell is visible; else global or any existing host. */
function pickPromptHost(candidates: (HTMLElement | null)[]): HTMLElement | null {
  for (const host of candidates) {
    if (host && isPromptHostShellVisible(host)) return host;
  }
  const global = candidates.find((host) => host && GLOBAL_PROMPT_HOST_IDS.has(host.id));
  if (global) return global;
  return candidates.find((host) => host != null) ?? null;
}

/** Chat app page is open (legacy #/chat or Minnow Chat window). */
function isLegacyChatAppOpen(): boolean {
  return document.getElementById('chatView')?.classList.contains('is-open') ?? false;
}

/** Ordered tool-approval host candidates for the active chat surface. */
export function resolveToolApprovalHost(): HTMLElement | null {
  const codeHost = document.getElementById('toolApprovalHost');
  const chatHost = document.getElementById('chatAppToolApprovalHost');
  const desktopHost = document.getElementById('desktopToolApprovalHost');
  const globalHost = document.getElementById('globalToolApprovalHost');

  if (isLegacyChatAppOpen()) {
    return pickPromptHost([chatHost, globalHost, codeHost, desktopHost]);
  }
  return pickPromptHost([codeHost, globalHost, chatHost, desktopHost]);
}

/** Ordered ask_question host candidates for the active chat surface. */
export function resolveQuestionHost(): HTMLElement | null {
  const codeHost = document.getElementById('questionHost');
  const chatHost = document.getElementById('chatAppQuestionHost');
  const desktopHost = document.getElementById('desktopQuestionHost');
  const globalHost = document.getElementById('globalQuestionHost');

  if (isLegacyChatAppOpen()) {
    return pickPromptHost([chatHost, globalHost, codeHost, desktopHost]);
  }
  return pickPromptHost([codeHost, globalHost, chatHost, desktopHost]);
}

/** Composer shell that should hide its input row while a prompt strip is open. */
export function resolvePromptComposerShell(): HTMLElement | null {
  if (getSharedChatHost()) return getSharedChatHost()!.shell;
  if (isLegacyChatAppOpen()) {
    return document.querySelector('.chat-app-composer');
  }
  return document.getElementById('mainColumn');
}
