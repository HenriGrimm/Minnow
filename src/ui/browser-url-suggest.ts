/**
 * Address-bar suggestions and the History popover for the preview browser.
 *
 * Both render in the renderer DOM, which the Electron guest (a native
 * WebContentsView) paints over — so while either is open it registers as a
 * chrome popover and the guest steps aside, same as every other menu over the
 * preview pane.
 */
import { appConfirm } from './app-dialog';
import {
  clearBrowserHistory,
  listBrowserHistory,
  removeBrowserHistoryEntry,
  stripUrlDecorations,
  suggestBrowserUrls,
  type BrowserHistoryEntry,
} from './browser-history';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';

const SUGGESTION_LIMIT = 8;
const HISTORY_POPOVER_LIMIT = 300;

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? 'Local file' : parsed.host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function removeButton(label: string, onRemove: () => void): HTMLButtonElement {
  const btn = el('button', 'browser-suggest__remove');
  btn.type = 'button';
  btn.tabIndex = -1;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = '<i class="fi fi-rr-cross-small icon-svg" aria-hidden="true"></i>';
  // mousedown, not click: keep focus in the address bar and beat the row's handler.
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove();
  });
  btn.addEventListener('click', (e) => e.stopPropagation());
  return btn;
}

// ── Address-bar suggestions ─────────────────────────────────────────────────

export interface BrowserUrlSuggestOptions {
  /** Navigate using the input's current value (the bar's existing Go action). */
  navigate: () => void;
}

/**
 * Turn a preview address bar into a combobox over browser history.
 * Arrow keys move through suggestions (previewing each URL in the bar),
 * Enter/click opens one, Escape restores what was typed, Shift+Delete or the
 * row's × forgets an entry.
 */
