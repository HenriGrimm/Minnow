import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatHasListableContent, isSidebarListedChat, pruneEphemeralEmptyChats } from '../../src/state/session-workspace-scope';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';
import type { Chat, SessionState } from '../../src/types';

function empty(id: string): Chat {
  return { id, name: id, workspacePath: 'C:/project', modelId: 'model', history: [],
    updatedAt: 1, lastMessageAt: 1 } as Chat;
}

test('queued child shells survive navigation pruning before their input hydrates', () => {
  const child = empty('child');
  child.agentConversation = { version: 1, childChatId: 'child', parentChatId: 'parent',
    rootChatId: 'parent', journalOwnerId: 'parent', origin: 'delegated', createdAt: 1 };
  child.historyLoaded = false;
  child.messageCount = 0;
  const parent = empty('parent');
  parent.history = [{ role: 'user', content: 'Delegate this.' }];
  const state = { version: 6, activeId: 'parent', chats: [parent, child, empty('unused')] } as SessionState;
  pruneEphemeralEmptyChats(state, 'parent');
  assert.deepEqual(state.chats.map(chat => chat.id), ['parent', 'child']);
  assert.equal(chatHasListableContent(child), true);
});

test('an orphaned child remains reachable with an empty canonical history', () => {
  const child = empty('child');
  child.agentConversation = { version: 1, childChatId: 'child', parentChatId: null,
    rootChatId: 'parent', journalOwnerId: 'parent', origin: 'delegated', createdAt: 1, missingParent: true };
  const state = { version: 6, activeId: 'other', chats: [child, empty('other')] } as SessionState;
  pruneEphemeralEmptyChats(state, 'other');
  assert.equal(state.chats.find(row => row.id === 'child'), child);
});

test('a server-created empty ordinary root stays in the sidebar without moving the current chat', () => {
  const root = normalizeChatRow({ ...empty('new-root'), chatCommandVersion: 1, explicitOrdinaryRoot: true, historyLoaded: false, messageCount: 0 }) as Chat;
  const original = { ...empty('original'), composerDraft: 'Keep my draft' };
  const state = { version: 6, activeId: 'original', chats: [root, original, empty('unused')] } as SessionState;
  pruneEphemeralEmptyChats(state, 'original');
  assert.equal(isSidebarListedChat(root), true);
  assert.deepEqual(state.chats.map(chat => chat.id), ['new-root', 'original']);
  assert.equal(state.activeId, 'original');
  assert.equal(original.composerDraft, 'Keep my draft');
  assert.equal(root.agentConversation, undefined);
});
