/**
 * MIN-206 — end-to-end /followup chain: command → runner → spawn → seeded chat.
 *
 * Drives the real command, runner and spawner. Only the chat factory, the send
 * function, and the utility completion are faked (no DOM, no network, no model).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  getFollowupChain,
  hasFollowupChain,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { handleFollowupCommand } from '../../src/chat/followup/command.ts';
import { runFollowupSweep, stopFollowupRunner } from '../../src/chat/followup/runner.ts';
import { spawnFollowupChat } from '../../src/chat/followup/spawn.ts';
import type { Chat } from '../../src/types.ts';

const WS = 'C:/ws/min-206';

interface Harness {
  chats: Chat[];
  sends: Array<{ chatId: string; text: string; parseSlash: boolean }>;
  generated: string[];
  reports: Array<{ level: string; message: string }>;
  /** Monotonic across sweeps so faked chat ids never collide. */
  nextChatNumber: number;
}

function harness(): Harness {
  const root = createEmptyChatObject('m1', WS);
  root.id = 'chat-a';
  root.name = 'Build the widget';
  root.modeId = 'build';
  root.history = [
    { role: 'user', content: 'fix the build' },
    { role: 'assistant', content: 'build fixed, tests still red' },
  ];
  root.historyLoaded = true;

  const state: Harness = {
    chats: [root],
    sends: [],
    generated: [],
    reports: [],
    nextChatNumber: 0,
  };

  setSessionStateForTests({
    ...defaultSessionState(),
    activeId: root.id,
    chats: state.chats,
  });

  return state;
}

/** Chat factory + send fakes; the spawner and chain stamping stay real. */
function spawnDeps(state: Harness) {
  const makeChat = (options: { background?: boolean; key?: string }): Chat => {
    state.nextChatNumber += 1;
    const chat = createEmptyChatObject('m1', WS);
    chat.id = `chat-${state.nextChatNumber}`;
    chat.name = `Follow-up ${state.nextChatNumber}`;
    chat.historyLoaded = true;
    if (options.background) {
      chat.background = true;
      chat.backgroundKey = options.key;
    }
    state.chats.push(chat);
    return chat;
  };

  return {
    createForegroundChat: (options: { modeId: string }) => {
      const chat = makeChat({});
      chat.modeId = options.modeId as Chat['modeId'];
      return { ok: true, chatId: chat.id, modeId: chat.modeId };
    },
    ensureBackgroundChat: (options: { key: string }) => makeChat({ background: true, key: options.key }),
    send: async (chat: Chat, text: string, options: { parseSlash: boolean }) => {
      state.sends.push({ chatId: chat.id, text, parseSlash: options.parseSlash });
      // Stand in for a completed turn so the next link has something to summarize.
      chat.history.push({ role: 'user', content: text });
      chat.history.push({ role: 'assistant', content: 'follow-up work done' });
    },
  };
}

function sweepOptions(state: Harness, tasks: string[]) {
  const deps = spawnDeps(state);
  return {
    chats: [...state.chats],
    syncHint: false,
    reportStatus: (level: 'ok' | 'err', message: string) => state.reports.push({ level, message }),
    spawn: ((input: Parameters<typeof spawnFollowupChat>[0]) =>
      spawnFollowupChat(input, deps)) as typeof spawnFollowupChat,
    generateTask: (async (summary: string) => {
      state.generated.push(summary);
      return { task: tasks.shift() ?? null };
    }) as never,
  };
}

afterEach(() => {
  stopFollowupRunner();
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
});

describe('/followup chain end to end', () => {
  test('runs a three-link chain and stops', async () => {
    const state = harness();
    const [chatA] = state.chats;

    // 1. The user asks for a three-link chain with a task for the first link.
    assert.equal(
      handleFollowupCommand(chatA!, '/followup 3 review the build for bugs and fix them', (level, message) =>
        state.reports.push({ level, message })),
      'armed',
    );
    assert.equal(getFollowupChain(chatA!)?.total, 3);

    // 2. The first link fires on the next sweep with the user's own task.
    const first = await runFollowupSweep(sweepOptions(state, ['fix the failing test', 'write the regression test']));
    assert.equal(first.fired, 1);
    assert.equal(hasFollowupChain(chatA!), false);
    assert.equal(state.generated.length, 0);

    const chatB = state.chats[1]!;
    assert.equal(getFollowupChain(chatB)?.index, 1);
    assert.equal(getFollowupChain(chatB)?.remaining, 2);
    assert.equal(getFollowupChain(chatB)?.promptText, '');
    assert.match(state.sends[0]!.text, /^Follow-up 1\/3 · continuing from "Build the widget"/);
    assert.match(state.sends[0]!.text, /fix the build/);
    assert.match(state.sends[0]!.text, /review the build for bugs and fix them/);
    assert.equal(state.sends[0]!.chatId, chatB.id);

    // 3. Link two is agent-chosen from the previous chat's summary.
    const second = await runFollowupSweep(sweepOptions(state, ['fix the failing test', 'write the regression test']));
    assert.equal(second.fired, 1);
    assert.equal(state.generated.length, 1);
    assert.match(state.generated[0]!, /fix the build/);

    const chatC = state.chats[2]!;
    assert.equal(getFollowupChain(chatC)?.index, 2);
    assert.equal(getFollowupChain(chatC)?.remaining, 1);
    assert.match(state.sends[1]!.text, /^Follow-up 2\/3/);
    assert.match(state.sends[1]!.text, /fix the failing test/);

    // 4. The third link closes the chain: no chain record, and nothing more fires.
    const third = await runFollowupSweep(sweepOptions(state, ['write the regression test']));
    assert.equal(third.fired, 1);

    const chatD = state.chats[3]!;
    assert.equal(chatD.followupChain, undefined);
    assert.match(state.sends[2]!.text, /^Follow-up 3\/3/);
    assert.match(state.sends[2]!.text, /write the regression test/);

    const after = await runFollowupSweep(sweepOptions(state, []));
    assert.equal(after.fired, 0);
    assert.equal(state.chats.length, 4);
    assert.equal(state.sends.length, 3);

    // Seeded summaries are never re-parsed as slash skills.
    assert.ok(state.sends.every((send) => send.parseSlash === false));
  });

  test('a bare /followup produces one agent-chosen follow-up', async () => {
    const state = harness();
    const [chatA] = state.chats;

    handleFollowupCommand(chatA!, '/followup', (level, message) =>
      state.reports.push({ level, message }));

    const result = await runFollowupSweep(sweepOptions(state, ['polish the widget']));

    assert.equal(result.fired, 1);
    assert.equal(state.generated.length, 1);
    assert.match(state.sends[0]!.text, /polish the widget/);
    assert.equal(state.chats[1]!.followupChain, undefined);
  });
});
