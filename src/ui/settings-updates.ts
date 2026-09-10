import {
  describeUpdaterStrip,
  formatLastChecked,
  formatNextCheck,
  getUpdaterApi,
  watchUpdaterStatus,
  type MinnowUpdaterStatus,
} from '../electron/updater-client';
import {
  createSettingsActionsRow,
  createSettingsKvList,
  createSettingsRadioRow,
} from './settings-controls';
import { renderReleaseNotesMarkdown } from './release-notes-markdown';

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

const DEV_HINT = 'Updates apply to the installed Minnow app, not this dev session.';
const MACOS_HINT =
  'macOS auto-update requires code signing. Use manual download until certificates are configured.';
const BETA_HINT = 'Beta builds may be less stable. You can switch back to Stable anytime.';
const RESTART_WARNING = 'Active sessions will close and Minnow will reopen.';

function unsupportedMessage(status: MinnowUpdaterStatus): string {
  return status.unsupportedReason === 'macos-signing' ? MACOS_HINT : DEV_HINT;
}

function renderUnsupportedUpdates(mount: HTMLElement, message: string, stripLabel: string): void {
  const section = el('section', 'settings-updates settings-updates--limited');
  section.dataset.settingsSearchKey = 'general.updates';

  const head = el('div', 'settings-updates__head');
  const strip = el('div', 'settings-updates-strip');
  strip.dataset.tone = 'muted';
  strip.setAttribute('role', 'status');
  strip.append(
    el('span', 'settings-updates-strip__dot'),
    el('span', 'settings-updates-strip__label', stripLabel),
  );
  head.appendChild(strip);
  section.appendChild(head);

  const callout = el('p', 'settings-updates__callout', message);
  callout.setAttribute('role', 'note');
  section.appendChild(callout);

  mount.appendChild(section);
}

