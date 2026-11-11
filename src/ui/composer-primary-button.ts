import { createIcon } from './icon';

export function createComposerPrimaryButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'send-btn';
  const send = document.createElement('span');
  send.className = 'send-btn__send-icon';
  send.append(createIcon('composerSend', { className: 'send-btn__arrow' }));
  const stop = document.createElement('span');
  stop.className = 'send-btn__stop-icon hidden';
  const square = document.createElement('span');
  square.className = 'send-btn__stop';
  square.setAttribute('aria-hidden', 'true');
  stop.append(square);
  button.append(send, stop);
  return button;
}

/** Paint the same primary control in each composer, independent of turn ownership. */
export function paintComposerPrimaryButton(button: HTMLButtonElement, busy: boolean, stopping: boolean): void {
  const label = stopping ? 'Stop generating' : 'Send message';
  button.dataset.mode = busy ? 'stop' : 'send';
  button.classList.toggle('send-btn--stop', stopping);
  button.setAttribute('aria-busy', String(busy));
  button.setAttribute('aria-label', label);
  button.title = stopping ? label : 'Send message (Enter)';
  button.querySelector('.send-btn__send-icon, #sendIcon')?.classList.toggle('hidden', stopping);
  button.querySelector('.send-btn__stop-icon, #sendStopIcon')?.classList.toggle('hidden', !stopping);
}
