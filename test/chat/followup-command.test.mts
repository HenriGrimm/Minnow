/**
 * MIN-206 — /followup command guards and arming.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  addActiveLoop,
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  getFollowupChain,
  hasFollowupChain,
  setActiveGoal,
  setFollowupChain,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { handleFollowupCommand } from '../../src/chat/followup/command.ts';
import { stopFollowupRunner } from '../../src/chat/followup/runner.ts';
import type { Chat } from '../../src/types.ts';

let activeWindow: Window | undefined;

function setup(options: { history?: boolean } = {}): {
  chat: Chat;
  reports: Array<{ level: string; message: string }>;
  report: (level: 'ok' | 'err', message: string) => void;
} {
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);

  const chat = createEmptyChatObject('m1', 'C:/ws/min-206');
  chat.id = 'root';
  chat.modeId = 'build';
  chat.history = options.history === false ? [] : [{ role: 'user', content: 'fix the build' }];
  chat.historyLoaded = true;

  setSessionStateForTests({
    ...defaultSessionState(),
    activeId: chat.id,
    chats: [chat],
  });

  const reports: Array<{ level: string; message: string }> = [];
  return {
    chat,
    reports,
    report: (level, message) => reports.push({ level, message }),
  };
}

afterEach(() => {
  stopFollowupRunner();
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
  activeWindow?.close();
  activeWindow = undefined;
});

describe('handleFollowupCommand', () => {
  test('ignores unrelated text', () => {
    const { chat, report } = setup();
    assert.equal(handleFollowupCommand(chat, 'hello there', report), null);
    assert.equal(hasFollowupChain(chat), false);
  });

  test('arms a chain with the count and prompt', () => {
    const { chat, report, reports } = setup();

    const dispatch = handleFollowupCommand(chat, '/followup 3 review the build', report);

    assert.equal(dispatch, 'armed');
    const chain = getFollowupChain(chat);
    assert.equal(chain?.total, 3);
    assert.equal(chain?.index, 0);
    assert.equal(chain?.remaining, 3);
    assert.equal(chain?.promptText, 'review the build');
    assert.equal(chain?.modeId, 'build');
    assert.equal(chain?.rootChatId, chat.id);
    assert.equal(chain?.parentChatId, chat.id);
    assert.ok(chain?.chainId);
    assert.ok(chain?.createdAt);
    assert.equal(reports.at(-1)?.level, 'ok');
    assert.match(reports.at(-1)?.message ?? '', /3 task\(s\)/);
  });

  test('bare /followup arms one agent-chosen task', () => {
    const { chat, report } = setup();
    assert.equal(handleFollowupCommand(chat, '/followup', report), 'armed');
    const chain = getFollowupChain(chat);
    assert.equal(chain?.total, 1);
    assert.equal(chain?.promptText, '');
  });

  test('clears an armed chain', () => {
    const { chat, report, reports } = setup();
    handleFollowupCommand(chat, '/followup 2 x', report);
    assert.equal(hasFollowupChain(chat), true);

    assert.equal(handleFollowupCommand(chat, '/followup stop', report), 'handled');
    assert.equal(hasFollowupChain(chat), false);
    assert.match(reports.at(-1)?.message ?? '', /cleared/i);
  });

  test('rejects a second chain on the same chat', () => {
    const { chat, report, reports } = setup();
    handleFollowupCommand(chat, '/followup 2 x', report);

    assert.equal(handleFollowupCommand(chat, '/followup 2 y', report), 'handled');
    assert.equal(reports.at(-1)?.level, 'err');
    assert.match(reports.at(-1)?.message ?? '', /already armed/i);
    assert.equal(getFollowupChain(chat)?.promptText, 'x');
  });

  test('rejects an out-of-range count', () => {
    const { chat, report, reports } = setup();
    assert.equal(handleFollowupCommand(chat, '/followup 11 x', report), 'handled');
    assert.equal(hasFollowupChain(chat), false);
    assert.equal(reports.at(-1)?.level, 'err');
  });

  test('refuses while a loop is armed', () => {
    const { chat, report, reports } = setup();
    addActiveLoop(chat, {
      promptText: 'check the deploy',
      kind: 'interval',
      intervalMs: 300_000,
      dueAt: Date.now(),
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });

    assert.equal(handleFollowupCommand(chat, '/followup 2 x', report), 'handled');
    assert.equal(hasFollowupChain(chat), false);
    assert.match(reports.at(-1)?.message ?? '', /goal or loop/i);
  });

  test('refuses while a goal is active', () => {
    const { chat, report, reports } = setup();
    setActiveGoal(chat, 'all tests pass');

    assert.equal(handleFollowupCommand(chat, '/followup 2 x', report), 'handled');
    assert.equal(hasFollowupChain(chat), false);
    assert.match(reports.at(-1)?.message ?? '', /goal or loop/i);
  });

  test('refuses on an empty chat', () => {
    const { chat, report, reports } = setup({ history: false });
    assert.equal(handleFollowupCommand(chat, '/followup', report), 'handled');
    assert.equal(hasFollowupChain(chat), false);
    assert.match(reports.at(-1)?.message ?? '', /nothing to follow up/i);
  });

  test('refuses a nested /followup task', () => {
    const { chat, report, reports } = setup();
    assert.equal(handleFollowupCommand(chat, '/followup /followup 2 x', report), 'handled');
    assert.equal(hasFollowupChain(chat), false);
    assert.match(reports.at(-1)?.message ?? '', /cannot start another/i);
  });

  test('arming alone does not spawn before the runner is started', async () => {
    const { chat, report } = setup();
    handleFollowupCommand(chat, '/followup 2 review the build', report);
    // The deferred sweep is gated on the boot-started runner (same rule as /loop).
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hasFollowupChain(chat), true);
  });
});
