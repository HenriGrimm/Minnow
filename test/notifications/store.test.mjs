import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('notification store', () => {
  let store;

  beforeEach(async () => {
    store = await import('../../src/notifications/store.ts');
    store.resetNotificationStoreForTests();
  });

  afterEach(() => {
    store.resetNotificationStoreForTests();
  });

  test('push via append increases unread count', () => {
    store.appendNotification({
      id: 'n1',
      kind: 'scheduler',
      title: 'Scheduler',
      preview: 'Job done',
      appId: 'scheduler',
      createdAt: 1000,
      read: false,
    });
    assert.equal(store.getUnreadNotificationCount(), 1);
    assert.equal(store.getNotifications().length, 1);
  });

  test('mark all read clears unread badge count', () => {
    store.appendNotification({
      id: 'n1',
      kind: 'research',
      title: 'Research',
      preview: 'Brief ready',
      appId: 'research',
      createdAt: 1000,
      read: false,
    });
    store.markAllNotificationsRead();
    assert.equal(store.getUnreadNotificationCount(), 0);
  });

  test('mark seen does not resolve failures; explicit resolution retains the record', () => {
    store.appendNotification({ id: 'failure', kind: 'task_failed', title: 'Build', preview: 'Failed', appId: 'code', createdAt: 1, read: false });
    store.markAllNotificationsRead();
    assert.equal(store.getNotifications()[0].resolved, undefined);
    store.resolveActivityNotifications(['failure']);
    assert.equal(store.getNotifications()[0].resolved, true);
    assert.equal(store.getNotifications()[0].read, true);
    assert.equal(store.getNotifications().length, 1);
  });

  test('caps inbox at 100 items', () => {
    for (let i = 0; i < 105; i += 1) {
      store.appendNotification({
        id: `n-${i}`,
        kind: 'scheduler',
        title: 'T',
        preview: 'p',
        appId: 'scheduler',
        createdAt: i,
        read: false,
      });
    }
    assert.equal(store.getNotifications().length, 100);
    assert.equal(store.getNotifications()[0]?.id, 'n-104');
  });

  test('history churn retains live jobs and their completion replaces the running record', () => {
    const base = { kind: 'scheduler', title: 'Job', preview: 'Working', appId: 'scheduler', read: true };
    store.appendNotification({ ...base, id: 'running', activityId: 'scheduler:r1', activityStatus: 'running', createdAt: 0 });
    for (let i = 1; i <= 105; i++) store.appendNotification({ ...base, id: String(i), createdAt: i });
    assert.ok(store.getNotifications().some((row) => row.id === 'running'));
    store.appendNotification({ ...base, id: 'completed', activityId: 'scheduler:r1', activityStatus: 'completed', createdAt: 106 });
    assert.equal(store.getNotifications().some((row) => row.id === 'running'), false);
    assert.equal(store.getNotifications().length, 100);
  });

  test('subscribe receives updates', () => {
    let count = 0;
    const unsub = store.subscribeNotifications(() => {
      count += 1;
    });
    store.appendNotification({
      id: 'n1',
      kind: 'scheduler',
      title: 'Scheduler',
      preview: 'x',
      appId: 'scheduler',
      createdAt: 1,
      read: false,
    });
    unsub();
    assert.equal(count, 1);
  });

  test('dedupe keys are session-scoped', () => {
    assert.equal(store.hasDedupeKey('a'), false);
    store.rememberDedupeKey('a');
    assert.equal(store.hasDedupeKey('a'), true);
  });

  test('markNotificationsReadForChat clears only matching unread rows', () => {
    store.appendNotification({
      id: 'n1',
      kind: 'chat_turn_complete',
      title: 'Alpha',
      preview: 'Hello',
      chatId: 'chat-a',
      appId: 'code',
      createdAt: 1,
      read: false,
    });
    store.appendNotification({
      id: 'n2',
      kind: 'chat_turn_complete',
      title: 'Beta',
      preview: 'Hi',
      chatId: 'chat-b',
      appId: 'code',
      createdAt: 2,
      read: false,
    });
    store.appendNotification({
      id: 'n3',
      kind: 'scheduler',
      title: 'Scheduler',
      preview: 'Job done',
      appId: 'scheduler',
      createdAt: 3,
      read: false,
    });

    store.markNotificationsReadForChat('chat-a');

    assert.equal(store.getUnreadNotificationCount(), 2);
    assert.equal(store.getNotifications().find((n) => n.id === 'n1')?.read, true);
    assert.equal(store.getNotifications().find((n) => n.id === 'n2')?.read, false);
    assert.equal(store.getNotifications().find((n) => n.id === 'n3')?.read, false);
  });
});
