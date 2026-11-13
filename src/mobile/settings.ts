import { fetchHostInfo } from '../api/device-auth';
import { getPermissionLevelCached, loadToolSecurityMeta } from '../config/tool-security-meta';
import { PERMISSION_LEVEL_META } from '../lib/permissions.mjs';
import { loadDefaultModelValue, modelSelectionLabel, readPersistedDefaultModelValue } from '../models/selection';
import { loadNotificationPrefs } from '../notifications/prefs';
import { getMode, getStoredTheme } from '../theme';
import { fetchDiagnosticsHealth } from '../ui/health-strip';
import { createIcon, type IconName } from '../ui/icon';
import { openPhoneApp } from './apps';
import { iconButton, screenHeader } from './chrome';
import { el } from './dom';
import { pushScreen, screenFrame } from './nav';

/** The paired device starts with the short Settings list. The full catalog is one tap away. */
export function openPhoneSettings(): void {
  const list = el('nav', { className: 'm-phone-settings__list', attrs: { 'aria-label': 'Settings' } });
  const rows = [
    ['appearance', 'Appearance', 'palette', () => openPhoneApp('settings', { settingsSection: 'appearance' })],
    ['permissions', 'Agents and permissions', 'shieldCheck', () => openPhoneApp('settings', { settingsSection: 'agent-center' })],
    ['models', 'Models and connections', 'appModels', () => openPhoneApp('models', { modelsSection: 'server' })],
    ['notifications', 'Notifications', 'bell', () => openPhoneApp('settings', { settingsSection: 'notifications' })],
    ['devices', 'This phone', 'deviceMobile', () => openPhoneApp('settings', { settingsSection: 'devices' })],
    ['backups', 'Backups', 'archive', () => openPhoneApp('settings', { settingsSection: 'backups' })],
    ['about', 'About', 'info', () => openPhoneApp('settings', { settingsSection: 'about' })],
  ] as const satisfies readonly (readonly [string, string, IconName, () => void])[];
  const values = new Map<typeof rows[number][0], HTMLElement>();
  for (const [id, label, icon, open] of rows) {
    const value = el('span', { className: 'm-phone-settings__value' });
    values.set(id, value);
    list.appendChild(el(
      'button',
      {
        className: 'm-phone-settings__row',
        attrs: { type: 'button' },
        dataset: { setting: id },
        on: { click: open },
      },
      createIcon(icon, { size: 14 }),
      el('span', { className: 'm-phone-settings__label', text: label }),
      value,
      createIcon('chevronRight', { size: 14 }),
    ));
  }

  const header = screenHeader({
    title: 'Settings', back: true,
    actions: [iconButton('fi-rr-settings-sliders', 'All settings', () => openPhoneApp('settings', { allSettings: true }))],
  });
  const body = el('div', { className: 'm-screen__body m-phone-settings__body' }, list);
  const root = screenFrame({ key: 'settings-landing', className: 'm-phone-settings', header: header.el, body });
  let revision = 0;

  function setValue(id: typeof rows[number][0], value: string): void {
    const node = values.get(id)!;
    node.textContent = value;
    node.title = value;
  }

  function modelLabel(): string {
    return modelSelectionLabel(readPersistedDefaultModelValue()) || 'No model';
  }

  function refresh(): void {
    const current = ++revision;
    const mode = getMode(getStoredTheme());
    const notifications = loadNotificationPrefs();
    const enabledCount = [notifications.chatEnabled, notifications.tasksEnabled, notifications.backgroundEnabled].filter(Boolean).length;
    setValue('appearance', mode === 'light' ? 'Light' : 'Dark');
    setValue('permissions', PERMISSION_LEVEL_META[getPermissionLevelCached()].label);
    setValue('notifications', notifications.enabled && !notifications.muted ? `${enabledCount} on` : 'Off');
    setValue('models', modelLabel());
    setValue('backups', 'On host');

    void loadToolSecurityMeta({ refresh: true }).then(({ permissionLevel }) => {
      if (current === revision) setValue('permissions', PERMISSION_LEVEL_META[permissionLevel].label);
    });
    void loadDefaultModelValue().then(() => {
      if (current === revision) setValue('models', modelLabel());
    }).catch(() => {});
    void fetchHostInfo().then(info => {
      if (current !== revision) return;
      setValue('devices', info.paired ? info.ingress === 'lan' ? 'Home network' : 'Tailscale' : 'Offline');
    });
    void fetchDiagnosticsHealth().then(health => {
      if (current === revision && health?.version) setValue('about', `Minnow ${health.version}`);
    });
  }

  function stop(): void {
    revision++;
    window.removeEventListener('minnow-host-reconnected', refresh);
  }

  pushScreen({
    key: 'app:settings:landing', el: root,
    onShow() {
      window.addEventListener('minnow-host-reconnected', refresh);
      refresh();
    },
    onHide: stop,
    dispose: stop,
  });
}
