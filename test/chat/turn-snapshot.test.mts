import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildTurnSnapshot,
  resolveForkHistoryIndex,
  sha256Hex,
} from '../../src/chat/turn-snapshot.ts';
import type { Chat } from '../../src/types.ts';

describe('turn-snapshot', () => {
  test('sha256Hex is stable for fixed input', async () => {
    const a = await sha256Hex('{"role":"user"}');
    const b = await sha256Hex('{"role":"user"}');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$|^fallback_/);
  });

  test('buildTurnSnapshot captures the shared agent and tools', async () => {
    const chat: Chat = {
      id: 'c1',
      name: 'T',
      workspacePath: '',
      modelId: 'qwen',
      modeId: 'plan',
      workAgentId: 'coder',
      workAgentAuto: false,
      history: [{ role: 'user', content: 'hi' }],
      lastStats: null,
      modelInfo: {},
      updatedAt: 1,
    };
    const snap = await buildTurnSnapshot({
      chat,
      forkHistoryIndex: 0,
      composedSystemPrompt: 'SYS',
      enabledToolNames: ['grep', 'read_file'],
      providerId: 'local',
      modelId: 'qwen',
      temperature: 0.5,
      maxTokens: 2048,
      skillId: null,
      userContent: 'hi',
    });
    assert.equal(snap.modeId, 'build');
    assert.equal(snap.workAgentId, 'coder');
    assert.deepEqual(snap.enabledToolNames, ['grep', 'read_file']);
    assert.equal(snap.composedSystemPrompt, 'SYS');
    assert.equal(snap.historyPrefixHash.length > 0, true);
  });

  test('resolveForkHistoryIndex respects pushUser', () => {
    const chat: Chat = {
      id: 'c1',
      name: 'T',
      workspacePath: '',
      modelId: '',
      history: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
      lastStats: null,
      modelInfo: {},
      updatedAt: 1,
    };
    assert.equal(resolveForkHistoryIndex(chat, false), 2);
    assert.equal(resolveForkHistoryIndex(chat, true), 2);
  });
});
