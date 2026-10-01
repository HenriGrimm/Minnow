import '../styles/command-palette.css';
import { commandCategory, listCommands, type Command, type CommandCategory } from './command-registry';
import { createIcon, type IconName } from './icon';

export type { Command } from './command-registry';

export interface CommandPaletteHandle {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  destroy: () => void;
}

export interface CommandPaletteOptions {
  host: HTMLElement;
  getCommands: () => Command[];
  /** Accessible name for the dialog. */
  label: string;
  placeholder?: string;
  /** BEM prefix, so an embedded palette can keep its surface's own chrome. */
  classPrefix?: string;
  /** Unique id for the listbox (only matters when two palettes coexist). */
  listId?: string;
  /** Global search chrome; scoped palettes can retain their compact layout. */
  categories?: boolean;
}

const CATEGORIES = ['All', 'Chats', 'Code', 'Workspace', 'Models', 'Settings', 'Actions'] as const;
const CATEGORY_ICONS: Record<CommandCategory, IconName> = {
  Chats: 'appChat', Code: 'appCode', Workspace: 'folder', Models: 'appModels', Settings: 'appSettings', Actions: 'terminal',
};

/** Subsequence match: "cpk" finds "Cherry-pick". */
export function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();

  const direct = text.indexOf(query);
  if (direct >= 0) return direct;

  let score = 0;
  let cursor = 0;
  for (const char of query) {
    const found = text.indexOf(char, cursor);
    if (found < 0) return -1;
    score += found - cursor + 1;
    cursor = found + 1;
  }
  return 1000 + score;
}

