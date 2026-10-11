import { getForegroundAppId } from '../os/instances';
import type { AppId } from '../os/types';
import { isChatAppForeground } from './chat-mount';

/** Composer DOM targets used by send / steer / streaming affordances. */
export interface ComposerSurface {
  inputEl: HTMLTextAreaElement | null;
  sendBtnEl: HTMLButtonElement | null;
  /** Scoped hosts own turn dispatch without changing Code's active chat. */
  onPrimaryAction?: () => void;
}

const DEFAULT_IDS: Record<string, { inputId: string; sendBtnId: string }> = {
  code: { inputId: 'msgInput', sendBtnId: 'sendBtn' },
  chat: { inputId: 'chatAppInput', sendBtnId: 'chatAppSendBtn' },
};

const registry = new Map<AppId, ComposerSurface>();

/** Override composer elements for an app (e.g. tests or embedded hosts). */
export function registerComposerSurface(appId: AppId, surface: ComposerSurface): () => void {
  registry.set(appId, surface);
  return () => { if (registry.get(appId) === surface) registry.delete(appId); };
}

function resolveByIds(inputId: string, sendBtnId: string): ComposerSurface {
  return {
    inputEl: document.getElementById(inputId) as HTMLTextAreaElement | null,
    sendBtnEl: document.getElementById(sendBtnId) as HTMLButtonElement | null,
  };
}

function resolveComposerKey(): AppId {
  const foregroundAppId = getForegroundAppId();
  if (foregroundAppId === 'code') return 'code';
  return foregroundAppId ?? 'code';
}

/** Composer for the foreground Minnow app. */
export function getActiveComposerSurface(): ComposerSurface {
  if (isChatAppForeground()) {
    return resolveByIds(DEFAULT_IDS.chat!.inputId, DEFAULT_IDS.chat!.sendBtnId);
  }
  const key = resolveComposerKey();
  const registered = registry.get(key);
  if (registered) return registered;
  const ids = DEFAULT_IDS[key] ?? DEFAULT_IDS.code!;
  return resolveByIds(ids.inputId, ids.sendBtnId);
}

/** Merge explicit overrides with the active foreground composer. */
export function resolveComposerSurface(
  override?: Partial<ComposerSurface>,
): ComposerSurface {
  const active = getActiveComposerSurface();
  return {
    inputEl: override?.inputEl ?? active.inputEl,
    sendBtnEl: override?.sendBtnEl ?? active.sendBtnEl,
  };
}

/** Clear textarea value and reset auto-grow height when present. */
export function clearComposerInput(input: HTMLTextAreaElement | null | undefined): void {
  if (!input) return;
  input.value = '';
  input.style.height = '';
  input.style.overflowY = 'hidden';
  void import('./input').then((m) => m.autoResize(input));
  void import('./composer-prompt-history').then((m) => m.resetComposerPromptHistory());
}
