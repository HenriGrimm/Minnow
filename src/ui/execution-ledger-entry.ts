import { iconHtml } from './icon';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ensureButton(): HTMLButtonElement | null {
  if (typeof document === 'undefined') return null;
  const existing = document.getElementById('btnExecutionLedger');
  if (existing instanceof HTMLButtonElement) return existing;
  const views = document.getElementById('codeViews');
  if (!views) return null;
  const button = el('button', 'code-views__btn') as HTMLButtonElement;
  button.id = 'btnExecutionLedger';
  button.type = 'button';
  button.title = 'Execution ledger';
  button.setAttribute('aria-label', 'Execution ledger');
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = iconHtml('brainLog');
  const track = el('span', 'code-views__label-track');
  track.append(el('span', 'code-views__label', 'Execution'));
  button.append(track);
  const orchestrate = document.getElementById('btnOrchestrate');
  views.insertBefore(button, orchestrate ?? null);
  return button;
}

let initialized = false;

/** Add the Code view-bar entry without loading the ledger projection until it is opened. */
export function initExecutionLedgerEntry(): void {
  if (initialized) return;
  initialized = true;
  ensureButton()?.addEventListener('click', () => {
    void import('./execution-ledger').then((ledger) => {
      if (ledger.isExecutionLedgerOpen()) {
        ledger.closeExecutionLedger();
        return;
      }
      void ledger.openExecutionLedger();
    });
  });
}
