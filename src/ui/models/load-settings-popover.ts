import { el } from './dom';

let dismiss: (() => void) | null = null;

/** Move the existing controls into the top layer, keeping their state and IDs. */
export function openLoadSettingsPopover(inspector: HTMLElement, onClose: () => void): void {
  if (inspector.closest('.models-load-popover')) return;
  closeLoadSettingsPopover();
  const placeholder = document.createComment('model details panel');
  inspector.before(placeholder);
  const returnFocus = document.activeElement as HTMLElement | null;
  const page = document.getElementById('modelsView');
  const popover = el('div', 'models-load-popover');
  popover.id = 'modelsLoadSettingsPopover';
  popover.popover = 'auto';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-labelledby', 'modelsLoadSettingsTitle');
  (page ?? document.body).appendChild(popover);
  popover.appendChild(inspector);
  page?.classList.add('is-load-settings-open');

  let closed = false;
  const close = (): void => {
    if (closed) return;
    const connected = popover.isConnected;
    closed = true;
    dismiss = null;
    if (connected && typeof popover.hidePopover === 'function') popover.hidePopover();
    if (placeholder.isConnected) placeholder.replaceWith(inspector);
    popover.remove();
    page?.classList.remove('is-load-settings-open');
    if (connected) {
      onClose();
      if (returnFocus?.isConnected) returnFocus.focus();
      else (returnFocus?.id ? document.getElementById(returnFocus.id) : null)?.focus();
      if (!document.activeElement || document.activeElement === document.body) {
        document.getElementById('btnModelsInspector')?.focus();
      }
    }
  };
  dismiss = close;
  popover.addEventListener('toggle', (event) => {
    if ((event as ToggleEvent).newState === 'closed') close();
  });
  popover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(popover.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
    )).filter((node) => node.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  if (typeof popover.showPopover === 'function') popover.showPopover();
}

export function closeLoadSettingsPopover(): void {
  dismiss?.();
}
