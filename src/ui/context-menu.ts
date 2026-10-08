import '../styles/context-menu.css';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';

/** A selectable row. */
export interface MenuActionItem {
  kind?: 'action';
  id: string;
  label: string;
  /** Secondary line under the label (mode hints, consequences). */
  hint?: string;
  /** Right-aligned key hint, rendered as a `<kbd>`. */
  shortcut?: string;
  /** Destructive styling. Reserve for actions that lose data. */
  danger?: boolean;
  disabled?: boolean;
  /** Present (true or false) renders a checkbox row instead of a plain one. */
  checked?: boolean;
  /** Leading colour dot — taxonomy chips, branch colours. */
  swatch?: string;
  /** Leading Uicons class (fi-rr-* / fi-sr-*), e.g. status glyphs. */
  iconClass?: string;
  onSelect: () => void | Promise<void>;
}

/** A row that opens a nested menu. */
export interface MenuSubmenuItem {
  kind: 'submenu';
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Pass a function to resolve children at open time rather than build time. */
  items: MenuItem[] | (() => MenuItem[]);
}

export interface MenuSeparatorItem {
  kind: 'separator';
  id?: string;
}

/** Labels the group of items that follows it, up to the next heading. */
export interface MenuHeadingItem {
  kind: 'heading';
  id?: string;
  label: string;
}

export type MenuItem =
  | MenuActionItem
  | MenuSubmenuItem
  | MenuSeparatorItem
  | MenuHeadingItem;

export interface OpenContextMenuOptions {
  items: MenuItem[];
  /** Viewport coordinates for a pointer-opened menu. */
  clientX?: number;
  clientY?: number;
  /** Anchor element to align under, for menus opened from a control rather than a right-click (inline property editing on a list row). */
  anchor?: HTMLElement | null;
  /** Accessible name for the menu. */
  label?: string;
  /** Element that opened the menu; receives focus on close. */
  restoreFocus?: HTMLElement | null;
  /** Host for the menu element; defaults to document.body. */
  mount?: HTMLElement;
}

export interface ContextMenuHandle {
  close: () => void;
  /** Root element of the top-level menu. */
  root: HTMLElement;
}

/** Submenu rows carry their definition so ArrowRight can reopen them. */
type SubmenuRow = HTMLButtonElement & { __menuItem?: MenuSubmenuItem };

interface MenuLevel {
  root: HTMLElement;
  /** Focusable rows in DOM order. */
  rows: HTMLButtonElement[];
  /** Submenu row in the parent level that owns this one. */
  ownerRow: HTMLButtonElement | null;
}

const EDGE_GAP = 8;
const SUBMENU_OPEN_DELAY_MS = 110;
const TYPEAHEAD_RESET_MS = 600;

let levels: MenuLevel[] = [];
let restoreFocusEl: HTMLElement | null = null;
let scrollOriginEl: HTMLElement | null = null;
/** Resolved on open, not at module load — importing this must not need a DOM. */
let mountEl: HTMLElement | null = null;
let listenersBound = false;
let submenuTimer: ReturnType<typeof setTimeout> | null = null;
let typeaheadBuffer = '';
let typeaheadAt = 0;
const deferredRefreshes = new Set<() => void>();

/** Keep controls stable while their menu is being used; coalesce refreshes until dismissal. */
export function deferUntilContextMenuClosed(refresh: () => void): boolean {
  if (!isContextMenuOpen()) return false;
  deferredRefreshes.add(refresh);
  return true;
}

/** True while any context menu is open. */
export function isContextMenuOpen(): boolean {
  return levels.length > 0;
}

/** Close any open context menu, including nested levels. */
export function closeContextMenu(options?: { restoreFocus?: boolean }): void {
  if (levels.length === 0) return;
  cancelSubmenuTimer();
  for (const level of levels) level.root.remove();
  levels = [];
  unregisterChromePopover();
  unbindGlobalListeners();
  const target = restoreFocusEl;
  restoreFocusEl = null;
  scrollOriginEl = null;
  if (options?.restoreFocus !== false) target?.focus();
  queueMicrotask(() => {
    // Replacing one menu with another should keep the same refreshes deferred.
    if (isContextMenuOpen()) return;
    const refreshes = [...deferredRefreshes];
    deferredRefreshes.clear();
    for (const refresh of refreshes) refresh();
  });
}

function host(): HTMLElement {
  return mountEl ?? document.body;
}

function cancelSubmenuTimer(): void {
  if (submenuTimer === null) return;
  clearTimeout(submenuTimer);
  submenuTimer = null;
}

function isSeparator(item: MenuItem): item is MenuSeparatorItem {
  return (item as MenuSeparatorItem).kind === 'separator';
}

