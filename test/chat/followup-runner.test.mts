/**
 * MIN-206 — /followup chain runner (sweep, single-flight, restore on failure).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  getFollowupChain,
  hasFollowupChain,
  setFollowupChain,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import {
  runFollowupSweep,
  stopFollowupRunner,
  type FollowupSweepOptions,
} from '../../src/chat/followup/runner.ts';
import type { Chat, FollowupChainState } from '../../src/types.ts';

let activeWindow: Window | undefined;

function setup(): void {
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);
}

afterEach(() => {
  stopFollowupRunner();
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
  activeWindow?.close();
  activeWindow = undefined;
});

function chain(overrides: Partial<FollowupChainState> = {}): FollowupChainState {
  return {
    chainId: 'chain-1',
    total: 2,
    index: 0,
    remaining: 2,
    promptText: 'review the build',
    modeId: 'build',
    rootChatId: 'root',
    parentChatId: 'root',
    createdAt: 1,
    ...overrides,
  };
}

interface Harness {
  chat: Chat;
  spawns: Array<{ chatId: string; taskText: string; summary: string }>;
  reports: Array<{ level: string; message: string }>;
  generateCalls: string[];
  options: FollowupSweepOptions;
}

function harness(options: { chain?: FollowupChainState; generateTask?: string | null } = {}): Harness {
  setup();
  const chat = createEmptyChatObject('m1', 'C:/ws/min-206');
  chat.id = 'root';
  chat.name = 'Build work';
  chat.history = [
    { role: 'user', content: 'fix the build' },
    { role: 'assistant', content: 'build fixed' },
  ];
  chat.historyLoaded = true;
  if (options.chain !== undefined) setFollowupChain(chat, options.chain);

  setSessionStateForTests({
    ...defaultSessionState(),
    activeId: chat.id,
    chats: [chat],
  });

  const state: Harness = {
    chat,
    spawns: [],
    reports: [],
    generateCalls: [],
    options: {},
  };

  state.options = {
    chats: [chat],
    syncHint: false,
    reportStatus: (level, message) => state.reports.push({ level, message }),
    spawn: (async (input: { sourceChat: Chat; taskText: string; summary: string }) => {
      state.spawns.push({
        chatId: input.sourceChat.id,
        taskText: input.taskText,
        summary: input.summary,
      });
      return { ok: true, chatId: 'spawned-1' };
    }) as never,
    generateTask: (async (summary: string) => {
      state.generateCalls.push(summary);
      return { task: options.generateTask ?? null };
    }) as never,
  };

  return state;
}

describe('runFollowupSweep', () => {
  test('fires an idle chat once and clears its chain', async () => {
    const state = harness({ chain: chain() });

    const result = await runFollowupSweep(state.options);

    assert.equal(result.fired, 1);
    assert.equal(state.spawns.length, 1);
    assert.equal(state.spawns[0]?.taskText, 'review the build');
    assert.equal(hasFollowupChain(state.chat), false);
    assert.equal(state.generateCalls.length, 0);
  });

  test('passes the source chat summary to the spawner', async () => {
    const state = harness({ chain: chain() });
    await runFollowupSweep(state.options);
    assert.match(state.spawns[0]?.summary ?? '', /fix the build/);
  });

  test('skips a busy chat and keeps its chain', async () => {
    const state = harness({ chain: chain() });
    const result = await runFollowupSweep({ ...state.options, isIdle: () => false });

    assert.equal(result.fired, 0);
    assert.equal(state.spawns.length, 0);
    assert.equal(hasFollowupChain(state.chat), true);
  });

  test('ignores chats with no chain', async () => {
    const state = harness();
    const result = await runFollowupSweep(state.options);
    assert.equal(result.fired, 0);
    assert.equal(state.spawns.length, 0);
  });

  test('uses the generator when the chain has no prompt', async () => {
    const state = harness({
      chain: chain({ promptText: '' }),
      generateTask: 'fix the flaky test',
    });

    await runFollowupSweep(state.options);

    assert.equal(state.generateCalls.length, 1);
    assert.equal(state.spawns[0]?.taskText, 'fix the flaky test');
  });

  test('falls back to the last request when generation yields nothing', async () => {
    const state = harness({ chain: chain({ promptText: '' }), generateTask: null });

    await runFollowupSweep(state.options);

    assert.match(state.spawns[0]?.taskText ?? '', /^Continue the work from the previous chat/);
  });

  test('a failing spawn restores the chain and reports', async () => {
    const state = harness({ chain: chain() });
    const result = await runFollowupSweep({
      ...state.options,
      spawn: (async () => ({ ok: false, error: 'no room' })) as never,
    });

    assert.equal(result.fired, 0);
    assert.equal(hasFollowupChain(state.chat), true);
    assert.equal(getFollowupChain(state.chat)?.remaining, 2);
    assert.ok(state.reports.some((row) => row.level === 'err' && /no room/.test(row.message)));
  });

  test('a throwing spawn restores the chain and reports', async () => {
    const state = harness({ chain: chain() });
    const result = await runFollowupSweep({
      ...state.options,
      spawn: (async () => {
        throw new Error('kaboom');
      }) as never,
    });

    assert.equal(result.fired, 0);
    assert.equal(hasFollowupChain(state.chat), true);
    assert.ok(state.reports.some((row) => /kaboom/.test(row.message)));
  });

  test('two overlapping sweeps fire only once', async () => {
    const state = harness({ chain: chain() });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const options: FollowupSweepOptions = {
      ...state.options,
      spawn: (async (input: { sourceChat: Chat; taskText: string }) => {
        state.spawns.push({ chatId: input.sourceChat.id, taskText: input.taskText, summary: '' });
        await gate;
        return { ok: true, chatId: 'spawned-1' };
      }) as never,
    };

    const first = runFollowupSweep(options);
    const second = await runFollowupSweep(options);
    release?.();
    await first;

    assert.equal(second.skipped, 'sweep_in_progress');
    assert.equal(state.spawns.length, 1);
  });
});
