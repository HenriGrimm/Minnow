import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';

export interface AppDialogButton {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface AppConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Extra content rendered under the message (e.g. an itemized list). */
  body?: HTMLElement;
}

export interface AppPromptOptions {
  title?: string;
  message: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  placeholder?: string;
}

/** Multi-button dialog with an optional remember-style checkbox. */
export interface AppChoiceOptions {
  title?: string;
  message: string;
  body?: HTMLElement;
  buttons: AppDialogButton[];
  /** Escape and overlay-cancel map to this button id (default `cancel`). */
  cancelId?: string;
  /** Which action receives initial focus. */
  defaultFocusId?: string;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
}

export interface AppChoiceResult {
  id: string;
  checkboxChecked: boolean;
}

type DialogKind = 'alert' | 'confirm' | 'prompt' | 'choice';

type PendingDialog =
  | { kind: 'alert'; resolve: () => void }
  | { kind: 'confirm'; resolve: (value: boolean) => void }
  | { kind: 'prompt'; resolve: (value: string | null) => void }
  | { kind: 'choice'; resolve: (value: AppChoiceResult) => void; cancelId: string };

const OVERLAY_ID = 'appDialogOverlay';
const PANEL_ID = 'appDialogPanel';
const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

let overlayEl: HTMLDivElement | null = null;
let panelEl: HTMLDivElement | null = null;
let titleEl: HTMLHeadingElement | null = null;
let messageEl: HTMLParagraphElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let footerEl: HTMLElement | null = null;
let checkboxRowEl: HTMLLabelElement | null = null;
let checkboxEl: HTMLInputElement | null = null;
let checkboxTextEl: HTMLSpanElement | null = null;
let actionsEl: HTMLElement | null = null;
let open = false;
let previousFocus: HTMLElement | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;
let trapFocusHandler: ((e: KeyboardEvent) => void) | null = null;

let dialogChain: Promise<void> = Promise.resolve();
let pending: PendingDialog | null = null;

function getActiveHTMLElement(): HTMLElement | null {
  const active = document.activeElement;
  if (!active || typeof (active as HTMLElement).focus !== 'function') return null;
  return active as HTMLElement;
}

function enqueueDialog<T>(run: () => Promise<T>): Promise<T> {
  const next = dialogChain.then(() => run());
  dialogChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function ensureShell(): void {
  if (overlayEl && panelEl) return;

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  overlayEl.className = 'app-dialog-overlay hidden';
  overlayEl.dataset.aboveShellOverlay = '';
  overlayEl.hidden = true;

  panelEl = document.createElement('div');
  panelEl.id = PANEL_ID;
  panelEl.className = 'app-dialog-panel';
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-modal', 'true');
  panelEl.tabIndex = -1;

  titleEl = document.createElement('h2');
  titleEl.className = 'app-dialog-panel__title';
  titleEl.id = 'appDialogTitle';

  messageEl = document.createElement('p');
  messageEl.className = 'app-dialog-panel__message';

  bodyEl = document.createElement('div');
  bodyEl.className = 'app-dialog-panel__body';
  bodyEl.hidden = true;

  inputEl = document.createElement('input');
  inputEl.type = 'text';
  inputEl.className = 'app-dialog-panel__input';
  inputEl.hidden = true;

  footerEl = document.createElement('div');
  footerEl.className = 'app-dialog-panel__footer';

  checkboxRowEl = document.createElement('label');
  checkboxRowEl.className = 'app-dialog-panel__remember';
  checkboxRowEl.hidden = true;

  checkboxEl = document.createElement('input');
  checkboxEl.type = 'checkbox';
  checkboxEl.id = 'appDialogRemember';
  checkboxRowEl.htmlFor = checkboxEl.id;

  checkboxTextEl = document.createElement('span');
  checkboxRowEl.append(checkboxEl, checkboxTextEl);

  actionsEl = document.createElement('div');
  actionsEl.className = 'app-dialog-panel__actions';

  footerEl.append(checkboxRowEl, actionsEl);
  panelEl.append(titleEl, messageEl, bodyEl, inputEl, footerEl);
  overlayEl.appendChild(panelEl);
  document.body.appendChild(overlayEl);

  panelEl.setAttribute('aria-labelledby', titleEl.id);
}

function detachListeners(): void {
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
  if (trapFocusHandler) {
    document.removeEventListener('keydown', trapFocusHandler, true);
    trapFocusHandler = null;
  }
}

function trapFocus(e: KeyboardEvent): void {
  if (!panelEl || e.key !== 'Tab') return;
  const nodes = [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true',
  );
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function closeDialog(): void {
  if (!open) return;
  open = false;
  detachListeners();
  overlayEl!.hidden = true;
  overlayEl!.classList.add('hidden');
  unmarkPreviewOccluder(overlayEl!);
  previousFocus?.focus();
  previousFocus = null;
  actionsEl?.replaceChildren();
  if (bodyEl) {
    bodyEl.replaceChildren();
    bodyEl.hidden = true;
  }
  if (inputEl) {
    inputEl.hidden = true;
    inputEl.value = '';
  }
  if (checkboxRowEl) checkboxRowEl.hidden = true;
  if (checkboxEl) checkboxEl.checked = false;
}

function settleDialog(): void {
  pending = null;
  closeDialog();
}

function createActionButton(button: AppDialogButton): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'app-dialog-panel__btn';
  if (button.primary) btn.classList.add('app-dialog-panel__btn--primary');
  if (button.danger) btn.classList.add('app-dialog-panel__btn--danger');
  btn.textContent = button.label;
  btn.dataset.dialogAction = button.id;
  return btn;
}

function openDialogShell(
  kind: DialogKind,
  title: string,
  message: string,
  body?: HTMLElement,
): void {
  ensureShell();
  if (!overlayEl || !panelEl || !titleEl || !messageEl || !actionsEl) return;

  previousFocus = getActiveHTMLElement();

  titleEl.textContent = title;
  messageEl.textContent = message;
  if (bodyEl) {
    bodyEl.replaceChildren(...(body ? [body] : []));
    bodyEl.hidden = !body;
  }
  panelEl.dataset.dialogKind = kind;

  open = true;
  overlayEl.hidden = false;
  overlayEl.classList.remove('hidden');
  document.body.appendChild(overlayEl);
  // The dimmed backdrop covers the whole window, so the preview pauses behind it.
  markPreviewOccluder(overlayEl, 'dialog');

  escapeHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !pending) return;
    e.preventDefault();
    if (pending.kind === 'alert') {
      pending.resolve();
      settleDialog();
      return;
    }
    if (pending.kind === 'confirm') {
      pending.resolve(false);
      settleDialog();
      return;
    }
    if (pending.kind === 'choice') {
      pending.resolve({
        id: pending.cancelId,
        checkboxChecked: checkboxEl?.checked === true,
      });
      settleDialog();
      return;
    }
    pending.resolve(null);
    settleDialog();
  };
  trapFocusHandler = trapFocus;
  document.addEventListener('keydown', escapeHandler, true);
  document.addEventListener('keydown', trapFocusHandler, true);
}

