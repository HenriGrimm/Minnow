import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeCodexSession } from '../../server/generations/codex-app-server/manager.js';

// A session with no process or private home: closing it only fails the running round.
const session = (onFailure) => ({ key: 'fixture\0chat', chatId: 'chat', providerId: 'fixture', closed: false, onFailure, clean: true });

test('closing a Codex session fails its running round with the caller\'s reason', async () => {
  const seen = [];
  await closeCodexSession(session((error) => seen.push(error.message)), { reason: 'Generation timed out after 60 minutes.' });
  await closeCodexSession(session((error) => seen.push(error.message)), { reason: new Error('Codex RPC turn/start timed out.') });
  await closeCodexSession(session((error) => seen.push(error.message)));
  assert.deepEqual(seen, ['Generation timed out after 60 minutes.', 'Codex RPC turn/start timed out.', 'Codex conversation closed.']);
});
