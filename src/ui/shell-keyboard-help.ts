import { isDeveloperReleased } from '../os/app-registry';
import type { AppId } from '../os/types';
import { isTypingTarget } from './a11y/typing-target';

export interface ShortcutDoc {
  keys: string;
  label: string;
  /** Group heading for the cheat sheet. */
  section?: string;
  /** Omit from help when the app is not developer-released. */
  appId?: AppId;
}

const SHELL_SHORTCUTS: ShortcutDoc[] = [
  {
    section: 'Shell',
    keys: 'Ctrl/Cmd + K / Ctrl/Cmd + Shift + P',
    label: 'Command palette (works from any app)',
  },
  { section: 'Shell', keys: '?', label: 'Open this keyboard shortcuts list' },
  { section: 'Shell', keys: 'Escape', label: 'Close overlays, popovers, side panels, and Research' },
  { section: 'Shell', keys: 'Ctrl + Scroll wheel', label: 'Zoom the interface in / out' },
  {
    section: 'Shell',
    keys: 'Ctrl + Tab / Ctrl + Shift + Tab',
    label: 'Cycle among recent apps on the left app rail (Cmd+Tab stays with the OS)',
  },
  { section: 'Shell', keys: 'Tab / Shift+Tab', label: 'Move focus through dock, menubar, and app chrome' },
];

const CHAT_SHORTCUTS: ShortcutDoc[] = [
  { section: 'Chat', keys: 'Enter', label: 'Send message (composer focused)' },
  { section: 'Chat', keys: 'Shift + Enter', label: 'New line in composer' },
  { section: 'Chat', keys: '/', label: 'Open skill picker in composer' },
  {
    section: 'Chat',
    keys: 'Ctrl/Cmd + M',
    label: 'Open per-chat model picker (focuses search)',
  },
  { section: 'Chat', keys: 'Arrow keys', label: 'Navigate model list when picker is open' },
  { section: 'Chat', keys: '1 / 2 / 3', label: 'Tool approval: allow once, always allow, cancel' },
];

// Ctrl/Cmd+P is omitted: there is no fuzzy file switcher, only the palette.
const CODE_SHORTCUTS: ShortcutDoc[] = [
  {
    section: 'Code',
    keys: 'Ctrl/Cmd + K',
    label: 'Quick Edit on the editor selection (falls through to the palette with no selection)',
  },
];

const BOARD_SHORTCUTS: ShortcutDoc[] = [
  { section: 'Orchestrate board', keys: 'Tab', label: 'Move between task cards and header controls' },
  { section: 'Orchestrate board', keys: 'Arrow keys', label: 'Navigate cards in the kanban grid' },
  { section: 'Orchestrate board', keys: 'Enter / Space', label: 'Open task chat or plan panel' },
];

const ISSUES_SHORTCUTS: ShortcutDoc[] = [
  { section: 'Issues', keys: 'j / k / Arrow keys', label: 'Move the focused issue' },
  { section: 'Issues', keys: 'Enter', label: 'Open peek for the focused issue' },
  { section: 'Issues', keys: 'Escape', label: 'Close peek, or clear the multi-select' },
  { section: 'Issues', keys: 's', label: 'Change status' },
  { section: 'Issues', keys: 'p', label: 'Change priority' },
  { section: 'Issues', keys: 'u', label: 'Change assignee' },
  { section: 'Issues', keys: 'l', label: 'Change labels' },
  { section: 'Issues', keys: 'g', label: 'Change project' },
  { section: 'Issues', keys: 'A', label: 'Assign an agent — or answer it when it is waiting on you' },
  { section: 'Issues', keys: 'Y', label: 'Accept a triage issue (backlog)' },
  { section: 'Issues', keys: 'N / Backspace', label: 'Decline a triage issue (canceled)' },
  { section: 'Issues', keys: 'C', label: 'New issue' },
  { section: 'Issues', keys: 'Ctrl/Cmd + I', label: 'Quick capture a new issue' },
  { section: 'Issues', keys: 'Alt + ArrowUp / ArrowDown', label: 'Move rank within the group or column' },
  { section: 'Issues', keys: 'Shift + ArrowLeft / ArrowRight', label: 'Move the card to the neighbouring board column' },
];

const ALL_KEYBOARD_SHORTCUTS: ShortcutDoc[] = [
  ...SHELL_SHORTCUTS,
  ...CHAT_SHORTCUTS,
  ...CODE_SHORTCUTS,
  ...BOARD_SHORTCUTS,
  ...ISSUES_SHORTCUTS,
];

/** Full shortcut catalog (includes release-gated apps). */
export const GLOBAL_KEYBOARD_SHORTCUTS: ShortcutDoc[] = ALL_KEYBOARD_SHORTCUTS;

/** Shortcuts shown in the `?` overlay — omits unreleased apps. */
export function getVisibleKeyboardShortcuts(): ShortcutDoc[] {
  return ALL_KEYBOARD_SHORTCUTS.filter((row) => !row.appId || isDeveloperReleased(row.appId));
}

function keyboardHelpIntro(): string {
  return 'Shortcuts are suppressed while you type in a text field.';
}

let sheetOpen = false;
let previousFocus: HTMLElement | null = null;
let escapeHandler: ((event: KeyboardEvent) => void) | null = null;

/** Prefer the foreground app layer; fall back to the OS stage or document body. */
export function resolveKeyboardHelpMount(): HTMLElement {
  const activeLayer = document.querySelector<HTMLElement>('.mn-os-app-layer.is-active');
  if (activeLayer) return activeLayer;
  return document.getElementById('osStage') ?? document.body;
}

