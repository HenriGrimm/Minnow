import { formatLastChecked, getUpdaterApi } from '../electron/updater-client';
import { updateCenter, type UpdateCenter } from '../os/update-center';
import { launchApp } from '../os/router';
import { createSettingsRadioRow } from './settings-controls';
import { createUpdateRows, el, updateButton, updateSummary } from './update-rows';
import '../styles/settings-updates.css';

let cleanup: (() => void) | undefined;

export function disposeAppUpdatesSettings(): void {
  cleanup?.();
  cleanup = undefined;
}

export function renderAppUpdatesSettings(mount: HTMLElement, center: UpdateCenter = updateCenter): void {
  disposeAppUpdatesSettings();
  const section = el('section', 'updates-settings');
  section.id = 'settingsAppUpdates';
  section.dataset.settingsSearchKey = 'general.updates';
  const header = el('header', 'updates-settings__header');
  const heading = el('div');
  const title = el('h2', 'updates-settings__title', 'Software updates');
  const summary = el('p', 'updates-summary');
  summary.setAttribute('role', 'status');
  heading.append(title, summary);
  const check = updateButton('Check for updates', () => { void center.check(); });
  header.append(heading, check);
  const rows = createUpdateRows(center, 'settings');

  const footer = el('div', 'updates-settings__footer');
  const lastChecked = el('p', 'updates-summary');
  const subscriptions = updateButton('Manage CLI subscriptions', () => launchApp('models', { modelsSection: 'clis' }));
  footer.append(lastChecked, subscriptions);

  const preferences = el('section', 'updates-preferences');
  preferences.append(el('h3', 'updates-group__heading', 'Minnow preferences'));
  let changingChannel = false;
  const channel = createSettingsRadioRow('Release channel', {
    name: 'settings-update-channel',
    searchKey: 'general.updates.channel',
    description: 'Minnow downloads updates in the background. Beta includes prerelease builds.',
    options: [{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }],
    value: 'stable',
    onChange: value => {
      const api = getUpdaterApi();
      if (!api || changingChannel || !center.state.app?.supported) return;
      changingChannel = true;
      channelError.textContent = '';
      render();
      void api.setChannel(value === 'beta' ? 'beta' : 'stable').catch(() => {
        channelError.textContent = 'Could not change the release channel. Try again.';
      }).finally(() => {
        changingChannel = false;
        render();
      });
    },
  });
  const channelError = el('p', 'updates-summary');
  channelError.setAttribute('role', 'status');
  preferences.append(channel.row, channelError);
  section.append(header, rows.root, footer, preferences);
  mount.append(section);

  function render() {
    const { app, cli, cliChecking, cliRestricted, appChecking } = center.state;
    const busy = cliChecking || appChecking || app?.state === 'checking';
    summary.textContent = updateSummary(center);
    check.disabled = busy || (cliRestricted && !app?.supported);
    check.textContent = busy ? 'Checking…' : 'Check for updates';
    const latestCheck = Math.max(app?.lastCheckedAt ?? 0, cli?.checkedAt ?? 0);
    lastChecked.textContent = 'Last checked: ' + formatLastChecked(latestCheck || null);
    preferences.hidden = !app?.supported;
    channel.setValue(app?.channel ?? 'stable');
    for (const input of channel.inputs) input.disabled = changingChannel;
    rows.render();
  }
  cleanup = center.subscribe(render);
  void center.checkCli();
}
