import { createIcon, type IconName } from './icon';

export interface IssuesWorkflowMenuItem {
  id: string;
  label: string;
  /** Secondary line under the mode label. */
  hint?: string;
  disabled?: boolean;
  onSelect: (context?: { trigger: HTMLButtonElement; clientX: number; clientY: number }) => void;
}

export interface IssuesWorkflowDropdownOptions {
  label: string;
  ariaLabel: string;
  items: IssuesWorkflowMenuItem[];
  disabled?: boolean;
  /** Primary styling for the foreground control. */
  primary?: boolean;
  /** Leading glyph so the two dispatch controls are told apart at a glance. */
  icon?: IconName;
}

let openMenu: HTMLElement | null = null;
let openTrigger: HTMLButtonElement | null = null;
let outsideHandler: ((event: PointerEvent) => void) | null = null;
let escapeHandler: ((event: KeyboardEvent) => void) | null = null;

/** Close any open Issues workflow menu. */
export function closeIssuesWorkflowMenu(): void {
  if (outsideHandler) {
    document.removeEventListener('pointerdown', outsideHandler, true);
    outsideHandler = null;
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
  openMenu?.remove();
  openMenu = null;
  openTrigger?.setAttribute('aria-expanded', 'false');
  openTrigger = null;
}

function positionMenu(anchor: HTMLElement, menu: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  const menuHeight = menu.offsetHeight || menu.getBoundingClientRect().height;
  const menuWidth = menu.offsetWidth || menu.getBoundingClientRect().width;

  let top = rect.bottom + gap;
  if (top + menuHeight > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - menuHeight - gap);
  }

  let left = rect.left;
  if (left + menuWidth > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - menuWidth - margin);
  }

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function chevronSvg(): HTMLElement {
  return createIcon('chevronDown', { size: 12, className: 'issues-workflow-menu__chevron' });
}

function openMenuForTrigger(
  trigger: HTMLButtonElement,
  items: IssuesWorkflowMenuItem[],
): void {
  closeIssuesWorkflowMenu();

  const triggerRect = trigger.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'issues-workflow-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', trigger.getAttribute('aria-label') ?? 'Chat mode');

  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'issues-workflow-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.dataset.id = item.id;
    btn.disabled = Boolean(item.disabled);

    const label = document.createElement('span');
    label.className = 'issues-workflow-menu__item-label';
    label.textContent = item.label;
    btn.appendChild(label);

    if (item.hint?.trim()) {
      const hint = document.createElement('span');
      hint.className = 'issues-workflow-menu__item-hint';
      hint.textContent = item.hint;
      btn.appendChild(hint);
    }

    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (btn.disabled) return;
      const trigger = openTrigger;
      closeIssuesWorkflowMenu();
      item.onSelect(trigger ? {
        trigger,
        clientX: triggerRect.left,
        clientY: triggerRect.bottom,
      } : undefined);
    });
    menu.appendChild(btn);
    buttons.push(btn);
  }

  document.body.appendChild(menu);
  positionMenu(trigger, menu);

  openMenu = menu;
  openTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');

  outsideHandler = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (menu.contains(target) || trigger.contains(target)) return;
    closeIssuesWorkflowMenu();
  };
  document.addEventListener('pointerdown', outsideHandler, true);

  escapeHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    closeIssuesWorkflowMenu();
    trigger.focus();
  };
  document.addEventListener('keydown', escapeHandler, true);

  const firstEnabled = buttons.findIndex((btn) => !btn.disabled);
  if (firstEnabled >= 0) buttons[firstEnabled]?.focus();
}

/** Build a split-style dropdown trigger for Issues workflow actions. */
export function createIssuesWorkflowDropdown(
  options: IssuesWorkflowDropdownOptions,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'issues-workflow-menu-wrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = options.primary
    ? 'issues-btn issues-btn--primary issues-workflow-menu__trigger'
    : 'issues-btn issues-workflow-menu__trigger';
  trigger.setAttribute('aria-label', options.ariaLabel);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.disabled = Boolean(options.disabled);

  const label = document.createElement('span');
  label.className = 'issues-workflow-menu__label';
  label.textContent = options.label;
  if (options.icon) {
    trigger.appendChild(
      createIcon(options.icon, { size: 13, className: 'issues-workflow-menu__icon' }),
    );
  }
  trigger.append(label, chevronSvg());

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (trigger.disabled) return;
    if (openTrigger === trigger && openMenu) {
      closeIssuesWorkflowMenu();
      return;
    }
    openMenuForTrigger(trigger, options.items);
  });

  wrap.appendChild(trigger);
  return wrap;
}
