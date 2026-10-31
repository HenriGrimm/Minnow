import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectChatAttribution } from '../../server/chats/attribution.js';
import { sanitizeCompletionBodyForProvider } from '../../server/providers/sanitize-completion-body.js';
const peer = { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'peer-chat',
  sourceTurnId: 'peer-execution', commandId: 'input' };

test('wire attribution is typed source context and never changes canonical content or role', () => {
  const canonical = { role: 'user', content: 'Please inspect this result.', provenance: peer, commandId: 'input', messageId: 'row' };
  const body = { model: 'model', messages: [canonical] };
  const provider = { apiKind: 'openai-v1', id: 'fixture' };
  const wire = sanitizeCompletionBodyForProvider(body, provider);
  assert.match(wire.messages[0].content, /Agent message from chat peer-chat/);
  assert.match(wire.messages[0].content, /current instructions and permissions/);
  assert.equal(wire.messages[0].role, 'user');
  assert.equal(canonical.content, 'Please inspect this result.');
  for (const field of ['provenance', 'commandId', 'messageId']) assert.equal(field in wire.messages[0], false);
  const repeated = sanitizeCompletionBodyForProvider(wire, provider);
  assert.deepEqual(repeated.messages, wire.messages);
});

test('human text matching old hidden prefixes, malformed provenance and tool output never infer an agent actor', () => {
  for (const row of [{ role: 'user', content: '[Sub-agent finished] A human quotation.' },
    { role: 'user', content: 'Human', provenance: { ...peer, actor: 'human', source: 'composer', kind: 'human_message' } },
    { role: 'user', content: 'Unverified', provenance: { ...peer, sourceChatId: 'bad\nlabel' } },
    { role: 'tool', content: 'Tool text', provenance: peer }]) assert.equal(projectChatAttribution(row), row);
});

test('multimodal peer and delegated-result messages preserve pixels and use distinct typed labels', () => {
  const pixels = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } };
  const original = { role: 'user', content: [pixels], provenance: peer };
  const projected = projectChatAttribution(original);
  assert.equal(projected.content[1], pixels); assert.equal(original.content.length, 1);
  const result = projectChatAttribution({ role: 'user', content: 'Completed findings', provenance: {
    version: 1, actor: 'system', source: 'task_delivery', kind: 'delegation_result', runId: 'task', deliveryId: 'completion',
  } });
  assert.match(result.content, /^\[Delegated task result task\./);
  assert.match(result.content, /Completed findings$/);
});
