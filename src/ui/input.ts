import { scrollChatIfPinned } from './chat-scroll';
import { handleComposerPromptHistoryKeydown } from './composer-prompt-history';
import { handleSkillPickerKeydown, isSkillPickerOpen } from './skill-picker';
import { bindComposerAutoResize } from './composer-auto-resize';
import { isComposerQueueShortcut } from './composer-shortcuts';
import { createIconButton } from './components';

import {
  handleComposerPrimaryAction,
  initComposerSteerInputListener,
  setComposerStreamingMode,
  setSendLoading,
  submitComposerFollowup,
  shouldSubmitComposerOnEnter,
} from './composer-send';

export {
  handleComposerPrimaryAction,
  initComposerSteerInputListener,
  setComposerStreamingMode,
  setSendLoading,
};
export type { ComposerStreamingMode } from './composer-send';

export {
  autoResize,
  bindComposerAutoResize,
  composerFieldSizingSupported,
  setComposerFieldSizingSupportedForTests,
} from './composer-auto-resize';

/** Wire Code composer keydown, resize, steer, and draft listeners (idempotent). */
export function initComposerInput(el: HTMLTextAreaElement): void {
  const sendId = el.id === 'msgInput' ? 'sendBtn' : el.id === 'chatAppInput' ? 'chatAppSendBtn' : null;
  const send = sendId ? document.getElementById(sendId) as HTMLButtonElement | null : null;
  if (send && !send.classList.contains('mn-btn')) {
    createIconButton({ appearance: 'surface', element: send, icon: 'arrowUp', label: 'Send message', variant: 'primary', size: 'lg', tooltip: false });
  }
  if (el.id === 'msgInput') {
    const overflow = document.getElementById('btnComposerOverflow') as HTMLButtonElement | null;
    if (overflow && !overflow.classList.contains('mn-btn')) createIconButton({ appearance: 'surface', element: overflow, icon: 'settings', label: 'Composer settings', size: 'sm' });
  }
  bindComposerAutoResize(el);
  initComposerSteerInputListener(el);
  if (el.dataset.composerKeydownWired !== '1') {
    el.dataset.composerKeydownWired = '1';
    el.addEventListener('keydown', handleKey);
  }
  void import('./composer-draft').then((m) => m.initComposerDraftListener(el));
}

export function handleKey(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return;
  if (handleSkillPickerKeydown(e)) return;
  const input = e.target;
  if (
    input instanceof HTMLTextAreaElement &&
    handleComposerPromptHistoryKeydown(e, input)
  ) {
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    if (isSkillPickerOpen()) return;
    e.preventDefault();
    // Repeated Enter after a send must never turn into a Stop click.
    if (!(input instanceof HTMLTextAreaElement) || !shouldSubmitComposerOnEnter(input.value)) return;
    if (isComposerQueueShortcut(e)) {
      submitComposerFollowup('queue');
      return;
    }
    handleComposerPrimaryAction();
  }
}

/** Scroll chat to tail when pinned near bottom (legacy name for stream hot paths). */
export function scrollBottom(): void {
  scrollChatIfPinned();
}
