/**
 * System-wide permission level: the composer pill + menu, Shift+Tab cycling,
 * and the shared Full-access confirmation.
 *
 * The level is global (config.json → toolSecurity.permissionLevel). Picking
 * one in the composer changes the default everywhere — Settings, phones,
 * sub-agents and the Scheduler all read the same value.
 */

import {
  PERMISSION_LEVELS,
  PERMISSION_LEVEL_META,
  type PermissionLevel,
} from '../lib/permissions.mjs';
import {
  getPermissionLevelCached,
  loadToolSecurityMeta,
  onToolSecurityMetaChange,
  setPermissionLevel,
} from '../config/tool-security-meta';
import { appConfirm } from './app-dialog';
import { createIcon, type IconName } from './icon';
import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import { setStatus } from './status';

const FULL_ACCESS_ACK_KEY = 'minnow.permissions.fullAccessAcknowledged';

export const PERMISSION_LEVEL_ICON: Readonly<Record<PermissionLevel, IconName>> = {
  manual: 'permManual',
  auto: 'permAuto',
  full: 'permFull',
};

function fullAccessAcknowledged(): boolean {
  try {
    return localStorage.getItem(FULL_ACCESS_ACK_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberFullAccessAcknowledged(): void {
  try {
    localStorage.setItem(FULL_ACCESS_ACK_KEY, '1');
  } catch {
    /* private mode: ask again next time */
  }
}

/** Ask once (per device) before switching to Full access. */
export async function confirmFullAccess(): Promise<boolean> {
  if (fullAccessAcknowledged()) return true;
  const ok = await appConfirm(
    'Agents will run commands, edit files anywhere on this computer, use the network, and call MCP servers and plugins without asking.\n\nMinnow still never lets an agent touch its own encryption key or stored secrets.',
    { title: 'Turn on Full access?', confirmLabel: 'Turn on Full access', danger: true },
  );
  if (ok) rememberFullAccessAcknowledged();
  return ok;
}

/** Change the level from any surface (pill, Settings, Shift+Tab, approval card). */
export async function choosePermissionLevel(level: PermissionLevel): Promise<boolean> {
  if (level === getPermissionLevelCached()) return true;
  if (level === 'full' && !(await confirmFullAccess())) return false;
  try {
    await setPermissionLevel(level);
    setStatus('ok', `Permissions: ${PERMISSION_LEVEL_META[level].label}`);
    return true;
  } catch {
    setStatus('err', 'Could not save the permission level');
    return false;
  }
}

/** Next level for Shift+Tab: Manual → Auto → Full → Manual. */
export function nextPermissionLevel(level: PermissionLevel): PermissionLevel {
  const i = PERMISSION_LEVELS.indexOf(level);
  return PERMISSION_LEVELS[(i + 1) % PERMISSION_LEVELS.length]!;
}

// ── Menu ─────────────────────────────────────────────────────────────────────

export interface PermissionMenuOptions {
  /** Anchor the menu opens against. */
  anchor: HTMLElement;
  /** Called after a level was applied (or the menu closed). */
  onClose?: () => void;
}

let openMenu: { root: HTMLElement; close: () => void } | null = null;

export function closePermissionMenu(): void {
  openMenu?.close();
}

/** Build the three-row level list (shared by the composer menu and the slash submenu). */
export function buildPermissionLevelList(
  current: PermissionLevel,
  onPick: (level: PermissionLevel) => void,
): HTMLElement {
  const list = document.createElement('div');
  list.className = 'permission-menu__list';
  list.setAttribute('role', 'menu');
  for (const level of PERMISSION_LEVELS) {
    const meta = PERMISSION_LEVEL_META[level];
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `permission-menu__item permission-menu__item--${level}`;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', level === current ? 'true' : 'false');
    item.dataset.level = level;

    const icon = createIcon(PERMISSION_LEVEL_ICON[level], { className: 'permission-menu__icon' });
    const text = document.createElement('span');
    text.className = 'permission-menu__text';
    const label = document.createElement('span');
    label.className = 'permission-menu__label';
    label.textContent = meta.label;
    const desc = document.createElement('span');
    desc.className = 'permission-menu__desc';
    desc.textContent = meta.description;
    text.append(label, desc);
    const check = createIcon('check', { className: 'permission-menu__check' });
    item.append(icon, text, check);
    item.addEventListener('click', () => onPick(level));
    list.appendChild(item);
  }
  return list;
}

/** Open the level menu above (or below) an anchor. */
export function openPermissionMenu(options: PermissionMenuOptions): void {
  closePermissionMenu();
  const { anchor } = options;
  const root = document.createElement('div');
  root.className = 'permission-menu';
  root.setAttribute('aria-label', 'Permissions');
  markPreviewOccluder(root, 'menu');

  const header = document.createElement('div');
  header.className = 'permission-menu__header';
  header.textContent = 'Permissions';
  const hint = document.createElement('kbd');
  hint.className = 'permission-menu__kbd';
  hint.textContent = '⇧Tab';
  hint.title = 'Shift+Tab in the composer cycles levels';
  header.appendChild(hint);

  const list = buildPermissionLevelList(getPermissionLevelCached(), (level) => {
    close();
    void choosePermissionLevel(level);
  });

  const footer = document.createElement('p');
  footer.className = 'permission-menu__footer';
  footer.textContent = 'Applies to every chat, agent and device.';

  root.append(header, list, footer);
  document.body.appendChild(root);

  // Position: prefer above the anchor (composer sits at the bottom).
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  let top = rect.top - height - 6;
  if (top < margin) top = Math.min(window.innerHeight - height - margin, rect.bottom + 6);
  let left = rect.left;
  if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - width - margin);
  root.style.top = `${Math.round(top)}px`;
  root.style.left = `${Math.round(left)}px`;

  anchor.setAttribute('aria-expanded', 'true');

  const items = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('.permission-menu__item')];
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      anchor.focus();
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const nodes = items();
      const i = nodes.indexOf(document.activeElement as HTMLButtonElement);
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      nodes[(i + step + nodes.length) % nodes.length]?.focus();
      return;
    }
    if (/^[1-3]$/.test(ev.key) && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      items()[Number(ev.key) - 1]?.click();
    }
  };
  const onOutside = (ev: PointerEvent): void => {
    const t = ev.target;
    if (t instanceof Node && (root.contains(t) || anchor.contains(t))) return;
    close();
  };
  function close(): void {
    if (openMenu?.root !== root) return;
    openMenu = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    unmarkPreviewOccluder(root);
    root.remove();
    anchor.setAttribute('aria-expanded', 'false');
    options.onClose?.();
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  openMenu = { root, close };
  const selected = items().find((n) => n.getAttribute('aria-checked') === 'true') ?? items()[0];
  requestAnimationFrame(() => selected?.focus());
}

