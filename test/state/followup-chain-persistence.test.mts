/**
 * MIN-206 — /followup chain persistence: normalizeChatRow round-trip + chat helpers.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';
import {
  clearFollowupChain,
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  getFollowupChain,
  hasFollowupChain,
  setFollowupChain,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import type { FollowupChainState } from '../../src/types.ts';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';

function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CHAT_ID,
    name: 'Chain source',
    workspacePath: '',
    modelId: 'm1',
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1,
    lastMessageAt: 1,
    ...extra,
  };
}

function validChain(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 'c1',
    total: 3,
    index: 1,
    remaining: 2,
    promptText: '',
    modeId: 'build',
    rootChatId: 'root-chat',
    parentChatId: 'root-chat',
    createdAt: 1,
    ...extra,
  };
}

function normalizedChain(extra: Record<string, unknown> = {}): FollowupChainState {
  return {
    chainId: 'c1',
    total: 3,
    index: 1,
    remaining: 2,
    promptText: '',
    modeId: 'build',
    rootChatId: 'root-chat',
    parentChatId: 'root-chat',
    createdAt: 1,
    ...extra,
  } as FollowupChainState;
}

afterEach(() => {
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
});

describe('normalizeChatRow followupChain', () => {
  test('a valid chain survives the round-trip', () => {
    const out = normalizeChatRow(row({ followupChain: validChain() })) as Record<string, any>;
    assert.deepEqual(out.followupChain, normalizedChain());
  });

  test('a chat with no chain keeps no field', () => {
    const out = normalizeChatRow(row()) as Record<string, any>;
    assert.equal(out.followupChain, undefined);
  });

  test('a finished chain (remaining 0) persists as no chain', () => {
    const out = normalizeChatRow(
      row({ followupChain: validChain({ total: 3, index: 3, remaining: 0 }) }),
    ) as Record<string, any>;
    assert.equal(out.followupChain, undefined);
  });

  test('drops rows that cannot be trusted', () => {
    const cases: Record<string, unknown>[] = [
      validChain({ chainId: '   ' }),
      validChain({ chainId: 7 }),
      validChain({ total: 0 }),
      validChain({ total: 11 }),
      validChain({ index: 9 }),
      validChain({ index: -1 }),
      validChain({ total: '3' }),
      validChain({ rootChatId: '' }),
      validChain({ parentChatId: undefined }),
      'not-an-object',
    ];
    for (const chain of cases) {
      const out = normalizeChatRow(row({ followupChain: chain })) as Record<string, any>;
      assert.equal(out.followupChain, undefined, `expected drop for ${JSON.stringify(chain)}`);
    }
  });

  test('normalizes mode, prompt length, and missing timestamps', () => {
    const longPrompt = 'p'.repeat(5000);
    const out = normalizeChatRow(
      row({
        followupChain: validChain({
          modeId: 'reef',
          promptText: longPrompt,
          createdAt: 0,
        }),
      }),
    ) as Record<string, any>;

    assert.equal(out.followupChain.modeId, 'build');
    assert.equal(out.followupChain.promptText.length, 4000);
    assert.ok(out.followupChain.createdAt > 0);
  });

  test('keeps an explicit plan mode', () => {
    const out = normalizeChatRow(
      row({ followupChain: validChain({ modeId: 'plan' }) }),
    ) as Record<string, any>;
    assert.equal(out.followupChain.modeId, 'plan');
  });
});

describe('followup chain chat helpers', () => {
  test('set, read, and clear a chain', () => {
    const chat = createEmptyChatObject('m1');
    assert.equal(getFollowupChain(chat), null);
    assert.equal(hasFollowupChain(chat), false);

    const chain = normalizedChain();
    setFollowupChain(chat, chain);
    assert.deepEqual(getFollowupChain(chat), chain);
    assert.equal(hasFollowupChain(chat), true);

    assert.equal(clearFollowupChain(chat), true);
    assert.equal(chat.followupChain, undefined);
    assert.equal(hasFollowupChain(chat), false);
    assert.equal(clearFollowupChain(chat), false);
  });

  test('a chain with no remaining links is not pending', () => {
    const chat = createEmptyChatObject('m1');
    chat.followupChain = normalizedChain({ total: 2, index: 2, remaining: 0 });
    assert.equal(getFollowupChain(chat), null);
    assert.equal(hasFollowupChain(chat), false);
  });
});
