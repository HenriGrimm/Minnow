/** Shared screen chrome: headers, segmented filters, pull-to-refresh. */

import { el, icon, iconButton } from './dom';
import { popScreen, returnToMobileChat } from './nav';

export interface HeaderOptions {
  title: string;
  subtitle?: string;
  leading?: HTMLElement;
  /** Show Back to chat, or pop the stack on the chat thread itself. */
  back?: boolean | 'previous';
  actions?: HTMLElement[];
  /** Root screens use a large title row. */
  large?: boolean;
}

export interface ScreenHeader {
  el: HTMLElement;
  setTitle(title: string): void;
  setSubtitle(subtitle: string): void;
}

export function screenHeader(options: HeaderOptions): ScreenHeader {
  const title = el('h1', { className: 'm-header__title', text: options.title });
  const subtitle = el('p', { className: 'm-header__subtitle', text: options.subtitle ?? '' });
  subtitle.hidden = !options.subtitle;
  const back = options.back
    ? el(
        'button',
        {
          className: 'm-header__back',
          attrs: { type: 'button', 'aria-label': options.back === 'previous' ? 'Back' : 'Back to chat' },
          on: { click: options.back === 'previous' ? () => popScreen() : returnToMobileChat },
        },
        icon('fi-rr-angle-small-left', 26),
      )
    : null;
  const header = el(
    'header',
    { className: `m-header${options.large ? ' m-header--large' : ''}` },
    back ?? options.leading,
    el('div', { className: 'm-header__titles' }, title, subtitle),
    el('div', { className: 'm-header__actions' }, ...(options.actions ?? [])),
  );
  return {
    el: header,
    setTitle(text) {
      title.textContent = text;
    },
    setSubtitle(text) {
      subtitle.textContent = text;
      subtitle.hidden = !text;
    },
  };
}

export { iconButton };

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  setValue(value: T): void;
  setCounts(counts: Partial<Record<T, number>>): void;
}

/** Horizontally scrolling chip filter; one value selected. */
export function segmented<T extends string>(
  label: string,
  options: SegmentOption<T>[],
  value: T,
  onChange: (value: T) => void,
): Segmented<T> {
  const buttons = new Map<T, { button: HTMLButtonElement; count: HTMLElement }>();
  const host = el('div', { className: 'm-segments', attrs: { role: 'group', 'aria-label': label } });
  let current = value;
  const sync = () => {
    for (const [key, { button }] of buttons) {
      const selected = key === current;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('is-selected', selected);
    }
  };
  for (const option of options) {
    const count = el('span', { className: 'm-segment__count' });
    const button = el(
      'button',
      {
        className: 'm-segment',
        attrs: { type: 'button' },
        on: {
          click: () => {
            if (current === option.value) return;
            current = option.value;
            sync();
            const strip = host.getBoundingClientRect();
            const chip = button.getBoundingClientRect();
            if (chip.right > strip.right) host.scrollLeft += chip.right - strip.right;
            else if (chip.left < strip.left) host.scrollLeft += chip.left - strip.left;
            onChange(option.value);
          },
        },
      },
      el('span', { text: option.label }),
      count,
    );
    if (option.count != null) count.textContent = String(option.count);
    else count.hidden = true;
    buttons.set(option.value, { button, count });
    host.append(button);
  }
  sync();
  return {
    el: host,
    setValue(next) {
      current = next;
      sync();
    },
    setCounts(counts) {
      for (const [key, { count }] of buttons) {
        const n = counts[key];
        count.hidden = n == null;
        count.textContent = n == null ? '' : String(n);
      }
    },
  };
}

/** Search field with a clear button; reports trimmed text as the user types. */
export function searchField(placeholder: string, onInput: (text: string) => void): {
  el: HTMLElement;
  input: HTMLInputElement;
  clear(): void;
} {
  const input = el('input', {
    className: 'm-search__input',
    attrs: {
      type: 'search',
      placeholder,
      'aria-label': placeholder,
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
    },
  });
  const clearBtn = el(
    'button',
    {
      className: 'm-search__clear',
      attrs: { type: 'button', 'aria-label': 'Clear search' },
      on: {
        click: () => {
          input.value = '';
          clearBtn.hidden = true;
          onInput('');
          input.focus();
        },
      },
    },
    icon('fi-rr-cross-circle', 16),
  );
  clearBtn.hidden = true;
  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    onInput(input.value.trim());
  });
  const host = el('div', { className: 'm-search', attrs: { role: 'search' } }, icon('fi-rr-search', 16), input, clearBtn);
  return {
    el: host,
    input,
    clear() {
      input.value = '';
      clearBtn.hidden = true;
    },
  };
}

/**
 * Pull down at the top of `scroller` to run `refresh`. Touch only; the
 * indicator sits above the list and never shifts content while idle.
 */
export function attachPullToRefresh(scroller: HTMLElement, refresh: () => Promise<unknown>): void {
  const indicator = el('div', { className: 'm-ptr', attrs: { 'aria-hidden': 'true' } }, icon('fi-rr-refresh', 18));
  scroller.prepend(indicator);
  let startY = 0;
  let pulling = false;
  let distance = 0;
  let busy = false;
  const threshold = 64;
  const set = (px: number) => {
    indicator.style.setProperty('--m-ptr-pull', `${px}px`);
    indicator.classList.toggle('is-armed', px >= threshold);
  };
  scroller.addEventListener(
    'touchstart',
    (event) => {
      if (busy || scroller.scrollTop > 0 || event.touches.length !== 1) return;
      startY = event.touches[0]!.clientY;
      pulling = true;
      distance = 0;
    },
    { passive: true },
  );
  scroller.addEventListener(
    'touchmove',
    (event) => {
      if (!pulling) return;
      distance = Math.max(0, event.touches[0]!.clientY - startY);
      if (scroller.scrollTop > 0) distance = 0;
      set(Math.min(96, distance * 0.5));
    },
    { passive: true },
  );
  const end = () => {
    if (!pulling) return;
    pulling = false;
    if (distance * 0.5 < threshold) {
      set(0);
      return;
    }
    busy = true;
    indicator.classList.add('is-busy');
    set(threshold);
    void refresh().catch(() => {
      // The screen's data source owns its error state.
    }).finally(() => {
      busy = false;
      indicator.classList.remove('is-busy');
      set(0);
    });
  };
  scroller.addEventListener('touchend', end, { passive: true });
  scroller.addEventListener('touchcancel', () => {
    if (!pulling) return;
    pulling = false;
    set(0);
  }, { passive: true });
}