function isHeading(item: MenuItem): item is MenuHeadingItem {
  return (item as MenuHeadingItem).kind === 'heading';
}

function isSubmenu(item: MenuItem): item is MenuSubmenuItem {
  return (item as MenuSubmenuItem).kind === 'submenu';
}

function resolveSubmenuItems(item: MenuSubmenuItem): MenuItem[] {
  return typeof item.items === 'function' ? item.items() : item.items;
}

/** Drop separators that would render at an edge or next to another separator. */
function tidySeparators(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (isSeparator(item)) {
      const previous = out[out.length - 1];
      if (!previous || isSeparator(previous) || isHeading(previous)) continue;
    }
    out.push(item);
  }
  while (out.length > 0 && isSeparator(out[out.length - 1])) out.pop();
  return out;
}

function buildRow(item: MenuActionItem | MenuSubmenuItem): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mn-menu__item';
  btn.dataset.id = item.id;
  btn.tabIndex = -1;
  btn.disabled = Boolean(item.disabled);

  const submenu = isSubmenu(item);
  const checkable = !submenu && typeof (item as MenuActionItem).checked === 'boolean';
  btn.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
  if (checkable) {
    btn.setAttribute('aria-checked', String((item as MenuActionItem).checked));
    btn.classList.add('is-checkable');
    const check = document.createElement('span');
    check.className = 'mn-menu__check';
    check.setAttribute('aria-hidden', 'true');
    btn.appendChild(check);
  }
  if (submenu) {
    btn.classList.add('is-submenu');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
  }
  if (!submenu && (item as MenuActionItem).danger) btn.classList.add('is-danger');

  const action = !submenu ? (item as MenuActionItem) : null;
  const iconClass = action?.iconClass?.trim();
  if (iconClass && /^fi-(?:rr|sr)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(iconClass)) {
    const glyph = document.createElement('i');
    glyph.className = `fi ${iconClass} icon-svg mn-menu__icon`;
    glyph.setAttribute('aria-hidden', 'true');
    btn.appendChild(glyph);
  }
  const swatchColor = action?.swatch;
  if (swatchColor) {
    const swatch = document.createElement('span');
    swatch.className = 'mn-menu__swatch';
    swatch.style.background = swatchColor;
    swatch.setAttribute('aria-hidden', 'true');
    btn.appendChild(swatch);
  }

  const text = document.createElement('span');
  text.className = 'mn-menu__text';
  const label = document.createElement('span');
  label.className = 'mn-menu__label';
  label.textContent = item.label;
  text.appendChild(label);
  if (item.hint?.trim()) {
    const hint = document.createElement('span');
    hint.className = 'mn-menu__hint';
    hint.textContent = item.hint;
    text.appendChild(hint);
  }
  btn.appendChild(text);

  const shortcut = !submenu ? (item as MenuActionItem).shortcut : undefined;
  if (shortcut) {
    const kbd = document.createElement('kbd');
    kbd.className = 'mn-menu__shortcut';
    kbd.textContent = shortcut;
    btn.appendChild(kbd);
  }
  if (submenu) {
    const chevron = document.createElement('span');
    chevron.className = 'mn-menu__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    btn.appendChild(chevron);
  }

  return btn;
}

/** Render one menu level. */
function buildLevel(
  items: MenuItem[],
  label: string,
  ownerRow: HTMLButtonElement | null,
): MenuLevel {
  const root = document.createElement('div');
  root.className = 'mn-menu';
  root.setAttribute('role', 'menu');
  root.setAttribute('aria-label', label);
  root.tabIndex = -1;

  const rows: HTMLButtonElement[] = [];
  let container: HTMLElement = root;
  const tidied = tidySeparators(items);

  for (const item of tidied) {
    if (isHeading(item)) {
      const group = document.createElement('div');
      group.className = 'mn-menu__group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', item.label);
      const heading = document.createElement('span');
      heading.className = 'mn-menu__heading';
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = item.label;
      group.appendChild(heading);
      root.appendChild(group);
      container = group;
      continue;
    }
    if (isSeparator(item)) {
      const rule = document.createElement('div');
      rule.className = 'mn-menu__separator';
      rule.setAttribute('role', 'separator');
      root.appendChild(rule);
      container = root;
      continue;
    }

    const row = buildRow(item);
    container.appendChild(row);
    rows.push(row);

    if (isSubmenu(item)) {
      (row as SubmenuRow).__menuItem = item;
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        if (row.disabled) return;
        openSubmenuFor(row, item, { focusFirst: true });
      });
    } else {
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        if (row.disabled) return;
        void (async () => {
          closeContextMenu();
          await item.onSelect();
        })();
      });
    }

    row.addEventListener('pointerenter', () => {
      const index = levels.findIndex((level) => level.rows.includes(row));
      if (index < 0) return;
      cancelSubmenuTimer();
      closeLevelsAbove(index);
      if (!row.disabled) row.focus();
      if (!isSubmenu(item) || row.disabled) return;
      submenuTimer = setTimeout(() => {
        submenuTimer = null;
        if (!row.isConnected) return;
        openSubmenuFor(row, item, { focusFirst: false });
      }, SUBMENU_OPEN_DELAY_MS);
    });
  }

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'mn-menu__empty';
    empty.textContent = 'No actions available';
    root.appendChild(empty);
  }

  return { root, rows, ownerRow };
}

