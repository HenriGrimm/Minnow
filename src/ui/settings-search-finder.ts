import { buildSettingsSearchIndex } from './settings-search-index';
import { navigateToSettingsSearchEntry } from './settings-search-navigate';
import { rankSettingsSearch } from './settings-search-rank';
import type { SettingsSearchEntry } from './settings-search-types';

let cachedIndex: SettingsSearchEntry[] | null = null;
let activeResults: SettingsSearchEntry[] = [];
let highlightedIndex = -1;
let finderOptions: { onQueryChange?: (query: string) => void } = {};

// ── Queries ──────────────────────────────────────────────────────────────────

function getIndex(): SettingsSearchEntry[] {
  cachedIndex = buildSettingsSearchIndex();
  return cachedIndex;
}

export function invalidateSettingsSearchIndex(): void {
  cachedIndex = null;
}

function getInput(): HTMLInputElement | null {
  return document.getElementById('settingsSearchInput') as HTMLInputElement | null;
}

function getResultsList(): HTMLElement | null {
  return document.getElementById('settingsSearchResults');
}

function getFinderRoot(): HTMLElement | null {
  return document.getElementById('settingsSearchFinder');
}

function isSettingsOpen(): boolean {
  return document.getElementById('settingsView')?.classList.contains('is-open') ?? false;
}

// ── Results ──────────────────────────────────────────────────────────────────

function closeResults(): void {
  const list = getResultsList();
  const input = getInput();
  highlightedIndex = -1;
  activeResults = [];
  if (list) {
    list.hidden = true;
    list.replaceChildren();
  }
  getFinderRoot()?.classList.remove('is-open');
  input?.setAttribute('aria-expanded', 'false');
}

function renderResults(entries: SettingsSearchEntry[]): void {
  const list = getResultsList();
  const input = getInput();
  if (!list || !input) return;

  list.replaceChildren();
  activeResults = entries;
  highlightedIndex = entries.length > 0 ? 0 : -1;

  if (entries.length === 0) {
    list.hidden = true;
    getFinderRoot()?.classList.remove('is-open');
    input.setAttribute('aria-expanded', 'false');
    return;
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-search-finder__option';
    btn.setAttribute('role', 'option');
    btn.dataset.index = String(i);
    if (i === highlightedIndex) {
      btn.setAttribute('aria-selected', 'true');
    }

    const label = document.createElement('span');
    label.className = 'settings-search-finder__option-label';
    label.textContent = entry.label;

    const hint = document.createElement('span');
    hint.className = 'settings-search-finder__option-hint';
    hint.textContent = entry.hint ?? entry.sectionId;

    btn.append(label, hint);
    btn.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    btn.addEventListener('click', () => {
      void selectEntry(entry);
    });
    list.appendChild(btn);
  }

  list.hidden = false;
  getFinderRoot()?.classList.add('is-open');
  input.setAttribute('aria-expanded', 'true');
  syncHighlightedOption();
}

function syncHighlightedOption(): void {
  const list = getResultsList();
  if (!list) return;
  const buttons = list.querySelectorAll('.settings-search-finder__option');
  buttons.forEach((node, i) => {
    const btn = node as HTMLButtonElement;
    const selected = i === highlightedIndex;
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    btn.classList.toggle('is-highlighted', selected);
  });
}

async function selectEntry(entry: SettingsSearchEntry): Promise<void> {
  const input = getInput();
  closeResults();
  if (input) {
    input.value = '';
    finderOptions.onQueryChange?.('');
  }
  await navigateToSettingsSearchEntry(entry);
}

function onInputChange(): void {
  const input = getInput();
  if (!input) return;
  const query = input.value;
  finderOptions.onQueryChange?.(query);
  if (!query.trim()) {
    closeResults();
    return;
  }
  const ranked = rankSettingsSearch(query, getIndex());
  renderResults(ranked);
}

function moveHighlight(delta: number): void {
  if (activeResults.length === 0) return;
  highlightedIndex =
    (highlightedIndex + delta + activeResults.length) % activeResults.length;
  syncHighlightedOption();
}

function activateHighlighted(): void {
  const entry = activeResults[highlightedIndex];
  if (!entry) return;
  void selectEntry(entry);
}

function focusFinderInput(): void {
  const input = getInput();
  if (!input || !isSettingsOpen()) return;
  input.focus();
  input.select();
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Wire finder input, results list, and settings-scoped keyboard shortcuts. */
export function initSettingsSearchFinder(options?: {
  onQueryChange?: (query: string) => void;
}): void {
  finderOptions = options ?? {};
  const input = getInput();
  const list = getResultsList();
  if (!input || !list) return;

  input.addEventListener('input', onInputChange);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveHighlight(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activateHighlighted();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeResults();
      input.blur();
    }
  });

  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!getFinderRoot()?.contains(document.activeElement)) {
        closeResults();
      }
    }, 120);
  });

  document.addEventListener('keydown', (event) => {
    if (!isSettingsOpen()) return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.key.toLowerCase() !== 'k') return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) {
      if (focused.isContentEditable) return;
    }
    event.preventDefault();
    focusFinderInput();
  });
}

export {
  closeResults as closeSettingsSearchResultsForTests,
  focusFinderInput as focusSettingsSearchInputForTests,
};
