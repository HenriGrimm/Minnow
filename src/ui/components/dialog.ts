/**
 * Modal dialogs with custom content. For one-line alert/confirm/prompt flows,
 * `appAlert`/`appConfirm`/`appPrompt` in `src/ui/app-dialog.ts` stay the API.
 *
 * Built as a fixed overlay on `--mn-z-dialog` rather than `<dialog>.showModal()`:
 * the top layer would sit above every menu and toast in the app.
 */

import '../../styles/components/dialog.css';
import { createButton, createIconButton, setButtonBusy, type ButtonVariant } from './button';
import {
  addClassNames,
  focusableWithin,
  markOverlayRoot,
  nextComponentId,
  trapTabKey,
  unmarkOverlayRoot,
} from './internal';

export interface DialogAction {
  id: string;
  label: string;
  /** Default `secondary`. Use one `primary` (or `danger`) per dialog. */
  variant?: ButtonVariant;
  /** Receive initial focus (for destructive confirms, put it on Cancel). */
  autoFocus?: boolean;
  /** Return (or resolve) `false` to keep the dialog open. */
  run?: () => boolean | void | Promise<boolean | void>;
}

export interface DialogOptions {
  title: string;
  description?: string;
  body?: HTMLElement | string;
  actions?: DialogAction[];
  /** sm 360px, md 28rem (default), lg 640px. */
  size?: 'sm' | 'md' | 'lg';
  /** Escape, the scrim and the close button dismiss it. Default true. */
  dismissible?: boolean;
  /** Default: same as `dismissible`. */
  closeButton?: boolean;
  initialFocus?: HTMLElement;
  className?: string;
  /** Action id, or `null` when dismissed. */
  onClose?: (result: string | null) => void;
}

export interface DialogHandle {
  overlay: HTMLDivElement;
  panel: HTMLDivElement;
  body: HTMLDivElement;
  footer: HTMLDivElement;
  close(result?: string | null): void;
  /** Resolves with the action id, or `null` when dismissed. */
  closed: Promise<string | null>;
  /** Disable every action and the close button while work runs. */
  setBusy(busy: boolean): void;
}

interface OpenDialog {
  handle: DialogHandle;
  dismissible: boolean;
}

const openDialogs: OpenDialog[] = [];
let keydownBound = false;

function onKeydown(event: KeyboardEvent): void {
  const top = openDialogs[openDialogs.length - 1];
  if (!top) return;
  if (event.key === 'Escape') {
    if (!top.dismissible) return;
    event.preventDefault();
    top.handle.close(null);
    return;
  }
  trapTabKey(top.handle.panel, event);
}

function syncKeydown(): void {
  if (openDialogs.length > 0 && !keydownBound) {
    document.addEventListener('keydown', onKeydown);
    keydownBound = true;
  } else if (openDialogs.length === 0 && keydownBound) {
    document.removeEventListener('keydown', onKeydown);
    keydownBound = false;
  }
}

export function openDialog(options: DialogOptions): DialogHandle {
  const dismissible = options.dismissible !== false;
  const titleId = nextComponentId('dialog-title');

  const overlay = document.createElement('div');
  overlay.className = 'mn-dialog-overlay';

  const panel = document.createElement('div');
  panel.className = `mn-dialog mn-dialog--${options.size ?? 'md'}`;
  addClassNames(panel, options.className);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', titleId);
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'mn-dialog__header';
  const title = document.createElement('h2');
  title.className = 'mn-dialog__title';
  title.id = titleId;
  title.textContent = options.title;
  header.appendChild(title);

  const body = document.createElement('div');
  body.className = 'mn-dialog__body';
  if (options.description) {
    const description = document.createElement('p');
    description.className = 'mn-dialog__description';
    description.id = nextComponentId('dialog-description');
    description.textContent = options.description;
    panel.setAttribute('aria-describedby', description.id);
    body.appendChild(description);
  }
  if (typeof options.body === 'string') {
    const text = document.createElement('p');
    text.className = 'mn-dialog__text';
    text.textContent = options.body;
    body.appendChild(text);
  } else if (options.body) {
    body.appendChild(options.body);
  }
  body.hidden = body.childElementCount === 0;

  const footer = document.createElement('div');
  footer.className = 'mn-dialog__footer';

  let resolveClosed!: (result: string | null) => void;
  const closed = new Promise<string | null>((resolve) => {
    resolveClosed = resolve;
  });
  const previousFocus = document.activeElement as HTMLElement | null;
  let isClosed = false;
  let busy = false;
  const controls: HTMLButtonElement[] = [];

  const close = (result: string | null = null) => {
    if (isClosed) return;
    isClosed = true;
    const index = openDialogs.findIndex((entry) => entry.handle === handle);
    if (index >= 0) openDialogs.splice(index, 1);
    syncKeydown();
    overlay.remove();
    unmarkOverlayRoot(overlay);
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
    options.onClose?.(result);
    resolveClosed(result);
  };

  const setBusy = (next: boolean) => {
    busy = next;
    for (const control of controls) {
      if (!control.classList.contains('mn-btn--busy')) control.disabled = next;
    }
  };

  if (options.closeButton ?? dismissible) {
    const closeButton = createIconButton({
      icon: 'close',
      label: 'Close',
      size: 'sm',
      className: 'mn-dialog__close',
      onClick: () => close(null),
    });
    controls.push(closeButton);
    header.appendChild(closeButton);
  }

  let autoFocusTarget: HTMLButtonElement | null = null;
  for (const action of options.actions ?? []) {
    const button = createButton({ label: action.label, variant: action.variant ?? 'secondary' });
    button.dataset.dialogAction = action.id;
    button.addEventListener('click', () => {
      if (busy) return;
      const outcome = action.run?.();
      if (outcome instanceof Promise) {
        setBusy(true);
        setButtonBusy(button, true);
        outcome.then(
          (value) => {
            setButtonBusy(button, false);
            setBusy(false);
            if (value !== false) close(action.id);
          },
          (error: unknown) => {
            setButtonBusy(button, false);
            setBusy(false);
            console.error('[dialog] action failed', error);
          },
        );
        return;
      }
      if (outcome !== false) close(action.id);
    });
    if (action.autoFocus) autoFocusTarget = button;
    controls.push(button);
    footer.appendChild(button);
  }
  footer.hidden = footer.childElementCount === 0;

  panel.append(header, body, footer);
  overlay.appendChild(panel);

  // Only a press that starts and ends on the scrim dismisses, so a text
  // selection dragged out of the panel does not close it.
  let pressStartedOnScrim = false;
  overlay.addEventListener('pointerdown', (event) => {
    pressStartedOnScrim = event.target === overlay;
  });
  overlay.addEventListener('click', (event) => {
    if (dismissible && pressStartedOnScrim && event.target === overlay) close(null);
    pressStartedOnScrim = false;
  });

  const handle: DialogHandle = { overlay, panel, body, footer, close, closed, setBusy };
  openDialogs.push({ handle, dismissible });
  syncKeydown();

  document.body.appendChild(overlay);
  markOverlayRoot(overlay, 'dialog');

  const focusTarget =
    options.initialFocus ??
    autoFocusTarget ??
    focusableWithin(body)[0] ??
    footer.querySelector<HTMLButtonElement>('button') ??
    panel;
  focusTarget.focus();

  return handle;
}

/** Close every open dialog, topmost first (tests and teardown). */
export function closeAllDialogs(): void {
  for (let i = openDialogs.length - 1; i >= 0; i -= 1) openDialogs[i]?.handle.close(null);
}

export function isDialogOpen(): boolean {
  return openDialogs.length > 0;
}
