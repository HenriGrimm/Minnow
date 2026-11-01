import { createButton } from './components';
import { getStreamingChatId, isActiveChatStreaming } from '../chat/streaming-state';
import { findChatById } from '../state/sessions';
import { isChatAppForeground } from './chat-mount';

/** Ensure the background-stream hint element exists under the composer. */
function ensureBackgroundStreamHintEl(): HTMLElement {
  let el = document.getElementById('composerBackgroundStreamHint');
  if (el) return el;

  el = document.createElement('p');
  el.id = 'composerBackgroundStreamHint';
  el.className = 'composer-background-stream-hint hidden';
  el.setAttribute('role', 'status');

  const host =
    document.querySelector('.chat-app-composer') ??
    document.querySelector('.input-bar-composer');
  if (host) {
    host.insertBefore(el, host.firstChild);
  } else {
    document.body.appendChild(el);
  }
  return el;
}

/** Show or hide "reply in progress elsewhere" and wire optional jump link. */
export function syncBackgroundStreamHint(): void {
  const hint = ensureBackgroundStreamHintEl();
  const streamId = getStreamingChatId();

  if (!streamId || isActiveChatStreaming()) {
    hint.classList.add('hidden');
    hint.textContent = '';
    hint.replaceChildren();
    return;
  }

  const name = findChatById(streamId)?.name?.trim() || 'Another chat';
  hint.classList.remove('hidden');
  hint.replaceChildren();

  const text = document.createElement('span');
  text.textContent = `Reply in progress in ${name}. `;
  hint.appendChild(text);

  const link = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm', className: 'composer-background-stream-hint__link', label: 'Go to chat' });
  link.addEventListener('click', () => {
    if (isChatAppForeground()) {
      void import('./chat-app').then((m) => m.activateChatAppThread(streamId));
      return;
    }
    void import('./sidebar').then((m) => m.switchChat(streamId));
  });
  hint.appendChild(link);
}
