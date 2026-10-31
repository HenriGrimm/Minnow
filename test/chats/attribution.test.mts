import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmptyChatObject } from '../../src/state/sessions.ts';
import { buildApiMessages, overlayMultimodalHistoryForRunTurn } from '../../src/chat/build-api-messages.ts';
import { sanitizeCompletionBodyForProvider } from '../../src/providers/sanitize-completion-body.ts';

test('common renderer transcript and multimodal overlay share attribution without retaining application routing fields', () => {
  const chat = createEmptyChatObject('model', '/fixture');
  chat.history = [{ role: 'user', content: 'Peer request', images: [{ name: 'image.png', dataUrl: 'data:image/png;base64,AA==' }],
    provenance: { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'sibling', sourceTurnId: 'sibling-turn' } },
    { role: 'assistant', content: 'Inspected.' }, { role: 'user', content: 'Continue.' }];
  const messages = buildApiMessages(chat, 'System', { attachments: [], vision: true });
  assert.match(JSON.stringify(messages), /Agent message from chat sibling/);
  const overlay = overlayMultimodalHistoryForRunTurn(chat, { attachments: [], vision: true });
  assert.match(JSON.stringify(overlay), /Agent message from chat sibling/);
  assert.match(JSON.stringify(overlay), /data:image\/png;base64,AA==/);
  assert.equal(chat.history[0].content, 'Peer request');
  const body = sanitizeCompletionBodyForProvider({ messages: overlay }, { id: 'fixture', apiKind: 'openai-v1', label: 'Fixture', baseUrl: 'https://fixture.invalid' });
  assert.equal((JSON.stringify(body).match(/Agent message from chat sibling/g) ?? []).length, 1);
  assert.equal(JSON.stringify(body).includes('provenance'), false);
});
