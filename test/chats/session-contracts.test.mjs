import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';

const relation = {
  version: 1, childChatId: 'child', parentChatId: 'parent', rootChatId: 'parent',
  journalOwnerId: 'parent', origin: 'delegated', createdAt: 1,
  profileReference: { profileId: 'profile', profileVersion: 1 },
  capabilities: { canSend: true, canStop: true, canChooseModel: true },
};

test('versioned lightweight child identity round-trips without copying a transcript', () => {
  const result = normalizeChatRow({ id: 'child', name: 'Research', history: [], agentConversation: relation });
  assert.deepEqual(result.agentConversation, relation);
  assert.equal(result.agentConversation.messages, undefined);
});

test('legacy chats do not acquire a fabricated child relationship', () => {
  assert.equal(normalizeChatRow({ id: 'old', history: [] }).agentConversation, undefined);
});

test('managed root dispatch metadata stays lightweight and rejects unknown record versions', () => {
  const root = normalizeChatRow({ id: 'root', history: [], chatCommandVersion: 1,
    profileReference: { profileId: 'root-profile', profileVersion: 1 } });
  assert.equal(root.chatCommandVersion, 1);
  assert.equal(root.agentConversation, undefined);
  assert.deepEqual(root.profileReference, { profileId: 'root-profile', profileVersion: 1 });
  assert.equal(normalizeChatRow({ id: 'root', history: [], chatCommandVersion: 2 }).chatCommandVersion, undefined);
});

test('malformed, mismatched, future or writable native relationship projections are dropped', () => {
  for (const value of [null, { ...relation, version: 2 }, { ...relation, childChatId: 'other' },
    { ...relation, parentChatId: 'child' }, { ...relation, origin: 'native' }, { ...relation, prompt: 'not a summary' }]) {
    assert.equal(normalizeChatRow({ id: 'child', history: [], agentConversation: value }).agentConversation, undefined);
  }
});

test('persisted message identity and actor survive the shared session normalization', () => {
  const message = { role: 'user', content: 'A peer request.', messageId: 'message', commandId: 'command',
    provenance: { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'sender', sourceTurnId: 'turn' } };
  const result = normalizeChatRow({ id: 'child', history: [message], agentConversation: relation });
  assert.deepEqual(result.history[0], message);
});
