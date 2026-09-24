import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('notification prefs', () => {
  let prefs;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const g = globalThis;
    g.window = win;
    g.localStorage = win.localStorage;
    prefs = await import('../../src/notifications/prefs.ts');
    prefs.resetNotificationPrefsForTests();
    win.localStorage.clear();
  });

  afterEach(() => {
    prefs.resetNotificationPrefsForTests();
  });

  test('loads defaults when storage empty', () => {
    const loaded = prefs.loadNotificationPrefs();
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.muted, false);
    assert.equal(loaded.soundPackId, 'default');
    assert.equal(loaded.soundOnActiveChat, false);
    assert.equal(loaded.chatEnabled, true);
  });

  test('persists and reloads toggles', () => {
    prefs.saveNotificationPref('enabled', false);
    prefs.saveNotificationPref('muted', true);
    prefs.saveNotificationPref('soundPackId', 'none');
    const loaded = prefs.loadNotificationPrefs();
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.muted, true);
    assert.equal(loaded.soundPackId, 'none');
  });

  test('migrates legacy soundId none to soundPackId none and disables playback', () => {
    localStorage.setItem('minnow.notifications.soundId', 'none');
    prefs.resetNotificationPrefsForTests();
    const loaded = prefs.loadNotificationPrefs();
    assert.equal(loaded.soundPackId, 'none');
    assert.equal(loaded.soundEnabled, false);
  });

  test('migrates legacy soundId chime to default pack', () => {
    localStorage.setItem('minnow.notifications.soundId', 'chime');
    prefs.resetNotificationPrefsForTests();
    const loaded = prefs.loadNotificationPrefs();
    assert.equal(loaded.soundPackId, 'default');
  });

  test('kind group gating respects master enable', () => {
    prefs.saveNotificationPrefs({
      enabled: false,
      muted: false,
      soundEnabled: true,
      soundOnActiveChat: false,
      soundPackId: 'default',
      chatEnabled: true,
      tasksEnabled: true,
      backgroundEnabled: true,
    });
    assert.equal(prefs.isNotificationKindEnabled('chat_turn_complete'), false);
  });

  test('agent_wait is a chat-group kind', () => {
    assert.equal(prefs.isNotificationKindEnabled('agent_wait'), true);
    prefs.saveNotificationPref('chatEnabled', false);
    assert.equal(prefs.isNotificationKindEnabled('agent_wait'), false);
    prefs.saveNotificationPref('chatEnabled', true);
    assert.equal(prefs.isNotificationKindEnabled('agent_wait'), true);
  });

  test('kind group gating respects muted state', () => {
    prefs.saveNotificationPrefs({
      enabled: true,
      muted: true,
      soundEnabled: true,
      soundOnActiveChat: false,
      soundPackId: 'default',
      chatEnabled: true,
      tasksEnabled: true,
      backgroundEnabled: true,
    });
    assert.equal(prefs.isNotificationKindEnabled('chat_turn_complete'), false);
    assert.equal(prefs.isNotificationKindEnabled('scheduler'), false);
  });
});
