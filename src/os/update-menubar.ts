/**
 * Menubar update pill + popover (MIN-384). Hidden when up to date; `↓ N%` while an
 * update downloads; accent "Restart · x.y.z" when ready. Mirrors the notifications
 * popover pattern in notifications-menu.ts.
 */

import '../styles/update-menubar.css';
import {
  getUpdaterApi,
  releaseNotesExcerpt,
  watchUpdaterStatus,
  type MinnowUpdaterStatus,
} from '../electron/updater-client';
import { launchApp } from './router';
import {
  registerChromePopover,
  unregisterChromePopover,
} from '../ui/preview-electron-visibility';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Wire the menubar update slot. Returns cleanup. No-op outside the Electron shell. */
export function initUpdateMenubarPill(slot: HTMLElement): () => void {
  slot.hidden = true;
  if (!getUpdaterApi()) {
    return () => {};
  }

  let latest: MinnowUpdaterStatus | null = null;
  let panel: HTMLDivElement | null = null;
  let menuOpen = false;
  let outsideHandler: ((e: PointerEvent) => void) | null = null;
  let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  const pill = el('button', 'mn-os-mb-update-pill');
  pill.type = 'button';
  pill.setAttribute('aria-haspopup', 'dialog');
  pill.setAttribute('aria-expanded', 'false');
  pill.setAttribute('aria-live', 'polite');
  slot.appendChild(pill);

  function detachGlobalListeners(): void {
    if (outsideHandler) {
      document.removeEventListener('pointerdown', outsideHandler, true);
      outsideHandler = null;
    }
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler, true);
      escapeHandler = null;
    }
  }

  function closeMenu(): void {
    if (!menuOpen) return;
    menuOpen = false;
    unregisterChromePopover();
    detachGlobalListeners();
    panel?.remove();
    panel = null;
    pill.setAttribute('aria-expanded', 'false');
    pill.classList.remove('is-open');
  }

  function positionPanel(): void {
    if (!panel) return;
    const rect = pill.getBoundingClientRect();
    const margin = 8;
    panel.style.top = `${rect.bottom + 4}px`;
    const panelWidth = panel.offsetWidth || panel.getBoundingClientRect().width;
    let left = rect.right - panelWidth;
    left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));
    panel.style.left = `${left}px`;
  }

  function buildPanel(status: MinnowUpdaterStatus): HTMLDivElement {
    const ready = status.state === 'ready';
    const menu = el('div', 'mn-os-update-menu');
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', ready ? 'Update ready' : 'Downloading update');

    menu.appendChild(
      el('div', 'mn-os-update-menu__title', ready ? 'Update ready' : 'Downloading update'),
    );

    const version = status.pendingVersion ?? 'new version';
    menu.appendChild(
      el(
        'p',
        'mn-os-update-menu__lead',
        ready
          ? `Minnow ${version} is downloaded.`
          : `Downloading ${version} · ${status.progressPercent ?? 0}%`,
      ),
    );

    const excerpt = releaseNotesExcerpt(status.releaseNotes, 3);
    if (excerpt.length > 0) {
      menu.appendChild(el('div', 'mn-os-update-menu__notes-title', 'Highlights'));
      const list = el('ul', 'mn-os-update-menu__notes');
      for (const line of excerpt) {
        list.appendChild(el('li', 'mn-os-update-menu__note', line));
      }
      menu.appendChild(list);
    }

    if (ready) {
      menu.appendChild(
        el('p', 'mn-os-update-menu__warning', 'Active sessions will close and Minnow will reopen.'),
      );
    }

    const actions = el('div', 'mn-os-update-menu__actions');
    if (ready) {
      const restartBtn = el('button', 'mn-os-update-menu__restart', 'Restart now');
      restartBtn.type = 'button';
      restartBtn.addEventListener('click', () => {
        void getUpdaterApi()?.restart();
        closeMenu();
      });
      actions.appendChild(restartBtn);
    }
    const laterBtn = el('button', 'mn-os-update-menu__later', 'Later');
    laterBtn.type = 'button';
    laterBtn.addEventListener('click', () => closeMenu());
    actions.appendChild(laterBtn);
    menu.appendChild(actions);

    const settingsLink = el('button', 'mn-os-update-menu__settings', 'Open Settings →');
    settingsLink.type = 'button';
    settingsLink.addEventListener('click', () => {
      closeMenu();
      launchApp('settings');
    });
    menu.appendChild(settingsLink);

    return menu;
  }

  function openMenu(): void {
    if (!latest || (latest.state !== 'ready' && latest.state !== 'downloading')) return;
    closeMenu();
    panel = buildPanel(latest);
    document.body.appendChild(panel);
    menuOpen = true;
    registerChromePopover();
    pill.setAttribute('aria-expanded', 'true');
    pill.classList.add('is-open');
    positionPanel();

    outsideHandler = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (panel?.contains(target) || pill.contains(target)) return;
      closeMenu();
    };
    document.addEventListener('pointerdown', outsideHandler, true);

    escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeMenu();
    };
    document.addEventListener('keydown', escapeHandler, true);
  }

  pill.addEventListener('click', () => {
    if (menuOpen) closeMenu();
    else openMenu();
  });

  function applyStatus(status: MinnowUpdaterStatus): void {
    latest = status;

    if (status.state === 'downloading') {
      slot.hidden = false;
      pill.classList.remove('is-ready');
      pill.classList.add('is-downloading');
      pill.textContent = `↓ ${status.progressPercent ?? 0}%`;
      pill.setAttribute(
        'aria-label',
        `Downloading update ${status.pendingVersion ?? ''} · ${status.progressPercent ?? 0}%`.trim(),
      );
      if (menuOpen && panel) {
        const lead = panel.querySelector('.mn-os-update-menu__lead');
        if (lead) {
          lead.textContent = `Downloading ${status.pendingVersion ?? 'new version'} · ${status.progressPercent ?? 0}%`;
        }
      }
      return;
    }

    if (status.state === 'ready') {
      const wasReady = pill.classList.contains('is-ready');
      slot.hidden = false;
      pill.classList.remove('is-downloading');
      pill.classList.add('is-ready');
      pill.textContent = `Restart · ${status.pendingVersion ?? ''}`.trim();
      pill.setAttribute(
        'aria-label',
        `Restart to update Minnow to version ${status.pendingVersion ?? 'latest'}`,
      );
      if (menuOpen && !wasReady) {
        closeMenu();
        openMenu();
      }
      return;
    }

    slot.hidden = true;
    pill.classList.remove('is-ready', 'is-downloading');
    closeMenu();
  }

  const stopWatching = watchUpdaterStatus(applyStatus);

  return () => {
    stopWatching();
    closeMenu();
    pill.remove();
    slot.hidden = true;
  };
}
