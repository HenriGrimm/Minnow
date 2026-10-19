import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('pushNotification mute gate', () => {
  let prefs;
  let push;
  let store;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const g = globalThis;
    g.window = win;
    g.document = win.document;
    g.localStorage = win.localStorage;
    prefs = await import('../../src/notifications/prefs.ts');
    store = await import('../../src/notifications/store.ts');
    push = await import('../../src/notifications/push.ts');
    prefs.resetNotificationPrefsForTests();
    store.resetNotificationStoreForTests();
    win.localStorage.clear();
  });

  afterEach(() => {
    prefs.resetNotificationPrefsForTests();
    store.resetNotificationStoreForTests();
  });

  test('captures activity while muted without delivering an alert', () => {
    prefs.saveNotificationPref('muted', true);
    let alerts = 0;
    const unsubscribe = push.onNewNotification(() => { alerts++; });
    const record = push.pushNotification({
      kind: 'chat_turn_complete',
      title: 'Chat',
      preview: 'Done',
      appId: 'code',
    });
    unsubscribe();
    assert.notEqual(record, null);
    assert.equal(store.getUnreadNotificationCount(), 1);
    assert.equal(alerts, 0);
    assert.equal(push.isPushEnabled(), false);
  });

  test('disabled categories retain outcomes without sound or OS delivery', () => {
    prefs.saveNotificationPref('chatEnabled', false);
    let delivered = 0;
    window.minnow = { shell: { showNotification: async () => { delivered++; return { ok: true }; } } };
    const record = push.pushNotification({ kind: 'chat_turn_error', title: 'Chat', preview: 'Failed', appId: 'code', os: true });
    assert.equal(record.activityStatus, undefined);
    assert.equal(store.getNotifications().length, 1);
    assert.equal(delivered, 0);
  });

  test('pushes when notifications are not muted', () => {
    const record = push.pushNotification({
      kind: 'chat_turn_complete',
      title: 'Chat',
      preview: 'Done',
      appId: 'code',
    });
    assert.notEqual(record, null);
    assert.equal(store.getUnreadNotificationCount(), 1);
    assert.equal(push.isPushEnabled(), true);
  });
});