/** Clamp a menu into the viewport at pointer coordinates. */
function positionAtPoint(root: HTMLElement, x: number, y: number): void {
  root.style.left = '0px';
  root.style.top = '0px';
  const rect = root.getBoundingClientRect();
  const maxLeft = Math.max(EDGE_GAP, window.innerWidth - rect.width - EDGE_GAP);
  const maxTop = Math.max(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP);
  root.style.left = `${Math.min(Math.max(EDGE_GAP, x), maxLeft)}px`;
  root.style.top = `${Math.min(Math.max(EDGE_GAP, y), maxTop)}px`;
}

/** Align a menu under an anchor control, flipping above it when it would clip. */
function positionAtAnchor(root: HTMLElement, anchor: HTMLElement): void {
  root.style.left = '0px';
  root.style.top = '0px';
  const rect = root.getBoundingClientRect();
  const box = anchor.getBoundingClientRect();
  const left = Math.min(
    Math.max(EDGE_GAP, box.left),
    Math.max(EDGE_GAP, window.innerWidth - rect.width - EDGE_GAP),
  );
  const below = box.bottom + 4;
  const fitsBelow = below + rect.height + EDGE_GAP <= window.innerHeight;
  const top = fitsBelow
    ? below
    : Math.max(EDGE_GAP, box.top - rect.height - 4);
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
}

/** Place a submenu beside its owner row, flipping to the left when it would clip. */
function positionSubmenu(root: HTMLElement, ownerRow: HTMLElement): void {
  root.style.left = '0px';
  root.style.top = '0px';
  const rect = root.getBoundingClientRect();
  const box = ownerRow.getBoundingClientRect();
  const parentRect = (ownerRow.closest('.mn-menu') as HTMLElement).getBoundingClientRect();

  const rightEdge = parentRect.right - 2;
  const leftEdge = parentRect.left - rect.width + 2;
  const fitsRight = rightEdge + rect.width + EDGE_GAP <= window.innerWidth;
  const left = fitsRight ? rightEdge : Math.max(EDGE_GAP, leftEdge);

  const top = Math.min(
    Math.max(EDGE_GAP, box.top - 5),
    Math.max(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP),
  );
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
}

function levelIndexForNode(node: Node | null): number {
  if (!node) return -1;
  return levels.findIndex((level) => level.root.contains(node));
}

/** Tear down every level deeper than `index`, restoring the owner's aria state. */
function closeLevelsAbove(index: number): void {
  while (levels.length > index + 1) {
    const level = levels.pop();
    if (!level) break;
    level.ownerRow?.setAttribute('aria-expanded', 'false');
    level.root.remove();
  }
}

function openSubmenuFor(
  ownerRow: HTMLButtonElement,
  item: MenuSubmenuItem,
  options: { focusFirst: boolean },
): void {
  const parentIndex = levels.findIndex((level) => level.rows.includes(ownerRow));
  if (parentIndex < 0) return;

  const already = levels[parentIndex + 1];
  if (already?.ownerRow === ownerRow) {
    if (options.focusFirst) focusRow(already, firstEnabledIndex(already));
    return;
  }
  closeLevelsAbove(parentIndex);

  const level = buildLevel(resolveSubmenuItems(item), item.label, ownerRow);
  host().appendChild(level.root);
  levels.push(level);
  positionSubmenu(level.root, ownerRow);
  ownerRow.setAttribute('aria-expanded', 'true');
  if (options.focusFirst) focusRow(level, firstEnabledIndex(level));
}

function firstEnabledIndex(level: MenuLevel): number {
  return level.rows.findIndex((row) => !row.disabled);
}

function focusRow(level: MenuLevel, index: number): void {
  if (index < 0 || level.rows.length === 0) {
    level.root.focus();
    return;
  }
  level.rows[index]?.focus();
}

