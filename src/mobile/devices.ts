import { disconnectDevice, fetchHostInfo } from '../api/device-auth';
import { getPermissionLevelCached, loadToolSecurityMeta, onToolSecurityMetaChange } from '../config/tool-security-meta';
import { PERMISSION_LEVEL_META, PERMISSION_LEVELS, type PermissionLevel } from '../lib/permissions.mjs';
import { PHONE_ALERTS, phoneAlertEnabled, setPhoneAlertEnabled } from '../notifications/phone-prefs';
import { createSegmentedControl, createSwitch } from '../ui/components';
import { screenHeader } from './chrome';
import { el } from './dom';
import { pushScreen, screenFrame } from './nav';
import { openActionSheet } from './sheet';

/** The paired phone's own connection and preferences. */
export function openPhoneDevice(): void {
  const title = el('strong', { text: 'Checking connection…' });
  const latency = el('span', { className: 'm-mono m-device__latency' });
  const copy = el('p', { className: 'm-device__copy' });
  const connection = el('span', { className: 'm-device__transport', attrs: { hidden: true } });
  const card = el('section', { className: 'm-device__connection', attrs: { 'aria-label': 'Connection' } },
    el('div', { className: 'm-device__connection-title', attrs: { role: 'status' } },
      el('span', { className: 'm-device__dot', attrs: { 'aria-hidden': 'true' } }), title, latency),
    copy,
    connection,
  );
  const levels = createSegmentedControl({
    ariaLabel: 'Permission level',
    className: 'm-device__permissions',
    options: PERMISSION_LEVELS.map(value => ({ value, label: PERMISSION_LEVEL_META[value].label })),
    value: getPermissionLevelCached(),
    onChange: (value) => void changePermission(value as PermissionLevel),
  });
  const permissionHelp = el('p', { className: 'm-device__copy', text: 'Applies to every chat, agent and device.' });
  const alerts = el('div', { className: 'm-device__alerts' });
  for (const alert of PHONE_ALERTS) {
    const control = createSwitch({
      ariaLabel: alert.label,
      checked: phoneAlertEnabled(alert.id),
      size: 'sm',
      className: 'm-device__switch',
      onChange: checked => setPhoneAlertEnabled(alert.id, checked),
    });
    alerts.append(el('div', { className: 'm-device__alert' },
      el('div', null, el('span', { text: alert.label }), el('span', { className: 'm-device__copy', text: alert.description })),
      control.root,
    ));
  }
  const disconnect = el('button', {
    className: 'm-device__disconnect',
    text: 'Disconnect this phone',
    attrs: { type: 'button' },
    on: { click: () => openActionSheet('Disconnect from Minnow?', [
      { label: 'Disconnect this phone', glyph: 'fi-rr-sign-out-alt', danger: true, run: async () => {
        try {
          await disconnectDevice();
        } catch (error) {
          const { showToast } = await import('../ui/toast');
          showToast(error instanceof Error ? error.message : 'Could not disconnect this phone', 'error');
        }
      } },
    ]) },
  });
  const body = el('div', { className: 'm-screen__body m-device__body' },
    card,
    el('section', { className: 'm-device__section' },
      el('h2', { text: 'Permission level' }), levels.root, permissionHelp),
    el('section', { className: 'm-device__section' },
      el('h2', { text: 'Notify this phone' }), alerts),
    disconnect,
  );
  const key = 'app:this-phone';
  let revision = 0;
  let changingPermission = false;
  let unsubscribe: (() => void) | undefined;

  async function changePermission(level: PermissionLevel): Promise<void> {
    if (changingPermission) return;
    changingPermission = true;
    for (const value of PERMISSION_LEVELS) levels.setDisabled(value, true);
    try {
      const { choosePermissionLevel } = await import('../ui/permission-level');
      await choosePermissionLevel(level);
    } finally {
      changingPermission = false;
      for (const value of PERMISSION_LEVELS) levels.setDisabled(value, false);
      levels.setValue(getPermissionLevelCached(), { silent: true });
    }
  }

  async function refresh(): Promise<void> {
    const current = ++revision;
    const started = performance.now();
    const info = await fetchHostInfo();
    if (current !== revision) return;
    card.classList.toggle('is-connected', info.paired);
    title.textContent = info.paired ? `Connected to ${info.hostName}` : 'Could not check the connection';
    latency.textContent = info.paired ? `${Math.max(1, Math.round(performance.now() - started))} ms` : '';
    const home = info.ingress === 'lan';
    connection.hidden = !info.paired;
    connection.textContent = home ? 'Home network' : 'Tailscale';
    copy.textContent = info.paired
      ? home ? 'Reach your computer on this home network. Manage phone access on the computer under Settings › Devices.'
        : 'Reach your computer through Tailscale. Manage phone access on the computer under Settings › Devices.'
      : 'Check that your computer is running Minnow and this phone is online.';
  }

  function stop(): void {
    revision++;
    unsubscribe?.();
    unsubscribe = undefined;
    window.removeEventListener('minnow-host-reconnected', refresh);
  }

  pushScreen({
    key,
    el: screenFrame({ key, className: 'm-device', header: screenHeader({ title: 'This phone', back: true }).el, body }),
    onShow() {
      unsubscribe ??= onToolSecurityMetaChange(meta => levels.setValue(meta.permissionLevel, { silent: true }));
      void loadToolSecurityMeta({ refresh: true }).then(meta => levels.setValue(meta.permissionLevel, { silent: true }));
      window.addEventListener('minnow-host-reconnected', refresh);
      void refresh();
    },
    onHide: stop,
    dispose: stop,
  });
}