function renderButtons(buttons: AppDialogButton[], onAction: (id: string) => void): void {
  if (!actionsEl) return;
  actionsEl.replaceChildren();
  for (const button of buttons) {
    const el = createActionButton(button);
    el.addEventListener('click', () => onAction(button.id));
    actionsEl.appendChild(el);
  }
}

function showAlertDialog(message: string, title = 'Notice'): Promise<void> {
  return enqueueDialog(
    () =>
      new Promise((resolve) => {
        pending = { kind: 'alert', resolve: () => resolve() };
        openDialogShell('alert', title, message);
        renderButtons([{ id: 'ok', label: 'OK', primary: true }], (id) => {
          if (id !== 'ok' || pending?.kind !== 'alert') return;
          pending.resolve();
          settleDialog();
        });
        actionsEl?.querySelector<HTMLButtonElement>('[data-dialog-action="ok"]')?.focus();
      }),
  );
}

function showConfirmDialog(options: AppConfirmOptions): Promise<boolean> {
  const title = options.title ?? 'Confirm';
  const confirmLabel = options.confirmLabel ?? 'OK';
  const cancelLabel = options.cancelLabel ?? 'Cancel';

  return enqueueDialog(
    () =>
      new Promise((resolve) => {
        pending = { kind: 'confirm', resolve };
        openDialogShell('confirm', title, options.message, options.body);
        renderButtons(
          [
            { id: 'cancel', label: cancelLabel },
            {
              id: 'confirm',
              label: confirmLabel,
              primary: !options.danger,
              danger: options.danger,
            },
          ],
          (id) => {
            if (pending?.kind !== 'confirm') return;
            pending.resolve(id === 'confirm');
            settleDialog();
          },
        );
        const focusTarget =
          options.danger
            ? actionsEl?.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')
            : actionsEl?.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]');
        focusTarget?.focus();
      }),
  );
}

function showPromptDialog(options: AppPromptOptions): Promise<string | null> {
  const title = options.title ?? 'Input required';
  const confirmLabel = options.confirmLabel ?? 'OK';
  const cancelLabel = options.cancelLabel ?? 'Cancel';

  return enqueueDialog(
    () =>
      new Promise((resolve) => {
        pending = { kind: 'prompt', resolve };
        openDialogShell('prompt', title, options.message);
        if (inputEl) {
          inputEl.hidden = false;
          inputEl.value = options.defaultValue ?? '';
          inputEl.placeholder = options.placeholder ?? '';
          inputEl.onkeydown = (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              actionsEl
                ?.querySelector<HTMLButtonElement>('[data-dialog-action="confirm"]')
                ?.click();
            }
          };
        }
        renderButtons(
          [
            { id: 'cancel', label: cancelLabel },
            { id: 'confirm', label: confirmLabel, primary: true },
          ],
          (id) => {
            if (pending?.kind !== 'prompt') return;
            if (id === 'cancel') {
              pending.resolve(null);
              settleDialog();
              return;
            }
            pending.resolve(inputEl?.value.trim() ?? '');
            settleDialog();
          },
        );
        inputEl?.focus();
        inputEl?.select();
      }),
  );
}

