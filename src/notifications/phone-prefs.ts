import { isPairedDevice } from '../api/session-token';
import type { NotificationRecord } from './types';

export const PHONE_ALERTS = [
  { id: 'approvals', label: 'Approvals', description: 'An agent is waiting on you', defaultEnabled: true },
  { id: 'finished', label: 'Finished runs', description: 'A thread reported back', defaultEnabled: true },
  { id: 'boards', label: 'Board gates', description: 'A wave passed or failed', defaultEnabled: true },
  { id: 'scheduler', label: 'Scheduler failures', description: 'A job failed or timed out', defaultEnabled: false },
] as const;

export type PhoneAlertId = typeof PHONE_ALERTS[number]['id'];

function key(id: PhoneAlertId): string {
  return `minnow.notifications.phone.${id}`;
}

export function phoneAlertEnabled(id: PhoneAlertId): boolean {
  try {
    const saved = localStorage.getItem(key(id));
    if (saved === '1' || saved === '0') return saved === '1';
  } catch {}
  return PHONE_ALERTS.find(alert => alert.id === id)!.defaultEnabled;
}

export function setPhoneAlertEnabled(id: PhoneAlertId, enabled: boolean): void {
  try { localStorage.setItem(key(id), enabled ? '1' : '0'); } catch {}
}

/** Device-local delivery rules. The shared Activity record is always retained. */
export function allowsPhoneAlert(record: Pick<NotificationRecord, 'kind' | 'activityStatus' | 'appId'>): boolean {
  if (!isPairedDevice()) return true;
  if (record.kind === 'chat_question' || record.kind === 'agent_wait' || record.kind === 'issue_agent_question') return phoneAlertEnabled('approvals');
  if (record.kind === 'chat_turn_complete') return phoneAlertEnabled('finished');
  if (record.kind === 'board_complete' || record.kind === 'board_blocked') return phoneAlertEnabled('boards');
  if (record.kind === 'scheduler' && record.appId === 'scheduler' && record.activityStatus === 'failed') return phoneAlertEnabled('scheduler');
  return true;
}
