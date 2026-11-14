import {
  closeContextMenu,
  openContextMenu,
  type ContextMenuHandle,
  type MenuItem,
} from './context-menu';

export interface IssuesContextMenuItem {
  id: string;
  label: string;
  /** Secondary line under the label (mode hints). */
  hint?: string;
  /** Destructive styling (delete). */
  danger?: boolean;
  disabled?: boolean;
  /** Renders a nested menu instead of an action; resolved when it opens. */
  submenu?: IssuesContextMenuItem[] | (() => IssuesContextMenuItem[]);
  /** Draws a divider above this row. */
  separatorBefore?: boolean;
  /** Leading Uicons class for status (and similar) rows. */
  iconClass?: string;
  /** Checkmark for toggle rows (e.g. repo membership). */
  checked?: boolean;
  onSelect?: () => void | Promise<void>;
}

export interface OpenIssuesContextMenuOptions {
  /** Viewport coordinates for the menu origin. */
  clientX?: number;
  clientY?: number;
  /** Anchor element for inline property editing; wins over x/y. */
  anchor?: HTMLElement | null;
  items: IssuesContextMenuItem[];
  /** Element that opened the menu; receives focus on close. */
  restoreFocus?: HTMLElement | null;
  /** Optional host; defaults to document.body. */
  mount?: HTMLElement;
  /** Accessible name; defaults to "Issue actions". */
  label?: string;
}

export type IssuesContextMenuHandle = ContextMenuHandle;

function toMenuItems(items: IssuesContextMenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (item.separatorBefore && out.length > 0) out.push({ kind: 'separator' });
    if (item.submenu) {
      const source = item.submenu;
      out.push({
        kind: 'submenu',
        id: item.id,
        label: item.label,
        hint: item.hint,
        disabled: item.disabled,
        items: () => toMenuItems(typeof source === 'function' ? source() : source),
      });
      continue;
    }
    out.push({
      id: item.id,
      label: item.label,
      hint: item.hint,
      danger: item.danger,
      disabled: item.disabled,
      iconClass: item.iconClass,
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      onSelect: item.onSelect ?? (() => {}),
    });
  }
  return out;
}

/** Close any open Issues context menu. */
export function closeIssuesContextMenu(): void {
  closeContextMenu();
}

/** Open a context menu at the pointer (or keyboard synthetic) coordinates. */
export function openIssuesContextMenu(
  options: OpenIssuesContextMenuOptions,
): IssuesContextMenuHandle {
  return openContextMenu({
    items: toMenuItems(options.items),
    label: options.label ?? 'Issue actions',
    clientX: options.clientX,
    clientY: options.clientY,
    anchor: options.anchor,
    restoreFocus: options.restoreFocus,
    mount: options.mount,
  });
}
