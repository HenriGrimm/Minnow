/** Bottom sheets: the phone app's menus, pickers and detail panels. */

import { el, haptic, icon } from './dom';
import { getMobileWorkspaceScope } from './nav';
import { markPreviewOccluder, unmarkPreviewOccluder } from '../ui/preview-occlusion';

export interface SheetHandle {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
}

export interface SheetOptions {
  title?: string;
  /** Tall sheets fill most of the screen (task details, long forms). */
  tall?: boolean;
  placement?: 'bottom' | 'left';
  onClose?: () => void;
}

const openSheets = new Map<() => void, HTMLElement>();
let sheetSequence = 0;

function syncSheetStack(): void {
  const top = Array.from(openSheets.values()).at(-1);
  document.documentElement.classList.toggle('m-sheet-open', Boolean(top));
  for (const node of document.querySelectorAll<HTMLElement>('#mobileShell .m-stage')) {
    node.inert = Boolean(top);
  }
  for (const node of openSheets.values()) node.inert = node !== top;
}

export function closeMobileSheets(): void {
  for (const close of [...openSheets.keys()].reverse()) close();
}

/** Open a modal bottom sheet. Swipe down on the handle, tap the scrim or Escape to close. */
export function openSheet(content: HTMLElement | HTMLElement[], options: SheetOptions = {}): SheetHandle {
  const body = el('div', { className: 'm-sheet__body' });
  body.append(...(Array.isArray(content) ? content : [content]));
  const handle = el('div', { className: 'm-sheet__handle', attrs: { 'aria-hidden': 'true' } });
  const titleId = `m-sheet-title-${++sheetSequence}`;
  const titleEl = options.title
    ? el('h2', { className: 'm-sheet__title', text: options.title, attrs: { id: titleId } })
    : null;
  const closeButton = el(
    'button',
    { className: 'm-sheet__close', attrs: { type: 'button', 'aria-label': 'Close' } },
    icon('fi-rr-cross-small', 16),
  );
  const isDrawer = options.placement === 'left';
  const header = el('div', { className: 'm-sheet__header' }, titleEl, closeButton);
  const panel = el(
    'div',
    {
      className: `m-sheet__panel${options.tall ? ' m-sheet__panel--tall' : ''}`,
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': options.title ? titleId : null,
        'aria-label': options.title ? null : 'Details',
        tabindex: '-1',
      },
    },
    isDrawer ? null : handle,
    header,
    body,
  );
  const scrim = el('div', { className: 'm-sheet__scrim' });
  const root = el('div', { className: `m-sheet${isDrawer ? ' m-sheet--drawer' : ''}` }, scrim, panel);
  const previousFocus = document.activeElement as HTMLElement | null;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const restoreFocus = !root.inert && root.contains(document.activeElement);
    openSheets.delete(close);
    root.inert = true;
    unmarkPreviewOccluder(root);
    syncSheetStack();
    document.removeEventListener('keydown', onKey, true);
    root.classList.remove('is-open');
    if (restoreFocus && previousFocus?.isConnected && !previousFocus.closest('[inert], [hidden]')) {
      previousFocus.focus({ preventScroll: true });
    }
    const finish = () => {
      root.remove();
      options.onClose?.();
    };
    if (document.documentElement.hasAttribute('data-reduce-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else window.setTimeout(finish, 180);
  };
  const onKey = (event: KeyboardEvent) => {
    if (root.inert) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
    )).filter((node) => !node.closest('[hidden], [inert]') && node.tabIndex >= 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      panel.focus();
      return;
    }
    if (!focusable.includes(document.activeElement as HTMLElement) || document.activeElement === (event.shiftKey ? first : last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
  scrim.addEventListener('click', close);
  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);

  // Only the handle and header initiate a drag. The body scrolls independently.
  let dragStart: number | null = null;
  let dragDelta = 0;
  const dragZone = (event: TouchEvent) => {
    const target = event.target instanceof Node ? event.target : null;
    if (isDrawer || !target) return false;
    return handle.contains(target) || (header.contains(target) && !closeButton.contains(target));
  };
  panel.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1 || !dragZone(event)) return;
      dragStart = event.touches[0]!.clientY;
      dragDelta = 0;
    },
    { passive: true },
  );
  panel.addEventListener(
    'touchmove',
    (event) => {
      if (dragStart == null || event.touches.length !== 1) return;
      dragDelta = Math.max(0, event.touches[0]!.clientY - dragStart);
      if (dragDelta > 4) panel.style.transform = `translateY(${dragDelta}px)`;
    },
    { passive: true },
  );
  panel.addEventListener('touchend', () => {
    if (dragStart == null) return;
    dragStart = null;
    panel.style.transform = '';
    if (dragDelta > 96) close();
  });
  panel.addEventListener('touchcancel', () => {
    dragStart = null;
    dragDelta = 0;
    panel.style.transform = '';
  });

  (document.querySelector('#mobileShell > .m-workspace') ?? document.getElementById('mobileShell') ?? document.body).append(root);
  openSheets.set(close, root);
  markPreviewOccluder(root, 'dialog');
  syncSheetStack();
  requestAnimationFrame(() => { if (!closed) root.classList.add('is-open'); });
  queueMicrotask(() => {
    if (closed) return;
    // Only text sheets focus a field: focusing one in a list would raise the keyboard.
    const focusTarget =
      body.querySelector<HTMLElement>('[autofocus]') ??
      body.querySelector<HTMLElement>('[aria-selected="true"]:not([disabled])') ??
      panel;
    focusTarget.focus({ preventScroll: true });
  });
  return { el: root, body, close };
}

