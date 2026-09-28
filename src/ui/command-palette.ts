import '../styles/command-palette.css';
import { listCommands, type Command } from './command-registry';

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
}

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

  dialog.append(input, list, status);
  overlay.appendChild(dialog);
  options.host.appendChild(overlay);

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
      event.preventDefault();
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
      .map((command) => ({
        command,
        score: Math.min(
          ...[`${command.group} ${command.title}`, command.keywords ?? '']
            .filter(Boolean)
            .map((text) => {
              const score = fuzzyScore(text, query);
              return score < 0 ? Number.POSITIVE_INFINITY : score;
            }),
        ),
      }))
      .filter((entry) => Number.isFinite(entry.score));

    scored.sort((a, b) => a.score - b.score);
    filtered = scored.map((entry) => entry.command);

    if (filtered.length === 0) {
      list.replaceChildren(
        el('p', `${prefix}__empty`, `No command matches “${query}”`),
      );
      status.textContent = 'No matching commands';
      paintActive();
      return;
    }

    const frag = document.createDocumentFragment();
    let lastGroup = '';

    filtered.forEach((command, index) => {
      if (!query && command.group !== lastGroup) {
        lastGroup = command.group;
        frag.appendChild(el('div', `${prefix}__group`, command.group));
      }

      const row = el('div', `${prefix}__row`);
      row.id = `${listId}-row-${index}`;
      row.setAttribute('role', 'option');
      row.dataset.index = String(index);
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
    status.textContent = `${filtered.length} command${filtered.length === 1 ? '' : 's'}`;
    paintActive();
  }

  async function execute(command?: Command): Promise<void> {
    if (!command) return;
    close();
    await command.run();
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
    render();
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
    label: 'Commands',
    placeholder: 'Run a command',
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