/** Match each search word across the label, group and aliases in any order. */
export function commandScore(command: Command, query: string): number {
  const fields = [command.title, command.group, command.keywords ?? ''];
  let total = 0;
  for (const word of query.trim().split(/\s+/).filter(Boolean)) {
    const scores = fields.map((field) => fuzzyScore(field, word)).filter((score) => score >= 0);
    if (scores.length === 0) return Number.POSITIVE_INFINITY;
    total += Math.min(...scores);
  }
  return total;
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

export function createCommandPalette(
  options: CommandPaletteOptions,
): CommandPaletteHandle {
  const prefix = options.classPrefix ?? 'mn-palette';
  const listId = options.listId ?? `${prefix}-list`;

  let open = false;
  let commands: Command[] = [];
  let filtered: Command[] = [];
  let activeIndex = 0;
  let previousFocus: HTMLElement | null = null;
  let category: typeof CATEGORIES[number] = 'All';

  const overlay = el('div', `${prefix}-overlay`);
  overlay.hidden = true;

  const dialog = el('div', prefix);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', options.label);

  const input = el('input', `${prefix}__input`);
  input.type = 'text';
  input.placeholder = options.placeholder ?? 'Run a command';
  input.setAttribute('aria-label', options.label);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-autocomplete', 'list');
  input.autocomplete = 'off';

  const list = el('div', `${prefix}__list`);
  list.id = listId;
  list.setAttribute('role', 'listbox');

  const status = el('p', `${prefix}__status`);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const categoryBar = el('div', `${prefix}__categories`);
  categoryBar.setAttribute('role', 'tablist');
  categoryBar.setAttribute('aria-label', 'Search category');
  const tabs: HTMLButtonElement[] = [];
  const header = el('div', `${prefix}__header`);
  const closeButton = el('button', `${prefix}__close`);
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close search');
  closeButton.append(createIcon('close', { size: 18 }));
  closeButton.addEventListener('click', close);
  header.append(input, closeButton);
  const panel = el('div', `${prefix}__results`);
  panel.append(list);
  if (options.categories) {
    panel.id = `${listId}-panel`;
    panel.setAttribute('role', 'tabpanel');
    for (const name of CATEGORIES) {
      const tab = el('button', `${prefix}__category`, name);
      tab.type = 'button';
      tab.id = `${listId}-category-${name.toLowerCase()}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel.id);
      tab.addEventListener('click', () => selectCategory(name));
      tab.addEventListener('keydown', (event) => {
        const index = CATEGORIES.indexOf(name);
        let next: number | undefined;
        if (event.key === 'ArrowRight') next = (index + 1) % CATEGORIES.length;
        if (event.key === 'ArrowLeft') next = (index + CATEGORIES.length - 1) % CATEGORIES.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = CATEGORIES.length - 1;
        if (next !== undefined) {
          event.preventDefault();
          selectCategory(CATEGORIES[next]);
          tabs[next].focus();
        }
      });
      tabs.push(tab);
      categoryBar.append(tab);
    }
    const footer = el('div', `${prefix}__footer`);
    for (const [key, label] of [['↑ ↓', 'Navigate'], ['Enter', 'Open'], ['Esc', 'Close']]) {
      const hint = el('span', `${prefix}__hint`);
      hint.append(el('kbd', '', key), document.createTextNode(label));
      footer.append(hint);
    }
    dialog.append(header, categoryBar, panel, footer, status);
  } else {
    dialog.append(input, list, status);
  }
  overlay.appendChild(dialog);
  options.host.appendChild(overlay);

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key === 'Tab' && options.categories) {
      event.preventDefault();
      const stops: HTMLElement[] = [input, closeButton, ...tabs.filter((tab) => tab.tabIndex === 0)];
      const index = stops.indexOf(document.activeElement as HTMLElement);
      stops[(index + (event.shiftKey ? stops.length - 1 : 1)) % stops.length].focus();
    }
  });

  function selectCategory(name: typeof CATEGORIES[number]): void {
    category = name;
    activeIndex = 0;
    tabs.forEach((tab, index) => {
      const selected = CATEGORIES[index] === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', tabs[CATEGORIES.indexOf(name)].id);
    tabs[CATEGORIES.indexOf(name)].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    render();
  }

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });

  input.addEventListener('input', () => {
    activeIndex = 0;
    render();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Home' && filtered.length > 0) {
      event.preventDefault();
      activeIndex = 0;
      paintActive();
      return;
    }
    if (event.key === 'End' && filtered.length > 0) {
      event.preventDefault();
      activeIndex = filtered.length - 1;
      paintActive();
      return;
    }
    if (event.key === 'Tab') {
      if (!options.categories) event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void execute(filtered[activeIndex]);
    }
  });

  function move(delta: number): void {
    if (filtered.length === 0) return;
    activeIndex = (activeIndex + delta + filtered.length) % filtered.length;
    paintActive();
  }

  function paintActive(): void {
    const rows = [...list.querySelectorAll<HTMLElement>(`.${prefix}__row`)];
    rows.forEach((row, index) => {
      const active = index === activeIndex;
      row.classList.toggle('is-active', active);
      row.setAttribute('aria-selected', String(active));
      if (active) {
        row.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', row.id);
      }
    });
    if (rows.length === 0) input.removeAttribute('aria-activedescendant');
  }

  function render(): void {
    const query = input.value.trim();

    const scored = commands
      .filter((command) => command.available?.() !== false)
      .filter((command) => category === 'All' || commandCategory(command) === category)
      .map((command) => ({
        command,
        score: commandScore(command, query),
      }))
      .filter((entry) => Number.isFinite(entry.score));

    scored.sort((a, b) => a.score - b.score);
    filtered = scored.map((entry) => entry.command);

    if (filtered.length === 0) {
      list.replaceChildren(
        el('p', `${prefix}__empty`, query ? `No results for “${query}”` : `No ${category.toLowerCase()} available here`),
      );
      status.textContent = 'No matching results';
      paintActive();
      return;
    }

    const frag = document.createDocumentFragment();
    let lastGroup = '';

    filtered.forEach((command, index) => {
      if (command.group !== lastGroup) {
        lastGroup = command.group;
        frag.appendChild(el('div', `${prefix}__group`, command.group));
      }

      const row = el('div', `${prefix}__row`);
      row.id = `${listId}-row-${index}`;
      row.setAttribute('role', 'option');
      row.dataset.index = String(index);
      if (options.categories) row.append(createIcon(CATEGORY_ICONS[commandCategory(command)], { size: 18, className: `${prefix}__icon` }));
      row.appendChild(el('span', `${prefix}__title`, command.title));
      if (query) row.appendChild(el('span', `${prefix}__group-tag`, command.group));
      if (command.shortcut) {
        row.appendChild(el('kbd', `${prefix}__shortcut`, command.shortcut));
      }
      row.addEventListener('mouseenter', () => {
        activeIndex = index;
        paintActive();
      });
      row.addEventListener('click', () => void execute(command));
      frag.appendChild(row);
    });

    list.replaceChildren(frag);
    status.textContent = `${filtered.length} result${filtered.length === 1 ? '' : 's'}`;
    paintActive();
  }

  async function execute(command?: Command): Promise<void> {
    if (!command || command.available?.() === false) return;
    close();
    try {
      await command.run();
    } catch (error) {
      const { showToast } = await import('./toast');
      showToast(error instanceof Error ? error.message : 'Could not run command', 'error');
    }
  }

  function openPalette(): void {
    if (open) return;
    commands = options.getCommands();
    open = true;
    const active = document.activeElement as HTMLElement | null;
    previousFocus = typeof active?.focus === 'function' ? active : null;
    overlay.hidden = false;
    input.value = '';
    activeIndex = 0;
    if (options.categories) selectCategory('All');
    else render();
    input.focus();
  }

  function close(): void {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    input.value = '';
    const target = previousFocus;
    previousFocus = null;
    target?.focus();
  }

  return {
    open: openPalette,
    close,
    isOpen: () => open,
    destroy: () => {
      close();
      overlay.remove();
    },
  };
}

let globalPalette: CommandPaletteHandle | null = null;
let keyboardBound = false;

/** Mount point for the global palette. */
function paletteHost(): HTMLElement {
  return document.body;
}

function ensureGlobalPalette(): CommandPaletteHandle {
  if (globalPalette) return globalPalette;
  globalPalette = createCommandPalette({
    host: paletteHost(),
    getCommands: listCommands,
    label: 'Search chats and commands',
    placeholder: 'Search chats and commands',
    categories: true,
    classPrefix: 'mn-palette',
    listId: 'mnCommandPaletteList',
  });
  return globalPalette;
}

/** Open the global command palette. */
export function openCommandPalette(): void {
  ensureGlobalPalette().open();
}

export function closeCommandPalette(): void {
  globalPalette?.close();
}

export function isCommandPaletteOpen(): boolean {
  return globalPalette?.isOpen() ?? false;
}

function isPaletteChord(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return false;
  if (event.key === 'k' || event.key === 'K') return !event.shiftKey;
  return event.shiftKey && (event.key === 'p' || event.key === 'P');
}

/** Bind the global palette chord. */
export function initCommandPalette(): void {
  if (keyboardBound) return;
  keyboardBound = true;

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (!isPaletteChord(event)) return;
    event.preventDefault();
    if (isCommandPaletteOpen()) {
      closeCommandPalette();
      return;
    }
    openCommandPalette();
  });
}

/** Tear down the global palette (tests). */
export function resetCommandPaletteForTests(): void {
  globalPalette?.destroy();
  globalPalette = null;
  keyboardBound = false;
}