/** Render the App updates group body. Reads/updates via window.minnow.updater. */
export function renderAppUpdatesSettings(mount: HTMLElement): void {
  const api = getUpdaterApi();
  if (!api) {
    renderUnsupportedUpdates(mount, DEV_HINT, 'Dev session');
    return;
  }

  const section = el('section', 'settings-updates');
  section.dataset.settingsSearchKey = 'general.updates';

  const head = el('div', 'settings-updates__head');

  const strip = el('div', 'settings-updates-strip');
  strip.setAttribute('role', 'status');
  strip.setAttribute('aria-live', 'polite');
  const dot = el('span', 'settings-updates-strip__dot');
  dot.setAttribute('aria-hidden', 'true');
  const stripLabel = el('span', 'settings-updates-strip__label');
  const progress = el('div', 'settings-updates-progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.hidden = true;
  const progressBar = el('div', 'settings-updates-progress__bar');
  progress.appendChild(progressBar);
  strip.append(dot, stripLabel, progress);
  head.appendChild(strip);

  const versionValue = el('code', 'settings-updates-version');
  const lastCheckedValue = el('span');
  const nextCheckValue = el('span');
  head.appendChild(
    createSettingsKvList(
      [
        { term: 'Installed version', value: versionValue },
        { term: 'Last checked', value: lastCheckedValue },
        { term: 'Next automatic check', value: nextCheckValue },
      ],
      { searchKey: 'general.updates' },
    ),
  );
  section.appendChild(head);

  const callout = el('p', 'settings-updates__callout');
  callout.setAttribute('role', 'note');
  callout.hidden = true;
  section.appendChild(callout);

  const controls = el('div', 'settings-updates__controls');
  const channelBlock = el('div', 'settings-updates__channel');

  let suppressChannelEvents = false;
  const channel = createSettingsRadioRow('Update channel', {
    name: 'settings-update-channel',
    searchKey: 'general.updates.channel',
    description: 'Switching channel takes effect on the next check.',
    options: [
      { value: 'stable', label: 'Stable' },
      { value: 'beta', label: 'Beta' },
    ],
    value: 'stable',
    onChange: (value) => {
      if (suppressChannelEvents) return;
      void api.setChannel(value === 'beta' ? 'beta' : 'stable');
    },
  });
  channelBlock.appendChild(channel.row);

  const betaHint = el('p', 'settings-field-hint settings-updates-beta-hint', BETA_HINT);
  betaHint.hidden = true;
  channelBlock.appendChild(betaHint);
  controls.appendChild(channelBlock);

  const actionsBlock = el('div', 'settings-updates__actions');
  const actions = createSettingsActionsRow(
    [
      {
        label: 'Check for updates',
        id: 'settingsUpdatesCheckBtn',
        onClick: () => {
          void api.checkNow();
        },
      },
      {
        label: 'Restart to update',
        id: 'settingsUpdatesRestartBtn',
        variant: 'primary',
        title: RESTART_WARNING,
        onClick: () => {
          void api.restart();
        },
      },
    ],
    { searchKey: 'general.updates' },
  );
  const checkBtn = actions.querySelector<HTMLButtonElement>('#settingsUpdatesCheckBtn');
  const restartBtn = actions.querySelector<HTMLButtonElement>('#settingsUpdatesRestartBtn');
  if (restartBtn) restartBtn.hidden = true;
  actionsBlock.appendChild(actions);

  const restartWarning = el('p', 'settings-field-hint settings-updates-restart-warning', RESTART_WARNING);
  restartWarning.hidden = true;
  actionsBlock.appendChild(restartWarning);
  controls.appendChild(actionsBlock);
  section.appendChild(controls);

  const notes = el('details', 'settings-updates-notes') as HTMLDetailsElement;
  const notesSummary = el('summary', 'settings-updates-notes__summary');
  const notesBody = el('div', 'settings-updates-notes__body');
  notes.append(notesSummary, notesBody);
  notes.hidden = true;
  section.appendChild(notes);
  let renderedNotes = '';

  mount.appendChild(section);

  function applyStatus(status: MinnowUpdaterStatus): void {
    const strip2 = describeUpdaterStrip(status, navigator.onLine);
    strip.dataset.tone = strip2.tone;
    stripLabel.textContent = strip2.label;

    const downloading = status.state === 'downloading';
    progress.hidden = !downloading;
    if (downloading) {
      const percent = status.progressPercent ?? 0;
      progress.setAttribute('aria-valuenow', String(percent));
      progressBar.style.width = `${percent}%`;
    }

    versionValue.textContent = status.installedVersion;
    lastCheckedValue.textContent = formatLastChecked(status.lastCheckedAt);
    nextCheckValue.textContent = status.supported
      ? formatNextCheck(status.nextCheckAt)
      : '—';

    const limited = !status.supported;
    section.classList.toggle('settings-updates--limited', limited);
    controls.hidden = limited;
    callout.hidden = !limited;
    if (limited) {
      callout.textContent = unsupportedMessage(status);
    }

    suppressChannelEvents = true;
    channel.setValue(status.channel);
    suppressChannelEvents = false;
    for (const input of channel.inputs) {
      input.disabled = limited;
    }
    betaHint.hidden = status.channel !== 'beta';

    if (checkBtn) {
      checkBtn.disabled =
        limited || status.state === 'checking' || status.state === 'downloading';
    }
    const ready = status.state === 'ready';
    if (restartBtn) restartBtn.hidden = !ready;
    restartWarning.hidden = !ready;

    const hasNotes = Boolean(status.pendingVersion && status.releaseNotes);
    notes.hidden = !hasNotes;
    if (hasNotes) {
      notesSummary.textContent = `What's new in ${status.pendingVersion}`;
      const nextNotes = status.releaseNotes ?? '';
      if (nextNotes !== renderedNotes) {
        renderReleaseNotesMarkdown(notesBody, nextNotes);
        renderedNotes = nextNotes;
      }
    }
  }

  const stop = watchUpdaterStatus((status) => {
    if (!section.isConnected) {
      stop();
      return;
    }
    applyStatus(status);
  });
}
