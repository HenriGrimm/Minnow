import { getFilterQuery, setFilterQueryValue } from './file-tree-filter';

const DEBOUNCE_MS = 200;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchInputEl: HTMLInputElement | null = null;
let clearBtnEl: HTMLButtonElement | null = null;
let renderFileTreeCallback: () => void = () => {};
/** Wired from init-file-panel after detectLocalServer (avoids importing tools/config here). */
let serverOnlineCheck: () => boolean = () => false;

export { getFilterQuery } from './file-tree-filter';

/** Register tree re-render (wired from init-file-panel to avoid import cycle). */
export function registerFileTreeFilterRender(fn: () => void): void {
  renderFileTreeCallback = fn;
}

/** Register server ping result for disabling the search field. */
export function registerFileTreeServerCheck(fn: () => boolean): void {
  serverOnlineCheck = fn;
}

/** Test hook: override server availability without loading the full tools stack. */
export function setServerOnlineCheckForTests(fn: () => boolean): void {
  serverOnlineCheck = fn;
}

/** Reset filter and re-render browse tree. */
export function setFilterQuery(value: string): void {
  setFilterQueryValue(value);
  syncSearchUi();
  renderFileTreeCallback();
}

function syncSearchUi(): void {
  const query = getFilterQuery();
  if (searchInputEl && searchInputEl.value !== query) {
    searchInputEl.value = query;
  }
  if (clearBtnEl) {
    clearBtnEl.classList.toggle('hidden', !query.trim());
  }
}

function scheduleFilterRender(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    renderFileTreeCallback();
  }, DEBOUNCE_MS);
}

function applyOfflineState(): void {
  const online = serverOnlineCheck();
  if (searchInputEl) {
    searchInputEl.disabled = !online;
    searchInputEl.placeholder = online ? 'Search files and content…' : 'Server required';
  }
  if (clearBtnEl) clearBtnEl.disabled = !online;
}

/** Wire search input after file panel DOM is ready. */
export function initFileTreeSearch(): void {
  searchInputEl = document.getElementById('fileTreeSearch') as HTMLInputElement | null;
  clearBtnEl = document.getElementById('btnFileTreeSearchClear') as HTMLButtonElement | null;
  if (!searchInputEl) return;

  applyOfflineState();

  searchInputEl.addEventListener('input', () => {
    setFilterQueryValue(searchInputEl?.value ?? '');
    syncSearchUi();
    scheduleFilterRender();
  });

  searchInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setFilterQuery('');
    }
  });

  if (clearBtnEl) {
    clearBtnEl.addEventListener('click', () => {
      setFilterQuery('');
      searchInputEl?.focus();
    });
  }
}

/** Refresh disabled state when server ping changes. */
export function onFileTreeSearchServerChanged(): void {
  applyOfflineState();
}
