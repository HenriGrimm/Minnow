/** Bottom sheets: the phone app's menus, pickers and detail panels. */

import { el, haptic, icon } from './dom';

export interface SheetHandle {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
}

export interface SheetOptions {
  title?: string;
  /** Tall sheets fill most of the screen (task details, long forms). */
  tall?: boolean;
  onClose?: () => void;
}

let openCount = 0;

/** Open a modal bottom sheet. Swipe down on the handle, tap the scrim or Escape to close. */
export function openSheet(content: HTMLElement | HTMLElement[], options: SheetOptions = {}): SheetHandle {
  const body = el('div', { className: 'm-sheet__body' });
  body.append(...(Array.isArray(content) ? content : [content]));
  const handle = el('div', { className: 'm-sheet__handle', attrs: { 'aria-hidden': 'true' } });
  const titleId = `m-sheet-title-${Date.now().toString(36)}`;
  const titleEl = options.title
    ? el('h2', { className: 'm-sheet__title', text: options.title, attrs: { id: titleId } })
    : null;
  const panel = el(
    'div',
    {
      className: `m-sheet__panel${options.tall ? ' m-sheet__panel--tall' : ''}`,
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': options.title ? titleId : null,
      },
    },
    handle,
    titleEl,
    body,
  );
  const scrim = el('div', { className: 'm-sheet__scrim' });
  const root = el('div', { className: 'm-sheet' }, scrim, panel);
  const previousFocus = document.activeElement as HTMLElement | null;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount = Math.max(0, openCount - 1);
    document.documentElement.classList.toggle('m-sheet-open', openCount > 0);
    document.removeEventListener('keydown', onKey, true);
    root.classList.remove('is-open');
    const finish = () => {
      root.remove();
      options.onClose?.();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else window.setTimeout(finish, 220);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  };
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);

  // Drag the handle or title area down to dismiss.
  let dragStart: number | null = null;
  let dragDelta = 0;
  const dragZone = (event: TouchEvent) => {
    const target = event.target instanceof Node ? event.target : null;
    if (!target) return false;
    if (handle.contains(target) || titleEl?.contains(target)) return true;
    // Inside the body, only a list already at its top hands the gesture to the sheet.
    return body.scrollTop <= 0 && !(target instanceof HTMLTextAreaElement);
  };
  panel.addEventListener(
    'touchstart',
    (event) => {
      if (!dragZone(event)) return;
      dragStart = event.touches[0]!.clientY;
      dragDelta = 0;
    },
    { passive: true },
  );
  panel.addEventListener(
    'touchmove',
    (event) => {
      if (dragStart == null) return;
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

  (document.getElementById('mobileShell') ?? document.body).append(root);
  openCount += 1;
  document.documentElement.classList.add('m-sheet-open');
  requestAnimationFrame(() => root.classList.add('is-open'));
  queueMicrotask(() => {
    // Only text sheets focus a field: focusing one in a list would raise the keyboard.
    const focusTarget =
      body.querySelector<HTMLElement>('[autofocus]') ??
      body.querySelector<HTMLElement>('[aria-checked="true"]') ??
      panel;
    if (focusTarget === panel) panel.tabIndex = -1;
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
            'aria-checked': option.selected ? 'true' : null,
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
    if (index == null) return;
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
          attrs: { rows: 4, placeholder: options.placeholder ?? '', autofocus: true },
        })
      : el('input', {
          className: 'm-field',
          attrs: { type: 'text', placeholder: options.placeholder ?? '', autofocus: true, enterkeyhint: 'done' },
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
