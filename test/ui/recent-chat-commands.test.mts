import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../src/types';
import { buildRecentChatCommands } from '../../src/ui/recent-chat-commands';

test('recent chats use metadata recency and open the selected id without reading history', () => {
  const chats = Array.from({ length: 15 }, (_, index) => ({
    id: String(index), name: index === 14 ? '' : `Chat ${index}`, updatedAt: index,
    get history() { throw new Error('must not hydrate history'); },
  })) as Chat[];
  const originalOrder = chats.map((chat) => chat.id);
  let selected = '';
  const commands = buildRecentChatCommands(chats, (id) => { selected = id; });
  assert.equal(commands.length, 12);
  assert.equal(commands[0].title, 'Untitled chat');
  assert.equal(commands[0].category, 'Chats');
  commands[0].run();
  assert.equal(selected, '14');
  assert.deepEqual(chats.map((chat) => chat.id), originalOrder);
});

test('last message time wins over metadata edits and an empty list has no commands', () => {
  const chats = [
    { id: 'edited', name: 'Edited', updatedAt: 100, lastMessageAt: 5 },
    { id: 'active', name: 'Active', updatedAt: 10, lastMessageAt: 50 },
  ] as Chat[];
  assert.equal(buildRecentChatCommands(chats, () => {})[0].title, 'Active');
  assert.deepEqual(buildRecentChatCommands([], () => {}), []);
});