export function attachBrowserUrlSuggest(
  input: HTMLInputElement,
  options: BrowserUrlSuggestOptions,
): void {
  if (input.dataset.browserSuggest === '1') return;
  input.dataset.browserSuggest = '1';

  const listId = `${input.id || 'previewUrl'}Suggestions`;
  const list = el('div', 'browser-suggest');
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'History suggestions');
  list.hidden = true;
  document.body.appendChild(list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');

  let items: BrowserHistoryEntry[] = [];
  let active = -1;
  let typed = '';
  let open = false;

  const position = (): void => {
    const rect = input.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    list.style.left = `${left}px`;
    list.style.top = `${rect.bottom + 4}px`;
    list.style.width = `${width}px`;
  };

  const setOpen = (next: boolean): void => {
    if (next === open) return;
    open = next;
    list.hidden = !next;
    input.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) registerChromePopover();
    else unregisterChromePopover();
  };

  const close = (): void => {
    active = -1;
    input.removeAttribute('aria-activedescendant');
    setOpen(false);
  };

  const setActive = (index: number): void => {
    active = index;
    const rows = list.querySelectorAll<HTMLElement>('.browser-suggest__row');
    rows.forEach((row, i) => row.setAttribute('aria-selected', i === index ? 'true' : 'false'));
    if (index >= 0 && items[index]) {
      input.value = items[index].url;
      input.setAttribute('aria-activedescendant', rows[index]?.id ?? '');
      rows[index]?.scrollIntoView?.({ block: 'nearest' });
    } else {
      input.value = typed;
      input.removeAttribute('aria-activedescendant');
    }
  };

  const pick = (entry: BrowserHistoryEntry): void => {
    input.value = entry.url;
    close();
    options.navigate();
  };

  const render = (): void => {
    items = suggestBrowserUrls(typed, SUGGESTION_LIMIT);
    active = -1;
    list.replaceChildren();
    if (!items.length) {
      close();
      return;
    }
    items.forEach((entry, i) => {
      const row = el('div', 'browser-suggest__row');
      row.id = `${listId}-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.innerHTML = '<i class="fi fi-rr-clock icon-svg browser-suggest__icon" aria-hidden="true"></i>';
      const text = el('div', 'browser-suggest__text');
      text.append(
        el('span', 'browser-suggest__title', entry.title || hostOf(entry.url)),
        el('span', 'browser-suggest__url', stripUrlDecorations(entry.url)),
      );
      row.append(
        text,
        removeButton('Remove from history', () => {
          removeBrowserHistoryEntry(entry.url);
          render();
        }),
      );
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => pick(entry));
      row.addEventListener('mousemove', () => {
        if (active !== i) {
          const rows = list.querySelectorAll('.browser-suggest__row');
          rows.forEach((r, j) => r.setAttribute('aria-selected', j === i ? 'true' : 'false'));
          active = i;
        }
      });
      list.appendChild(row);
    });
    position();
    setOpen(true);
  };

  input.addEventListener('input', () => {
    typed = input.value;
    render();
  });

  input.addEventListener('blur', close);
  window.addEventListener('resize', () => {
    if (open) position();
  });

  // Capture phase so we run before the bar's own Enter → navigate handler.
  input.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          typed = input.value;
          render();
          return;
        }
        const n = items.length;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        // -1 is the typed-text slot between the last and first row.
        const next = active + step < -1 ? n - 1 : active + step >= n ? -1 : active + step;
        setActive(next);
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        input.value = typed;
        close();
        return;
      }
      if (e.key === 'Delete' && e.shiftKey && active >= 0 && items[active]) {
        e.preventDefault();
        removeBrowserHistoryEntry(items[active].url);
        input.value = typed;
        render();
        return;
      }
      if (e.key === 'Enter') {
        // The input already holds the highlighted URL (setActive); just let the
        // bar's own handler navigate to it.
        close();
        return;
      }
      if (e.key === 'Tab') close();
    },
    true,
  );
}

// ── History popover ─────────────────────────────────────────────────────────

let historyPopover: HTMLElement | null = null;
let historyCleanup: (() => void) | null = null;

function dayLabel(ts: number, now: Date): string {
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - 24 * 60 * 60 * 1000) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function isBrowserHistoryPopoverOpen(): boolean {
  return historyPopover !== null;
}

export function closeBrowserHistoryPopover(): void {
  historyCleanup?.();
  historyCleanup = null;
  historyPopover?.remove();
  if (historyPopover) unregisterChromePopover();
  historyPopover = null;
}

/** Toggle the History popover under `anchor`; `onOpen` loads a URL in the active tab. */
export function toggleBrowserHistoryPopover(
  anchor: HTMLElement,
  onOpen: (url: string) => void,
): void {
  if (historyPopover) {
    closeBrowserHistoryPopover();
    return;
  }

  const panel = el('div', 'browser-history');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Browser history');

  const header = el('div', 'browser-history__header');
  const search = el('input', 'browser-history__search');
  search.type = 'search';
  search.placeholder = 'Search history';
  search.setAttribute('aria-label', 'Search history');
  const clear = el('button', 'browser-history__clear', 'Clear');
  clear.type = 'button';
  header.append(search, clear);

  const body = el('div', 'browser-history__body');
  panel.append(header, body);

  const render = (): void => {
    const query = search.value.trim();
    const rows = query
      ? suggestBrowserUrls(query, HISTORY_POPOVER_LIMIT)
      : listBrowserHistory().slice(0, HISTORY_POPOVER_LIMIT);
    body.replaceChildren();
    clear.disabled = listBrowserHistory().length === 0;
    if (!rows.length) {
      body.appendChild(
        el('p', 'browser-history__empty', query ? 'No matching pages.' : 'Pages you visit will show up here.'),
      );
      return;
    }
    const now = new Date();
    let lastGroup = '';
    for (const entry of rows) {
      // Search results are ranked by relevance, so only group the plain list.
      const group = query ? '' : dayLabel(entry.lastVisitedAt, now);
      if (group && group !== lastGroup) {
        body.appendChild(el('div', 'browser-history__group', group));
        lastGroup = group;
      }
      // A div, not a button: it contains the remove button.
      const row = el('div', 'browser-history__row');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = entry.url;
      row.append(
        el(
          'span',
          'browser-history__time',
          new Date(entry.lastVisitedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        ),
        el('span', 'browser-history__title', entry.title || stripUrlDecorations(entry.url)),
        el('span', 'browser-history__host', hostOf(entry.url)),
        removeButton('Remove from history', () => {
          removeBrowserHistoryEntry(entry.url);
          render();
        }),
      );
      const openEntry = (): void => {
        closeBrowserHistoryPopover();
        onOpen(entry.url);
      };
      row.addEventListener('click', openEntry);
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openEntry();
      });
      body.appendChild(row);
    }
  };

  search.addEventListener('input', render);
  clear.addEventListener('click', () => {
    closeBrowserHistoryPopover();
    void appConfirm('Remove every page from the browser history?', {
      title: 'Clear history',
      confirmLabel: 'Clear history',
      danger: true,
    }).then((ok) => {
      if (ok) clearBrowserHistory();
    });
  });

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(420, window.innerWidth - 16);
  panel.style.width = `${width}px`;
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  document.body.appendChild(panel);
  historyPopover = panel;
  registerChromePopover();
  render();
  search.focus();

  const onPointerDown = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (target && (panel.contains(target) || anchor.contains(target))) return;
    closeBrowserHistoryPopover();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeBrowserHistoryPopover();
    anchor.focus();
  };
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closeBrowserHistoryPopover);
  historyCleanup = () => {
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closeBrowserHistoryPopover);
  };
}