/** Move focus within a level, skipping disabled rows and wrapping at the ends. */
function stepFocus(level: MenuLevel, from: number, delta: number): void {
  const count = level.rows.length;
  if (count === 0) return;
  for (let step = 1; step <= count; step += 1) {
    const next = (((from + delta * step) % count) + count) % count;
    const row = level.rows[next];
    if (row && !row.disabled) {
      row.focus();
      return;
    }
  }
}

function submenuItemForRow(row: HTMLButtonElement): MenuSubmenuItem | null {
  return (row as SubmenuRow).__menuItem ?? null;
}

function runTypeahead(level: MenuLevel, char: string, from: number): boolean {
  const now = Date.now();
  typeaheadBuffer = now - typeaheadAt > TYPEAHEAD_RESET_MS ? char : typeaheadBuffer + char;
  typeaheadAt = now;
  const query = typeaheadBuffer.toLowerCase();
  const count = level.rows.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (from + step) % count;
    const row = level.rows[index];
    if (!row || row.disabled) continue;
    const label = row.querySelector('.mn-menu__label')?.textContent ?? '';
    if (label.toLowerCase().startsWith(query)) {
      row.focus();
      return true;
    }
  }
  return false;
}

function onKeyDown(event: KeyboardEvent): void {
  if (levels.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const levelIndex = Math.max(0, levelIndexForNode(active));
  const level = levels[levelIndex] ?? levels[levels.length - 1];
  const current = active ? level.rows.indexOf(active as HTMLButtonElement) : -1;

  switch (event.key) {
    case 'Escape': {
      event.preventDefault();
      event.stopPropagation();
      if (levels.length > 1) {
        const owner = levels[levels.length - 1].ownerRow;
        closeLevelsAbove(levels.length - 2);
        owner?.focus();
        return;
      }
      closeContextMenu();
      return;
    }
    case 'ArrowDown':
      event.preventDefault();
      stepFocus(level, current < 0 ? -1 : current, 1);
      return;
    case 'ArrowUp':
      event.preventDefault();
      stepFocus(level, current < 0 ? 0 : current, -1);
      return;
    case 'Home':
      event.preventDefault();
      stepFocus(level, -1, 1);
      return;
    case 'End':
      event.preventDefault();
      stepFocus(level, 0, -1);
      return;
    case 'ArrowRight': {
      if (current < 0) return;
      const row = level.rows[current];
      const item = submenuItemForRow(row);
      if (!item) return;
      event.preventDefault();
      cancelSubmenuTimer();
      openSubmenuFor(row, item, { focusFirst: true });
      return;
    }
    case 'ArrowLeft': {
      if (levels.length <= 1) return;
      event.preventDefault();
      const owner = levels[levels.length - 1].ownerRow;
      closeLevelsAbove(levels.length - 2);
      owner?.focus();
      return;
    }
    case 'Enter':
    case ' ': {
      if (current < 0) return;
      event.preventDefault();
      level.rows[current].click();
      return;
    }
    case 'Tab': {
      event.preventDefault();
      closeContextMenu();
      return;
    }
    default:
      break;
  }

  if (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    /\S/.test(event.key)
  ) {
    if (runTypeahead(level, event.key, current)) event.preventDefault();
  }
}

function onPointerDown(event: PointerEvent): void {
  if (levelIndexForNode(event.target as Node) >= 0) return;
  closeContextMenu();
}

function onWindowChange(event: Event): void {
  if (event.type === 'scroll') {
    const target = event.target;
    // Streaming chats can scroll in another pane, including behind Issues.
    // Only scrolling the opener's ancestors can move it away from the menu.
    if (target !== window && target !== document) {
      if (levelIndexForNode(target as Node) >= 0) return;
      if (scrollOriginEl && !(target as Node | null)?.contains(scrollOriginEl)) return;
    }
  }
  closeContextMenu();
}

function bindGlobalListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('scroll', onWindowChange, true);
}

function unbindGlobalListeners(): void {
  if (!listenersBound) return;
  listenersBound = false;
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('scroll', onWindowChange, true);
}

export function openContextMenu(options: OpenContextMenuOptions): ContextMenuHandle {
  closeContextMenu({ restoreFocus: false });

  mountEl = options.mount ?? null;
  restoreFocusEl = options.restoreFocus ?? null;
  scrollOriginEl = options.anchor ?? options.restoreFocus ?? null;

  const level = buildLevel(options.items, options.label ?? 'Menu', null);
  host().appendChild(level.root);
  levels = [level];
  registerChromePopover();

  if (options.anchor) positionAtAnchor(level.root, options.anchor);
  else positionAtPoint(level.root, options.clientX ?? 0, options.clientY ?? 0);

  bindGlobalListeners();
  typeaheadBuffer = '';
  focusRow(level, firstEnabledIndex(level));

  return {
    root: level.root,
    close: () => closeContextMenu(),
  };
}
