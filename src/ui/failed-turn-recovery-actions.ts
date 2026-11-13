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

  const continueBtn = document.createElement('button');
  continueBtn.type = 'button';
  continueBtn.className = 'msg-error-recover-btn msg-error-recover-btn--continue';
  continueBtn.textContent = 'Continue';
  continueBtn.title = 'Retry with the full conversation still in context';
  continueBtn.setAttribute(
    'aria-label',
    'Continue: retry the failed turn with the full conversation still in context',
  );

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'msg-error-recover-btn';
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

  const threadHeader = document.getElementById('graphiteThreadHeader');
  if (threadHeader && !threadHeader.hidden) {
    const fork = document.createElement('button');
    fork.type = 'button';
    fork.className = 'msg-error-recover-btn';
    fork.textContent = 'Fork';
    fork.title = 'Open a separate thread from this conversation';
    fork.addEventListener('click', event => {
      event.stopPropagation();
      void import('../state/sessions').then(async ({ findChatById, sessionState }) => {
        if (sessionState?.activeId !== recovery.chatId) return;
        const chat = findChatById(recovery.chatId);
        if (chat) await (await import('./thread-card')).forkThreadWithModel(chat);
      });
    });
    actions.append(continueBtn, fork, clearBtn);
  } else {
    actions.append(continueBtn, clearBtn);
  }
  host.appendChild(actions);
}
