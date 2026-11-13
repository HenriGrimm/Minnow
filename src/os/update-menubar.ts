import '../styles/update-menubar.css';
import '../styles/settings-updates.css';
import { updateCenter, type UpdateCenter } from './update-center';
import { launchApp } from './router';
import { getAppWindowId } from './app-window';
import { iconHtml } from '../ui/icon';
import { openPopover, type PopoverHandle } from '../ui/components/popover';
import { openShellOverlay, shellOverlayClosed, bindShellOverlayTrigger } from '../ui/shell-overlay-state';
import { createUpdateRows, el, updateButton, updateSummary } from '../ui/update-rows';

const announced = new Set<string>();

export function initUpdateMenubarPill(slot: HTMLElement, center: UpdateCenter = updateCenter): () => void {
  slot.hidden = false;
  const trigger = el('button', 'mn-os-mb-icon mn-os-mb-update-pill');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.innerHTML = iconHtml('download', { size: 16 });
  const badge = el('span', 'mn-os-mb-update-count');
  badge.setAttribute('aria-hidden', 'true');
  trigger.append(badge);
  const live = el('span', 'updates-sr-only');
  live.setAttribute('role', 'status');
  slot.append(trigger, live);
  const unbind = bindShellOverlayTrigger(trigger, 'update');
  let panel: PopoverHandle | undefined;
  let renderPanel: (() => void) | undefined;
  const boundApp = getAppWindowId();
  const canOpenSettings = !boundApp || boundApp === 'settings';

  function canAnchor(): boolean {
    return trigger.isConnected && !trigger.closest('[hidden], [inert]')
      && trigger.getClientRects().length > 0 && window.getComputedStyle(trigger).visibility === 'visible';
  }

  function open(): boolean {
    if (panel) return true;
    if (!canAnchor()) return false;
    const content = el('div', 'updates-popover');
    const head = el('header', 'updates-popover__header');
    const heading = el('div');
    const summary = el('p', 'updates-summary');
    summary.setAttribute('role', 'status');
    heading.append(el('h2', 'updates-popover__title', 'Updates'), summary);
    const check = updateButton('Check', () => { void center.check(); });
    check.setAttribute('aria-label', 'Check for updates');
    head.append(heading, check);
    const rows = createUpdateRows(center, 'popover');
    content.append(head, rows.root);
    if (canOpenSettings) {
      const footer = el('footer', 'updates-popover__footer');
      const settings = updateButton('Open Updates in Settings', () => {
        panel?.close();
        launchApp('settings', { settingsSection: 'updates' });
      });
      settings.append(el('span', '', ' →'));
      footer.append(settings);
      content.append(footer);
    }

    openShellOverlay('update', () => panel?.close());
    if (!canAnchor()) {
      shellOverlayClosed('update');
      return false;
    }
    panel = openPopover({
      anchor: trigger,
      placement: 'bottom-end',
      ariaLabel: 'Updates',
      className: 'mn-os-update-menu',
      content,
      onClose: () => {
        panel = undefined;
        renderPanel = undefined;
        shellOverlayClosed('update');
      },
    });
    renderPanel = () => {
      summary.textContent = updateSummary(center);
      check.disabled = center.state.cliChecking || center.state.appChecking || center.state.app?.state === 'checking'
        || (center.state.cliRestricted && !center.state.app?.supported);
      check.textContent = center.state.cliChecking || center.state.appChecking ? 'Checking…' : 'Check';
      rows.render();
      reposition();
    };
    renderPanel();
    void center.checkCli();
    return true;
  }

  trigger.onclick = () => { if (panel) panel.close('anchor'); else open(); };
  function reposition(): void {
    if (!panel) return;
    if (canAnchor()) panel.reposition();
    else panel.close();
  }

  function sync(): void {
    const keys = center.pendingUpdates();
    const count = keys.length;
    const label = count ? count + ' update' + (count === 1 ? '' : 's') + ' available' : 'Updates';
    if (trigger.getAttribute('aria-label') !== label) {
      trigger.setAttribute('aria-label', label);
      trigger.title = label;
    }
    badge.hidden = count === 0;
    badge.textContent = String(count);
    trigger.classList.toggle('has-updates', count > 0);
    renderPanel?.();
    if (!canAnchor() || document.hidden || !keys.some(key => !announced.has(key))) return;
    void import('../ui/toast').then(({ notify }) => {
      if (!canAnchor() || document.hidden) return;
      const pending = center.pendingUpdates();
      if (!pending.some(key => !announced.has(key))) return;
      for (const key of pending) announced.add(key);
      const title = trigger.getAttribute('aria-label') ?? 'Updates available';
      live.textContent = title;
      if (panel) return;
      notify({ tone: 'info', icon: 'download', source: 'Updates', title,
        dedupeKey: 'software-updates',
        actions: [{ label: 'View updates', run: () => {
          if (open()) return;
          if (!canOpenSettings) return false;
          launchApp('settings', { settingsSection: 'updates' });
        } }] });
    });
  }
  window.addEventListener('minnow:graphite-workspace-changed', sync);
  window.addEventListener('minnow:workspace-gate-changed', sync);
  window.addEventListener('resize', sync);
  document.addEventListener('visibilitychange', sync);
  const stop = center.subscribe(sync);

  return () => {
    window.removeEventListener('minnow:graphite-workspace-changed', sync);
    window.removeEventListener('minnow:workspace-gate-changed', sync);
    window.removeEventListener('resize', sync);
    document.removeEventListener('visibilitychange', sync);
    stop();
    panel?.close();
    unbind();
    trigger.remove();
    live.remove();
    slot.hidden = true;
  };
}
