/**
 * Open a notification target: foreground app + optional chat deep-link.
 */

import { getAppById } from '../os/app-registry';
import { getAppUnavailableReason, isAppAvailable } from '../os/app-preferences';
import { launchApp } from '../os/router';
import type { AppId } from '../os/types';
import { acknowledgeChatViewed } from './acknowledge';
import { markNotificationRead } from './store';
import type { NotificationRecord } from './types';

async function toastUnavailableApp(appId: AppId): Promise<void> {
  const reason = getAppUnavailableReason(appId);
  if (!reason) return;
  const name = getAppById(appId)?.name ?? 'That app';
  const message =
    reason === 'user-disabled'
      ? `${name} is turned off. Restore it in Settings → Apps.`
      : `${name} is not available in this build.`;
  const { showToast } = await import('../ui/toast');
  showToast(message, 'error');
}

/** Launch the owning app and switch to the linked chat when present. */
export async function openNotificationTarget(record: NotificationRecord): Promise<void> {
  const { isMobileShell } = await import('../mobile/mode');
  if (isMobileShell()) {
    const { openMobileNotificationTarget } = await import('../mobile/shell');
    if (await openMobileNotificationTarget(record)) return;
  }
  if (record.chatId?.trim()) {
    acknowledgeChatViewed(record.chatId);
  } else {
    markNotificationRead(record.id);
  }

  if (record.chatId) {
    const { launchCodeWithChat } = await import('../os/chat-launch');
    await launchCodeWithChat(record.chatId);
    return;
  }

  if (record.kind === 'device_request') {
    const { openSettings } = await import('../ui/settings-page');
    openSettings('devices');
    return;
  }

  if (record.kind === 'synthesis') {
    launchApp('brain', { brainSection: 'proposals' });
    return;
  }

  if (!isAppAvailable(record.appId)) {
    await toastUnavailableApp(record.appId);
    return;
  }

  launchApp(record.appId);
}
