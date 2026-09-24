/**
 * MIN-206 — spawning the next /followup chat.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  createEmptyChatObject,
  clearFollowupChain,
  flushScheduledSessionSaveForTests,
  getFollowupChain,
  hasFollowupChain,
  setFollowupChain,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { isFollowupSendPending, spawnFollowupChat } from '../../src/chat/followup/spawn.ts';
import { isChatIdleForFollowup } from '../../src/chat/followup/runner.ts';
import type { Chat, FollowupChainState } from '../../src/types.ts';

let activeWindow: Window | undefined;

function setup(): void {
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);
}

afterEach(() => {
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
  activeWindow?.close();
  activeWindow = undefined;
});

function chain(overrides: Partial<FollowupChainState> = {}): FollowupChainState {
  return {
    chainId: 'chain-1',
    total: 3,
    index: 0,
    remaining: 3,
    promptText: 'review the build',
    modeId: 'build',
    rootChatId: 'root',
    parentChatId: 'root',
    createdAt: 1,
    ...overrides,
  };
}

interface Harness {
  sourceChat: Chat;
  chats: Chat[];
  foreground: Array<Record<string, unknown>>;
  background: Array<Record<string, unknown>>;
  sent: Array<{ chatId: string; text: string; options: Record<string, unknown> }>;
}

function harness(): Harness {
  setup();
  const sourceChat = createEmptyChatObject('m1', 'C:/ws/min-206');
  sourceChat.id = 'root';
  sourceChat.name = 'Build work';
  sourceChat.history = [{ role: 'user', content: 'ship it' }];
  sourceChat.historyLoaded = true;

  const state = {
    chats: [sourceChat],
    foreground: [] as Array<Record<string, unknown>>,
    background: [] as Array<Record<string, unknown>>,
    sent: [] as Array<{ chatId: string; text: string; options: Record<string, unknown> }>,
    sourceChat,
  };

  setSessionStateForTests({
    ...defaultSessionState(),
    activeId: sourceChat.id,
    chats: state.chats,
  });

  return state;
}

function makeSpawnDeps(state: Harness) {
  let nextId = 0;
  return {
    createForegroundChat: (options: Record<string, unknown>) => {
      state.foreground.push(options);
      nextId += 1;
      const chat = createEmptyChatObject('m1', 'C:/ws/min-206');
      chat.id = `fg-${nextId}`;
      chat.historyLoaded = true;
      state.chats.push(chat);
      return { ok: true, chatId: chat.id, modeId: 'build' };
    },
    ensureBackgroundChat: (options: Record<string, unknown>) => {
      state.background.push(options);
      nextId += 1;
      const chat = createEmptyChatObject('m1', 'C:/ws/min-206');
      chat.id = `bg-${nextId}`;
      chat.background = true;
      chat.historyLoaded = true;
      state.chats.push(chat);
      return chat;
    },
    send: async (chat: Chat, text: string, options: Record<string, unknown>) => {
      state.sent.push({ chatId: chat.id, text, options });
    },
  };
}

describe('spawnFollowupChat', () => {
  test('link 1 opens a foreground chat and stamps the next link', async () => {
    const state = harness();
    setFollowupChain(state.sourceChat, chain());

    const result = await spawnFollowupChat(
      { sourceChat: state.sourceChat, chain: chain(), taskText: 'review the build', summary: 'SUMMARY' },
      makeSpawnDeps(state) as never,
    );

    assert.equal(result.ok, true);
    assert.equal(state.foreground.length, 1);
    assert.equal(state.background.length, 0);
    assert.deepEqual(state.foreground[0], {
      modeId: 'build',
      workspacePath: 'C:/ws/min-206',
      modelId: 'm1',
      providerId: undefined,
      forceNewChat: true,
    });
    if (!result.ok) return;

    const created = state.chats.find((chat) => chat.id === result.chatId);
    assert.ok(created);
    assert.equal(getFollowupChain(created!)?.index, 1);
    assert.equal(getFollowupChain(created!)?.remaining, 2);
    assert.equal(getFollowupChain(created!)?.promptText, '');
    assert.equal(getFollowupChain(created!)?.parentChatId, 'root');
    assert.equal(created!.backgroundKey, 'followup:chain-1:1');
    assert.equal(created!.background, undefined);
  });

  test('seeds the chat with the summary and the task, slash parsing off', async () => {
    const state = harness();
    await spawnFollowupChat(
      { sourceChat: state.sourceChat, chain: chain(), taskText: 'review the build', summary: 'THE SUMMARY' },
      makeSpawnDeps(state) as never,
    );

    assert.equal(state.sent.length, 1);
    const sent = state.sent[0]!;
    assert.match(sent.text, /^Follow-up 1\/3 · continuing from "Build work"/);
    assert.match(sent.text, /THE SUMMARY/);
    assert.match(sent.text, /review the build/);
    assert.equal(sent.options.parseSlash, false);
    assert.equal(sent.options.titleSeed, 'review the build');
    assert.equal(sent.options.requireCompletedTurn, true);
  });

  test('later links arrive as background chats keyed by chain and link', async () => {
    const state = harness();
    const link2 = chain({ index: 1, remaining: 2, promptText: '' });

    const result = await spawnFollowupChat(
      { sourceChat: state.sourceChat, chain: link2, taskText: 'fix the tests', summary: 'S' },
      makeSpawnDeps(state) as never,
    );

    assert.equal(result.ok, true);
    assert.equal(state.background.length, 1);
    assert.equal(state.background[0]?.key, 'followup:chain-1:2');
    assert.match(String(state.background[0]?.name), /^Follow-up 2\/3: fix the tests/);
    assert.equal(state.background[0]?.modelId, 'm1');
  });

  test('the last link carries no chain', async () => {
    const state = harness();
    const last = chain({ index: 2, remaining: 1, promptText: '' });

    const result = await spawnFollowupChat(
      { sourceChat: state.sourceChat, chain: last, taskText: 'wrap up', summary: 'S' },
      makeSpawnDeps(state) as never,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const created = state.chats.find((chat) => chat.id === result.chatId);
    assert.ok(created);
    assert.equal(created!.followupChain, undefined);
  });

  test('a failing chat factory reports an error instead of throwing', async () => {
    const state = harness();
    const deps = makeSpawnDeps(state);
    const result = await spawnFollowupChat(
      { sourceChat: state.sourceChat, chain: chain(), taskText: 'x', summary: 'S' },
      {
        ...deps,
        createForegroundChat: () => ({ ok: false, error: 'no room' }),
      } as never,
    );

    assert.deepEqual(result, { ok: false, error: 'no room' });
    assert.equal(state.sent.length, 0);
  });

  test('a throwing send reports an error instead of throwing', async () => {
    const state = harness();
    const deps = makeSpawnDeps(state);
    const result = await spawnFollowupChat(
      { sourceChat: state.sourceChat, chain: chain(), taskText: 'x', summary: 'S' },
      {
        ...deps,
        send: async () => {
          throw new Error('stream down');
        },
      } as never,
    );

    assert.deepEqual(result, { ok: false, error: 'stream down' });
    assert.equal(state.chats[1]?.followupChain, undefined);
  });

  test('stopping during the send prevents the next link from arming', async () => {
    const state = harness();
    let current = true;
    const result = await spawnFollowupChat(
      {
        sourceChat: state.sourceChat,
        chain: chain(),
        taskText: 'review the build',
        summary: 'S',
        isCurrent: () => current,
      },
      {
        ...makeSpawnDeps(state),
        send: async () => { current = false; },
      } as never,
    );

    assert.equal(result.ok, false);
    assert.equal(state.chats[1]?.followupChain, undefined);
  });

  test('stopping from the child panel cancels its source chain', async () => {
    const state = harness();
    const activeChain = chain();
    setFollowupChain(state.sourceChat, activeChain);
    const result = await spawnFollowupChat(
      {
        sourceChat: state.sourceChat,
        chain: activeChain,
        taskText: 'review the build',
        summary: 'S',
        isCurrent: () => getFollowupChain(state.sourceChat) === activeChain,
      },
      {
        ...makeSpawnDeps(state),
        send: async (chat: Chat) => {
          assert.equal(hasFollowupChain(chat), true);
          assert.equal(isFollowupSendPending(chat.id), true);
          assert.equal(isChatIdleForFollowup(chat), false);
          clearFollowupChain(chat);
        },
      } as never,
    );

    assert.equal(result.ok, false);
    assert.equal(hasFollowupChain(state.sourceChat), false);
    assert.equal(state.chats[1]?.followupChain, undefined);
  });

  test('a failed first send retries in the same chat', async () => {
    const state = harness();
    const deps = makeSpawnDeps(state);
    const input = {
      sourceChat: state.sourceChat,
      chain: chain(),
      taskText: 'review the build',
      summary: 'S',
    };
    const failed = await spawnFollowupChat(input, {
      ...deps,
      send: async () => { throw new Error('stream down'); },
    } as never);
    assert.equal(failed.ok, false);

    const retried = await spawnFollowupChat(input, deps as never);
    assert.equal(retried.ok, true);
    assert.equal(state.foreground.length, 1);
    assert.equal(state.chats.length, 2);
    assert.equal(getFollowupChain(state.chats[1]!)?.remaining, 2);
  });
});
