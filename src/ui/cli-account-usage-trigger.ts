import { agentCliUsageKind } from '../models/agent-clis';
import { accountUsageSummary, createAccountUsageView, type AccountUsageView } from './cli-account-usage';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';

/** A separate button keeps model selection and quota inspection independently accessible. */
export function createAccountUsageTrigger() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cli-account-usage-trigger';
  button.hidden = true;
  button.textContent = 'Usage';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  const popover = document.createElement('div');
  popover.className = 'cli-account-usage-popover';
  popover.popover = 'auto';
  popover.setAttribute('role', 'dialog');
  let kind: 'codex' | 'claude' | null = null;
  let view: AccountUsageView | null = null;
  let registered = false;

  function close(): void {
    if (popover.isConnected) popover.hidePopover();
    if (registered) { unregisterChromePopover(); registered = false; }
    button.setAttribute('aria-expanded', 'false');
  }
  popover.addEventListener('toggle', event => {
    const open = (event as ToggleEvent).newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    if (!open && registered) { unregisterChromePopover(); registered = false; }
  });
  button.addEventListener('click', () => {
    if (!view) return;
    if (button.getAttribute('aria-expanded') === 'true') { close(); return; }
    if (!popover.isConnected) document.body.append(popover);
    const rect = button.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    popover.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    popover.showPopover();
    const height = popover.getBoundingClientRect().height;
    popover.style.top = `${Math.max(12, Math.min(rect.top - height - 8, window.innerHeight - height - 12))}px`;
    registerChromePopover();
    registered = true;
    button.setAttribute('aria-expanded', 'true');
    void view.refresh();
    popover.querySelector<HTMLButtonElement>('button')?.focus();
  });

  return {
    button,
    setProvider(providerId: string | undefined) {
      const next = agentCliUsageKind(providerId);
      if (next === kind) { if (button.isConnected) view?.start(); return; }
      close();
      view?.stop();
      view = null;
      kind = next;
      button.hidden = !kind;
      button.textContent = 'Usage';
      popover.replaceChildren();
      if (!kind) return;
      const name = kind === 'codex' ? 'Codex' : 'Claude';
      popover.setAttribute('aria-label', `${name} account usage`);
      button.setAttribute('aria-label', `${name} account usage`);
      view = createAccountUsageView(kind, {
        visible: () => button.isConnected && Boolean(button.getClientRects().length)
          && Boolean(button.closest('.composer-model-trigger-wrap')?.getClientRects().length),
        onChange(usage) {
          button.textContent = usage?.windows.length ? accountUsageSummary(usage).replace(' · last known', '*') : 'Usage';
          button.title = `${name} account usage: ${accountUsageSummary(usage)}`;
        },
      });
      popover.append(view.root);
      if (!popover.isConnected) document.body.append(popover);
      if (button.isConnected) view.start();
    },
    dispose() { close(); view?.stop(); popover.remove(); },
  };
}
