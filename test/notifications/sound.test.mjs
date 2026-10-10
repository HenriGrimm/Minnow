import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('notification sound gating', () => {
  let prefs;
  let sound;
  let sessions;
  let instances;
  let win;
  let doc;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    win = new Window();
    doc = win.document;
    const g = globalThis;
    g.window = win;
    g.document = doc;
    g.localStorage = win.localStorage;
    prefs = await import('../../src/notifications/prefs.ts');
    sound = await import('../../src/notifications/sound.ts');
    sessions = await import('../../src/state/sessions.ts');
    instances = await import('../../src/os/instances.ts');
    prefs.resetNotificationPrefsForTests();
    sound.resetNotificationSoundForTests();
    instances.resetInstancesForTests();
    sessions.setSessionStateForTests({
      version: 5,
      activeId: 'chat-a',
      chats: [{ ...sessions.createEmptyChatObject('model-a'), id: 'chat-a' }],
      groups: [],
    });
    win.localStorage.clear();
    delete win.minnow;
  });

  afterEach(() => {
    prefs.resetNotificationPrefsForTests();
    sound.resetNotificationSoundForTests();
    instances.resetInstancesForTests();
    sessions.setSessionStateForTests(null);
  });

  function setFocusState({ hasFocus, visibilityState }) {
    Object.defineProperty(doc, 'hasFocus', {
      configurable: true,
      value: () => hasFocus,
    });
    Object.defineProperty(doc, 'visibilityState', {
      configurable: true,
      value: visibilityState,
    });
  }

  test('does not play when focused', () => {
    setFocusState({ hasFocus: true, visibilityState: 'visible' });
    assert.equal(sound.shouldPlayNotificationSound(), false);
  });

  test('does not play when sound disabled', () => {
    setFocusState({ hasFocus: false, visibilityState: 'hidden' });
    prefs.saveNotificationPref('soundEnabled', false);
    assert.equal(sound.shouldPlayNotificationSound(), false);
  });

  test('does not play when muted', () => {
    setFocusState({ hasFocus: false, visibilityState: 'hidden' });
    prefs.saveNotificationPref('muted', true);
    assert.equal(sound.shouldPlayNotificationSound(), false);
  });

  test('browser: skips hidden background tabs when unfocused', () => {
    setFocusState({ hasFocus: false, visibilityState: 'hidden' });
    assert.equal(sound.shouldPlayNotificationSound(), false);
  });

  test('browser: plays when visible and unfocused', () => {
    setFocusState({ hasFocus: false, visibilityState: 'visible' });
    assert.equal(sound.shouldPlayNotificationSound(), true);
  });

  test('electron: plays when unfocused even if visibility is hidden', () => {
    win.minnow = { app: { isElectron: true } };
    setFocusState({ hasFocus: false, visibilityState: 'hidden' });
    assert.equal(sound.shouldPlayNotificationSound(), true);
  });

  test('agent waits stay silent in background and active chats', () => {
    win.minnow = { app: { isElectron: true } };
    setFocusState({ hasFocus: false, visibilityState: 'hidden' });
    assert.equal(sound.shouldPlayNotificationSound('agent_wait', 'chat-a'), false);

    instances.launchInstance('code');
    prefs.saveNotificationPref('soundOnActiveChat', true);
    setFocusState({ hasFocus: true, visibilityState: 'visible' });
    assert.equal(sound.shouldPlayNotificationSound('agent_wait', 'chat-a'), false);
    assert.equal(sound.shouldPlayNotificationSound('chat_turn_complete', 'chat-a'), true);
  });

  test('chat_question: plays when window is focused', () => {
    setFocusState({ hasFocus: true, visibilityState: 'visible' });
    assert.equal(sound.shouldPlayNotificationSound(), false);
    assert.equal(sound.shouldPlayNotificationSound('chat_question'), true);
  });

  test('does not play when sound pack is none', () => {
    setFocusState({ hasFocus: false, visibilityState: 'visible' });
    prefs.saveNotificationPref('soundPackId', 'none');
    assert.equal(sound.shouldPlayNotificationSound(), false);
  });

  test('active chat: plays when focused and soundOnActiveChat is enabled', () => {
    instances.launchInstance('code');
    prefs.saveNotificationPref('soundOnActiveChat', true);
    setFocusState({ hasFocus: true, visibilityState: 'visible' });
    assert.equal(
      sound.shouldPlayNotificationSound('chat_turn_complete', 'chat-a'),
      true,
    );
  });

  test('active chat: does not play when focused without soundOnActiveChat', () => {
    instances.launchInstance('code');
    setFocusState({ hasFocus: true, visibilityState: 'visible' });
    assert.equal(
      sound.shouldPlayNotificationSound('chat_turn_complete', 'chat-a'),
      false,
    );
  });
});
