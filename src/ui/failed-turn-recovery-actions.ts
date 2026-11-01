import { createButton, setButtonClassName } from './components';
export interface FailedTurnRecoveryTarget {
  chatId: string;
  forkHistoryIndex: number;
  onRecover?: () => void;
}

/** Shared Continue / Clear pair used by the error bubble and the failed-turn chip. */
export function appendFailedTurnRecoveryActions(
  host: HTMLElement,
  recovery: FailedTurnRecoveryTarget,
): void {
  if (host.querySelector('.msg-error-recover-actions')) return;

  const actions = document.createElement('div');
  actions.className = 'msg-error-recover-actions';

  const continueBtn = createButton({ appearance: 'surface', variant: 'primary', size: 'sm' });
  continueBtn.type = 'button';
  setButtonClassName(continueBtn, 'msg-error-recover-btn msg-error-recover-btn--continue');
  continueBtn.textContent = 'Continue';
  continueBtn.title = 'Retry with the full conversation still in context';
  continueBtn.setAttribute(
    'aria-label',
    'Continue: retry the failed turn with the full conversation still in context',
  );

  const clearBtn = createButton({ appearance: 'surface', variant: 'danger', size: 'sm' });
  clearBtn.type = 'button';
  setButtonClassName(clearBtn, 'msg-error-recover-btn');
  clearBtn.textContent = 'Clear';
  clearBtn.title = 'Remove the failed reply and keep your message';
  clearBtn.setAttribute(
    'aria-label',
    'Clear: remove the failed reply and keep your message',
  );

  const disableBoth = (): void => {
    continueBtn.disabled = true;
    clearBtn.disabled = true;
  };

  continueBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    disableBoth();
    void import('../chat/failed-turn-recovery.ts').then((mod) =>
      mod.continueFailedTurn(recovery.chatId),
    );
    recovery.onRecover?.();
  });

  clearBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    disableBoth();
    void import('../chat/failed-turn-recovery.ts').then((mod) =>
      mod.clearFailedAssistantTurn(recovery.chatId, recovery.forkHistoryIndex),
    );
    recovery.onRecover?.();
  });

  actions.append(continueBtn, clearBtn);
  host.appendChild(actions);
}
