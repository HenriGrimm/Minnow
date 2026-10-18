import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createActivityDropdown, type ActivityDropdownActions } from '../../src/ui/activity-dropdown.ts';
import { buildActivityFeed } from '../../src/state/activity-feed.ts';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/prefs.ts';
import type { NotificationRecord } from '../../src/notifications/types.ts';

let panel: HTMLElement;
let actions: ActivityDropdownActions;
const notice = (patch: Partial<NotificationRecord> = {}): NotificationRecord => ({ id: 'failure', activityId: 'scheduler:r1', jobId: 'job1', activityStatus: 'failed', kind: 'scheduler', title: '<unsafe title>', preview: 'Provider unavailable', createdAt: Date.now(), read: false, appId: 'scheduler', workspacePath: '/work', ...patch });
const feed = (records: NotificationRecord[]) => buildActivityFeed({ chats: [], live: [], notifications: records, pendingChatIds: new Set(), workspacePath: '/work' });

beforeEach(() => {
  const win = new Window();
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  panel = document.createElement('section');
  document.body.append(panel);
  actions = { open() {}, seen() {}, dismiss() {}, stop() {}, mute() {}, settings() {}, async retry() {} };
});

test('renders the priority stack with safe titles and actionable failure details', () => {
  const view = createActivityDropdown(panel, actions);
  view.render(feed([notice()]), DEFAULT_NOTIFICATION_PREFS, 'Minnow', false);
  assert.equal(panel.querySelector('unsafe'), null);
  assert.match(panel.querySelector('.activity-row__title')!.textContent!, /<unsafe title>/);
  assert.match(panel.textContent!, /Needs you · 1/);
  assert.ok(panel.querySelector('[data-action="retry"]'));
  assert.ok(panel.querySelector('[data-action="dismiss"]'));
  view.destroy();
});

test('mark seen keeps failures, and dismissal invokes the explicit resolution action', () => {
  let dismissed = '';
  actions.dismiss = (item) => { dismissed = item.id; };
  const view = createActivityDropdown(panel, actions);
  view.render(feed([notice({ read: true })]), DEFAULT_NOTIFICATION_PREFS, 'Minnow', false);
  panel.querySelector<HTMLButtonElement>('[data-action="dismiss"]')!.click();
  assert.equal(dismissed, 'scheduler:r1');
  assert.match(panel.textContent!, /Needs you/);
});

test('history expands locally, and mark seen includes outcomes beyond the visible three', () => {
  let seen = 0;
  actions.seen = (items) => { seen = items.length; };
  const records = Array.from({ length: 5 }, (_, i) => notice({ id: String(i), activityId: String(i), activityStatus: 'completed', createdAt: i, read: i > 1 }));
  const view = createActivityDropdown(panel, actions);
  view.render(feed(records), DEFAULT_NOTIFICATION_PREFS, 'Minnow', false);
  assert.equal(panel.querySelectorAll('.activity-row').length, 3);
  panel.querySelector<HTMLButtonElement>('[data-action="seen"]')!.click();
  assert.equal(seen, 5);
  panel.querySelector<HTMLButtonElement>('[data-action="history"]')!.click();
  assert.equal(panel.querySelectorAll('.activity-row').length, 5);
});

test('expanded details and keyboard focus survive source updates', () => {
  const view = createActivityDropdown(panel, actions);
  view.render(feed([notice()]), DEFAULT_NOTIFICATION_PREFS, 'Minnow', false);
  panel.querySelector<HTMLDetailsElement>('details')!.open = true;
  panel.querySelector<HTMLButtonElement>('[data-action="retry"]')!.focus();
  view.render(feed([notice({ preview: 'Updated failure detail' })]), DEFAULT_NOTIFICATION_PREFS, 'Minnow', false);
  assert.equal(panel.querySelector<HTMLDetailsElement>('details')!.open, true);
  assert.equal((document.activeElement as HTMLElement).dataset.action, 'retry');
});

test('retry is single-flight and a rejected retry stays visible with its error', async () => {
  let calls = 0;
  let reject!: (error: Error) => void;
  actions.retry = () => { calls++; return new Promise((_, fail) => { reject = fail; }); };
  const view = createActivityDropdown(panel, actions);
  view.render(feed([notice()]), DEFAULT_NOTIFICATION_PREFS, 'Minnow', false);
  const button = panel.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
  button.click(); button.click();
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  reject(new Error('Scheduler offline'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.disabled, false);
  assert.equal(panel.querySelector<HTMLElement>('[role="alert"]')!.hidden, false);
  assert.match(panel.textContent!, /Scheduler offline/);
  assert.match(panel.textContent!, /Needs you/);
});

test('muted state leaves captured outcomes visible and shows a pressed mute button', () => {
  const view = createActivityDropdown(panel, actions);
  view.render(feed([notice({ activityStatus: 'completed' })]), { ...DEFAULT_NOTIFICATION_PREFS, muted: true }, 'Minnow', false);
  assert.equal(panel.querySelector('[data-action="mute"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(panel.querySelectorAll('.activity-row').length, 1);
});
