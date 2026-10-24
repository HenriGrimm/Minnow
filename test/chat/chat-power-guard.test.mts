import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { setStreaming } from '../../src/app-state.ts';
import { disposeChatRunActivity, setChatRunActivity } from '../../src/state/chat-run-activity.ts';

afterEach(() => {
  setStreaming(false);
  disposeChatRunActivity();
  delete window.minnow;
});
after(() => window.close());

function powerUpdates(): boolean[] {
  const updates: boolean[] = [];
  window.minnow = {
    power: {
      setChatActive: (active: boolean) => { updates.push(active); },
      onScreenUnlocked: () => () => {},
    },
  } as typeof window.minnow;
  return updates;
}

test('keeps sleep protection until all concurrent chats settle', () => {
  const updates = powerUpdates();
  setStreaming(true, 'chat-a');
  setStreaming(true, 'chat-b');
  setStreaming(false, 'chat-a');
  assert.deepEqual(updates, [true, true, true]);
  setStreaming(false, 'chat-b');
  assert.deepEqual(updates, [true, true, true, false]);
});

test('failure, interruption and stop-all release sleep protection', () => {
  const updates = powerUpdates();
  for (const status of ['failed', 'stopped', 'interrupted'] as const) {
    setStreaming(true, 'chat-a');
    setChatRunActivity('chat-a', status);
    setStreaming(false, 'chat-a');
    assert.deepEqual(updates.slice(-2), [true, false]);
  }
  setStreaming(true, 'chat-a');
  setStreaming(true, 'chat-b');
  setStreaming(false);
  assert.equal(updates.at(-1), false);
});

test('browser-only chats run without the desktop power bridge', () => {
  delete window.minnow;
  assert.doesNotThrow(() => {
    setStreaming(true, 'browser-chat');
    setStreaming(false, 'browser-chat');
  });
});

test('an older preload does not interrupt a chat during a development reload', () => {
  window.minnow = { power: {} } as typeof window.minnow;
  assert.doesNotThrow(() => {
    setStreaming(true, 'older-shell-chat');
    setStreaming(false, 'older-shell-chat');
  });
});