function trapFocus(event: KeyboardEvent): void {
  const panel = document.getElementById('shellKeyboardHelpPanel');
  if (!panel || panel.hidden) return;
  if (event.key !== 'Tab') return;
  const nodes = [...panel.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((el) => !el.hasAttribute('disabled'));
  if (nodes.length === 0) return;
  const active = document.activeElement as HTMLElement;
  const index = nodes.indexOf(active);
  event.preventDefault();
  const next = event.shiftKey
    ? nodes[(index - 1 + nodes.length) % nodes.length]
    : nodes[(index + 1) % nodes.length];
  next.focus();
}

function closeKeyboardHelp(): void {
  if (!sheetOpen) return;
  sheetOpen = false;
  const backdrop = document.getElementById('shellKeyboardHelpBackdrop');
  const panel = document.getElementById('shellKeyboardHelpPanel');
  backdrop?.remove();
  panel?.remove();
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
  document.removeEventListener('keydown', trapFocus, true);
  previousFocus?.focus();
  previousFocus = null;
}

/** Split a shortcut string into chip groups (e.g. `Ctrl + K`, `Shift + Tab`). */
function renderKeyChips(keys: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'shell-keyboard-help__keys';

  const alternatives = keys.split(' / ');
  for (let altIndex = 0; altIndex < alternatives.length; altIndex += 1) {
    if (altIndex > 0) {
      const or = document.createElement('span');
      or.className = 'shell-keyboard-help__keys-or';
      or.textContent = '/';
      or.setAttribute('aria-hidden', 'true');
      wrap.appendChild(or);
    }

    const parts = alternatives[altIndex].split(/\s*\+\s*/);
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      if (partIndex > 0) {
        const plus = document.createElement('span');
        plus.className = 'shell-keyboard-help__keys-plus';
        plus.textContent = '+';
        plus.setAttribute('aria-hidden', 'true');
        wrap.appendChild(plus);
      }
      const chip = document.createElement('kbd');
      chip.className = 'shell-keyboard-help__kbd';
      chip.textContent = parts[partIndex].trim();
      wrap.appendChild(chip);
    }
  }

  return wrap;
}

/** Render grouped shortcut sections (each section owns its own definition list). */
function renderShortcutSections(shortcuts: ShortcutDoc[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const groups = new Map<string, ShortcutDoc[]>();

  for (const row of shortcuts) {
    const section = row.section ?? 'Other';
    const bucket = groups.get(section);
    if (bucket) bucket.push(row);
    else groups.set(section, [row]);
  }

  for (const [section, rows] of groups) {
    const group = document.createElement('section');
    group.className = 'shell-keyboard-help__group';

    const heading = document.createElement('h3');
    heading.className = 'shell-keyboard-help__section';
    heading.textContent = section;
    group.appendChild(heading);

    const list = document.createElement('dl');
    list.className = 'shell-keyboard-help__list';
    for (const row of rows) {
      const keys = document.createElement('dt');
      keys.appendChild(renderKeyChips(row.keys));
      const label = document.createElement('dd');
      label.textContent = row.label;
      list.append(keys, label);
    }
    group.appendChild(list);
    fragment.appendChild(group);
  }

  return fragment;
}

/** Open the global shortcuts overlay. */
export function showShellKeyboardHelp(): void {
  if (sheetOpen) {
    closeKeyboardHelp();
    return;
  }

  sheetOpen = true;
  previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const mount = resolveKeyboardHelpMount();
  const scoped = mount !== document.body;

  const backdrop = document.createElement('div');
  backdrop.id = 'shellKeyboardHelpBackdrop';
  backdrop.className = 'shell-keyboard-help-backdrop';
  if (scoped) backdrop.classList.add('is-scoped');
  backdrop.addEventListener('click', closeKeyboardHelp);

  const panel = document.createElement('div');
  panel.id = 'shellKeyboardHelpPanel';
  panel.className = 'shell-keyboard-help-sheet';
  if (scoped) panel.classList.add('is-scoped');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Keyboard shortcuts');
  panel.tabIndex = -1;

  const header = document.createElement('header');
  header.className = 'shell-keyboard-help__header';

  const title = document.createElement('h2');
  title.className = 'shell-keyboard-help__title';
  title.textContent = 'Keyboard shortcuts';
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'shell-keyboard-help__close-icon';
  closeBtn.setAttribute('aria-label', 'Close keyboard shortcuts');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeKeyboardHelp);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const intro = document.createElement('p');
  intro.className = 'shell-keyboard-help__intro';
  intro.textContent = keyboardHelpIntro();
  panel.appendChild(intro);

  const body = document.createElement('div');
  body.className = 'shell-keyboard-help__body';
  body.appendChild(renderShortcutSections(getVisibleKeyboardShortcuts()));
  panel.appendChild(body);

  const footer = document.createElement('footer');
  footer.className = 'shell-keyboard-help__footer';
  footer.innerHTML =
    'Press <kbd class="shell-keyboard-help__kbd shell-keyboard-help__kbd--inline">?</kbd> or <kbd class="shell-keyboard-help__kbd shell-keyboard-help__kbd--inline">Esc</kbd> to close';
  panel.appendChild(footer);

  escapeHandler = (event: KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === '?') {
      event.preventDefault();
      closeKeyboardHelp();
    }
  };
  document.addEventListener('keydown', escapeHandler, true);
  document.addEventListener('keydown', trapFocus, true);

  mount.append(backdrop, panel);
  closeBtn.focus();
}

let helpBound = false;

/** Bind global `?` shortcut for the shortcuts overlay. */
export function initShellKeyboardHelp(): void {
  if (helpBound) return;
  helpBound = true;

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key !== '?') return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    showShellKeyboardHelp();
  });
}