// ── Composer pill ────────────────────────────────────────────────────────────

let pill: HTMLButtonElement | null = null;

function syncPill(level: PermissionLevel): void {
  if (!pill) return;
  const meta = PERMISSION_LEVEL_META[level];
  pill.dataset.level = level;
  pill.replaceChildren(createIcon(PERMISSION_LEVEL_ICON[level], { className: 'permission-pill__icon' }));
  pill.title = `${meta.label} — ${meta.description}. Shift+Tab to change.`;
  pill.setAttribute('aria-label', `Permissions: ${meta.label}`);
}

/** Mount the pill into `#composerPermissionAnchor` and wire Shift+Tab on the composer. */
export function initComposerPermissionPill(): void {
  const anchor = document.getElementById('composerPermissionAnchor');
  if (!anchor || pill) return;
  pill = document.createElement('button');
  pill.type = 'button';
  pill.id = 'composerPermissionPill';
  pill.className = 'permission-pill';
  pill.setAttribute('aria-haspopup', 'menu');
  pill.setAttribute('aria-expanded', 'false');
  pill.addEventListener('click', () => {
    if (openMenu) closePermissionMenu();
    else openPermissionMenu({ anchor: pill! });
  });
  anchor.appendChild(pill);
  syncPill(getPermissionLevelCached());
  void loadToolSecurityMeta().then((meta) => syncPill(meta.permissionLevel));
  onToolSecurityMetaChange((meta) => syncPill(meta.permissionLevel));

  const input = document.getElementById('msgInput');
  input?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab' || !ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.isComposing) return;
    ev.preventDefault();
    void choosePermissionLevel(nextPermissionLevel(getPermissionLevelCached()));
  });
}