export interface PickOption<T> {
  value: T;
  label: string;
  description?: string;
  glyph?: string;
  /** Leading color dot (token expression, e.g. `var(--mn-success)`). */
  swatch?: string;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

/** Single-choice list in a sheet. Resolves null when dismissed. */
export function pickFromSheet<T>(title: string, options: PickOption<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let picked = false;
    const list = el('div', { className: 'm-pick', attrs: { role: 'listbox', 'aria-label': title } });
    const sheet = openSheet(list, {
      title,
      onClose: () => {
        if (!picked) resolve(null);
      },
    });
    for (const option of options) {
      const row = el(
        'button',
        {
          className: `m-pick__row${option.danger ? ' m-pick__row--danger' : ''}`,
          attrs: {
            type: 'button',
            role: 'option',
            'aria-selected': String(Boolean(option.selected)),
            disabled: option.disabled ?? false,
          },
          on: {
            click: () => {
              picked = true;
              haptic();
              resolve(option.value);
              sheet.close();
            },
          },
        },
        option.swatch
          ? el('span', { className: 'm-pick__swatch', attrs: { style: `--m-swatch: ${option.swatch}` } })
          : option.glyph
            ? el('span', { className: 'm-pick__icon' }, icon(option.glyph, 18))
            : null,
        el(
          'span',
          { className: 'm-pick__text' },
          el('span', { className: 'm-pick__label', text: option.label }),
          option.description ? el('span', { className: 'm-pick__desc', text: option.description }) : null,
        ),
        option.selected ? el('span', { className: 'm-pick__check' }, icon('fi-rr-check', 16)) : null,
      );
      list.append(row);
    }
  });
}

export interface ActionItem {
  label: string;
  glyph: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

/** Action menu ("…" buttons). */
export function openActionSheet(title: string, actions: ActionItem[]): void {
  const scope = getMobileWorkspaceScope();
  void pickFromSheet(
    title,
    actions.map((action, index) => ({
      value: index,
      label: action.label,
      glyph: action.glyph,
      danger: action.danger,
      disabled: action.disabled,
    })),
  ).then((index) => {
    if (index == null || scope !== getMobileWorkspaceScope()) return;
    void actions[index]?.run();
  });
}

/** Text entry sheet (rename, new issue title, comments). Resolves null when dismissed. */
export function promptSheet(options: {
  title: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const field = options.multiline
      ? el('textarea', {
          className: 'm-field m-field--multiline',
          attrs: { rows: 4, 'aria-label': options.title, placeholder: options.placeholder ?? '', autofocus: true },
        })
      : el('input', {
          className: 'm-field',
          attrs: { type: 'text', 'aria-label': options.title, placeholder: options.placeholder ?? '', autofocus: true, enterkeyhint: 'done' },
        });
    field.value = options.value ?? '';
    const submit = el('button', {
      className: 'm-btn m-btn--primary m-btn--block',
      text: options.confirmLabel ?? 'Save',
      attrs: { type: 'submit' },
    });
    const form = el('form', { className: 'm-prompt' }, field, submit);
    const sheet = openSheet(form, {
      title: options.title,
      onClose: () => {
        if (!done) resolve(null);
      },
    });
    const sync = () => {
      submit.disabled = !field.value.trim();
    };
    field.addEventListener('input', sync);
    sync();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = field.value.trim();
      if (!value) return;
      done = true;
      resolve(value);
      sheet.close();
    });
  });
}

/** Two-button confirmation sheet. */
export function confirmSheet(options: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const confirm = el('button', {
      className: `m-btn m-btn--block ${options.danger ? 'm-btn--danger' : 'm-btn--primary'}`,
      text: options.confirmLabel,
      attrs: { type: 'button' },
    });
    const cancel = el('button', { className: 'm-btn m-btn--block', text: 'Cancel', attrs: { type: 'button' } });
    const sheet = openSheet(
      el(
        'div',
        { className: 'm-confirm' },
        el('p', { className: 'm-confirm__body', text: options.body }),
        confirm,
        cancel,
      ),
      {
        title: options.title,
        onClose: () => {
          if (!answered) resolve(false);
        },
      },
    );
    confirm.addEventListener('click', () => {
      answered = true;
      resolve(true);
      sheet.close();
    });
    cancel.addEventListener('click', () => sheet.close());
  });
}
