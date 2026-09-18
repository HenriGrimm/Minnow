import {
  loadNotificationPrefs,
  saveNotificationPref,
  saveNotificationPrefs,
} from '../notifications/prefs';
import { NOTIFICATION_SOUND_PACK_OPTIONS } from '../notifications/sound-packs';
import {
  NOTIFICATION_SOUND_CUES,
  previewNotificationSoundCue,
} from '../notifications/sound';
import { appendSettingsGroup } from './settings-layout';
import { createSettingsToggleRow } from './settings-switch';
import { createSettingsActionsRow } from './settings-controls';

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

/** Render notification controls into a settings group mount. */
export function renderNotificationsSettingsSection(mount: HTMLElement): void {
  const prefs = loadNotificationPrefs();

  const alerts = appendSettingsGroup(
    mount,
    'Bell alerts',
    'Show alerts in the menubar bell for background chats, tasks, and jobs.',
    'general.notifications',
    { emphasis: true },
  );

  const { row: enabledRow } = createSettingsToggleRow('Enable notifications', {
    checked: prefs.enabled,
    description: 'Master switch for menubar bell alerts.',
    searchKey: 'general.notifications.enabled',
    onChange: (next) => saveNotificationPref('enabled', next),
  });
  alerts.appendChild(enabledRow);

  const { row: chatRow } = createSettingsToggleRow('Chat notifications', {
    checked: prefs.chatEnabled,
    description:
      'Alert when a background chat finishes, errors, or a tool fails while you are in another app.',
    searchKey: 'general.notifications.chat',
    onChange: (next) => saveNotificationPref('chatEnabled', next),
  });
  alerts.appendChild(chatRow);

  const { row: tasksRow } = createSettingsToggleRow('Task & sub-agent notifications', {
    checked: prefs.tasksEnabled,
    description: 'Orchestrate board updates and sub-agent start, finish, or failure.',
    searchKey: 'general.notifications.tasks',
    onChange: (next) => saveNotificationPref('tasksEnabled', next),
  });
  alerts.appendChild(tasksRow);

  const { row: backgroundRow } = createSettingsToggleRow('Background job notifications', {
    checked: prefs.backgroundEnabled,
    description: 'Scheduler reminders, research completion, and memory or skill proposals.',
    searchKey: 'general.notifications.background',
    onChange: (next) => saveNotificationPref('backgroundEnabled', next),
  });
  alerts.appendChild(backgroundRow);

  const { row: osRow } = createSettingsToggleRow('Desktop notifications', {
    checked: prefs.osEnabled,
    description:
      'Also show a system notification when an agent asks a question or finishes its turn while Minnow is in the background.',
    searchKey: 'general.notifications.os',
    onChange: (next) => saveNotificationPref('osEnabled', next),
  });
  alerts.appendChild(osRow);

  const sound = appendSettingsGroup(
    mount,
    'Notification sounds',
    'Each alert type plays its own cue from the selected sound pack when Minnow is open but unfocused.',
    'general.notifications.sound',
    { emphasis: true },
  );

  const { row: soundRow } = createSettingsToggleRow('Play sounds', {
    checked: prefs.soundEnabled,
    onChange: (next) => saveNotificationPref('soundEnabled', next),
  });
  sound.appendChild(soundRow);

  const { row: activeChatSoundRow } = createSettingsToggleRow('Sounds in active chat', {
    checked: prefs.soundOnActiveChat,
    description:
      'Play turn and tool cues while you watch the chat in Code, without adding bell alerts.',
    searchKey: 'general.notifications.soundOnActiveChat',
    onChange: (next) => saveNotificationPref('soundOnActiveChat', next),
  });
  sound.appendChild(activeChatSoundRow);

  const packRow = el('div', 'settings-inline-row');
  const packLabel = el('label', 'settings-inline-label', 'Sound pack');
  const packSelect = document.createElement('select');
  packSelect.className = 'settings-select';
  for (const packOption of NOTIFICATION_SOUND_PACK_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = packOption.id;
    opt.textContent = packOption.label;
    packSelect.appendChild(opt);
  }
  packSelect.value = prefs.soundPackId;
  packSelect.addEventListener('change', () => {
    saveNotificationPref('soundPackId', packSelect.value);
  });
  packRow.append(packLabel, packSelect);
  sound.appendChild(packRow);

  const previewRow = el('div', 'settings-inline-row settings-inline-row--wrap');
  const previewLabel = el('span', 'settings-inline-label', 'Preview');
  previewRow.appendChild(previewLabel);
  for (const cue of NOTIFICATION_SOUND_CUES) {
    const previewBtn = el('button', 'settings-action-btn', cue.label) as HTMLButtonElement;
    previewBtn.type = 'button';
    previewBtn.addEventListener('click', () => {
      previewNotificationSoundCue(packSelect.value, cue.id);
    });
    previewRow.appendChild(previewBtn);
  }
  sound.appendChild(previewRow);

  const resetActions = createSettingsActionsRow([
    {
      label: 'Reset to defaults',
      onClick: () => {
        saveNotificationPrefs({
          enabled: true,
          muted: false,
          soundEnabled: true,
          soundOnActiveChat: false,
          soundPackId: 'default',
          chatEnabled: true,
          tasksEnabled: true,
          backgroundEnabled: true,
          osEnabled: true,
        });
        mount.replaceChildren();
        renderNotificationsSettingsSection(mount);
      },
    },
  ]);
  mount.appendChild(resetActions);
}