/** Show an informational alert. */
export function appAlert(message: string, title?: string): Promise<void> {
  return showAlertDialog(message, title);
}

/** Ask the user to confirm an action. */
export function appConfirm(message: string, options?: Omit<AppConfirmOptions, 'message'>): Promise<boolean> {
  return showConfirmDialog({ message, ...options });
}

/** Ask the user for a short text value. */
export function appPrompt(
  message: string,
  defaultValue?: string,
  options?: Omit<AppPromptOptions, 'message' | 'defaultValue'>,
): Promise<string | null> {
  return showPromptDialog({ message, defaultValue, ...options });
}

/** Ask the user to pick one of several actions. */
export function appChoice(options: AppChoiceOptions): Promise<AppChoiceResult> {
  return showChoiceDialog(options);
}

function showChoiceDialog(options: AppChoiceOptions): Promise<AppChoiceResult> {
  const title = options.title ?? 'Confirm';
  const cancelId = options.cancelId ?? 'cancel';
  const buttons = options.buttons.filter((button) => button.id.trim());
  if (buttons.length === 0) {
    return Promise.resolve({ id: cancelId, checkboxChecked: false });
  }

  return enqueueDialog(
    () =>
      new Promise((resolve) => {
        pending = { kind: 'choice', resolve, cancelId };
        openDialogShell('choice', title, options.message, options.body);
        if (checkboxRowEl && checkboxEl && checkboxTextEl) {
          const label = options.checkboxLabel?.trim() ?? '';
          checkboxRowEl.hidden = !label;
          checkboxTextEl.textContent = label;
          checkboxEl.checked = options.checkboxChecked === true;
        }
        renderButtons(buttons, (id) => {
          if (pending?.kind !== 'choice') return;
          pending.resolve({
            id,
            checkboxChecked: checkboxEl?.checked === true,
          });
          settleDialog();
        });
        const focusId = options.defaultFocusId ?? buttons[0]?.id;
        actionsEl
          ?.querySelector<HTMLButtonElement>(`[data-dialog-action="${cssEscapeAttr(focusId)}"]`)
          ?.focus();
      }),
  );
}

function cssEscapeAttr(value: string | undefined): string {
  if (!value) return '';
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Whether an app dialog is currently open. */
export function isAppDialogOpen(): boolean {
  return open;
}

type NativeDialogs = {
  alert: (message?: unknown) => void;
  confirm: (message?: string) => boolean;
  prompt: (message?: string, defaultValue?: string) => string | null;
};

const installedWindows = new Set<Window>();

function captureNativeDialogs(targetWindow: Window): NativeDialogs {
  const fallbackAlert = () => {};
  const fallbackConfirm = () => false;
  const fallbackPrompt = () => null;
  return {
    alert:
      typeof targetWindow.alert === 'function'
        ? targetWindow.alert.bind(targetWindow)
        : fallbackAlert,
    confirm:
      typeof targetWindow.confirm === 'function'
        ? targetWindow.confirm.bind(targetWindow)
        : fallbackConfirm,
    prompt:
      typeof targetWindow.prompt === 'function'
        ? targetWindow.prompt.bind(targetWindow)
        : fallbackPrompt,
  };
}

export function installAppDialogs(targetWindow: Window = window): void {
  if (installedWindows.has(targetWindow)) return;

  const native = captureNativeDialogs(targetWindow);

  const useInAppDialogs = (): boolean => Boolean(targetWindow.minnow?.app?.isElectron);

  targetWindow.alert = (message?: unknown): void => {
    if (!useInAppDialogs()) {
      native.alert(message);
      return;
    }
    void showAlertDialog(String(message ?? ''));
  };

  targetWindow.confirm = (message?: string): boolean => {
    if (!useInAppDialogs()) {
      return native.confirm(message);
    }
    void showConfirmDialog({ message: message ?? '' });
    console.warn(
      '[Minnow] Synchronous window.confirm() cannot block for in-app dialogs. Use await appConfirm() instead.',
    );
    return false;
  };

  targetWindow.prompt = (message?: string, defaultValue?: string): string | null => {
    if (!useInAppDialogs()) {
      return native.prompt(message, defaultValue);
    }
    void showPromptDialog({ message: message ?? '', defaultValue: defaultValue ?? '' });
    console.warn(
      '[Minnow] Synchronous window.prompt() cannot block for in-app dialogs. Use await appPrompt() instead.',
    );
    return null;
  };

  installedWindows.add(targetWindow);
}

/** Reset dialog state (tests). */
export function resetAppDialogForTests(): void {
  closeDialog();
  pending = null;
  dialogChain = Promise.resolve();
  open = false;
  installedWindows.clear();
  overlayEl?.remove();
  overlayEl = null;
  panelEl = null;
  titleEl = null;
  messageEl = null;
  bodyEl = null;
  inputEl = null;
  footerEl = null;
  checkboxRowEl = null;
  checkboxEl = null;
  checkboxTextEl = null;
  actionsEl = null;
}
