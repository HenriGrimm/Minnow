import { createButton, setButtonClassName } from './components';
import type { Chat } from '../types';
import { CONTINUE_AFTER_TRUNCATION_INSTRUCTION } from '../tools/turn-continuation';

/** Length-truncation label and Continue action on an assistant message row. */
export function markMessageTruncated(wrap: HTMLElement, chat: Chat): void {
  wrap.classList.add('msg--truncated');
  if (wrap.querySelector('.msg-truncated-chip')) return;
  const chip = document.createElement('div');
  chip.className = 'msg-truncated-chip';

  const label = document.createElement('span');
  label.textContent = 'Response truncated';
  chip.appendChild(label);

  const action = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  action.type = 'button';
  setButtonClassName(action, 'msg-truncated-continue-btn');
  action.textContent = 'Continue';
  action.addEventListener('click', () => {
    action.disabled = true;
    void import('../chat/run-turn-chat').then(({ runChatTurn }) =>
      runChatTurn({
        chat,
        pushUser: false,
        rawText: '',
        userText: '',
        skillId: null,
        displayText: '',
        historyContent: '',
        validAttachments: [],
        ephemeralContinueInstruction: CONTINUE_AFTER_TRUNCATION_INSTRUCTION,
        ownsGlobalStreaming: true,
      }),
    );
  });
  chip.appendChild(action);

  const msgLabel = wrap.querySelector('.msg-label');
  if (msgLabel?.parentElement === wrap) {
    msgLabel.insertAdjacentElement('afterend', chip);
  } else {
    wrap.prepend(chip);
  }
}
