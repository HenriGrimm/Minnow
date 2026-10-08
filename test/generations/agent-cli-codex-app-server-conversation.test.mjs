import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMessages, prepareConversation, continuation, seedConversation } from '../../server/generations/codex-app-server/conversation.js';

const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=', detail: 'high' } };
const user = content => ({ role: 'user', content });

test('Codex validates image content before inference and retains the transcript bound', () => {
  for (const url of ['https://example.com/private.png', 'file:///tmp/image.png', 'data:image/svg+xml;base64,aW1hZ2U=',
    'data:image/png;base64,abc', 'data:image/png;base64,!!!']) {
    assert.throws(() => normalizeMessages([user([{ type: 'image_url', image_url: { url } }])]), /data URLs|invalid/);
  }
  assert.throws(() => normalizeMessages([user(Array(13).fill(image))]), /at most 12/);
  assert.throws(() => normalizeMessages([{ role: 'system', content: [image] }]), /attachment type/);
  assert.throws(() => normalizeMessages([user([{ type: 'input_audio' }])]), /attachment type/);
  assert.throws(() => prepareConversation({ messages: [user('x'.repeat(8 * 1024 * 1024))] }, {}), /transcript exceeds/);
  assert.deepEqual(normalizeMessages([user([{ type: 'text', text: 'One' }, { type: 'text', text: 'Two' }])]),
    [user('One\nTwo')], 'existing text-only checkpoint normalization stays compatible');
});

test('Codex image normalization is canonical, preserves order and leaves caller messages intact', () => {
  const messages = [user([{ type: 'text', text: 'Before' }, image, { type: 'text', text: 'After' }])];
  const original = structuredClone(messages);
  const prepared = prepareConversation({ messages }, {});
  assert.deepEqual(messages, original);
  assert.deepEqual(seedConversation(prepared).input,
    [{ type: 'text', text: 'Before' }, { type: 'image', url: image.image_url.url }, { type: 'text', text: 'After' }]);
  const equivalent = prepareConversation({ messages: [user([{ type: 'text', text: 'Before' },
    { type: 'image_url', image_url: image.image_url.url }, { type: 'text', text: 'After' }])] }, {});
  assert.deepEqual(prepared.messages, equivalent.messages);
});

test('Codex tool-image continuation requires a complete, unique set of recorded results', () => {
  const before = [user('Start')];
  const prepared = prepareConversation({ messages: before }, {});
  const session = { signature: prepared.signature, accepted: prepared.messages, handed: [{ id: 'one' }, { id: 'two' }], waiting: true };
  const tool = id => ({ role: 'tool', tool_call_id: id, content: id });
  const followUp = { ...user([image]), toolImageFollowUp: true };
  const resume = rows => continuation(session, prepareConversation({ messages: [...before, ...rows] }, {}));
  const valid = resume([tool('one'), followUp, tool('two')]);
  assert.deepEqual(valid.results.get('one'), [{ type: 'inputText', text: 'one' }, { type: 'inputImage', imageUrl: image.image_url.url }]);
  assert.deepEqual(valid.results.get('two'), [{ type: 'inputText', text: 'two' }]);
  assert.equal(resume([tool('one'), followUp]), null);
  assert.equal(resume([tool('one'), followUp, tool('one')]), null);
  assert.equal(resume([tool('one'), user([image]), tool('two')]), null);
  assert.equal(resume([tool('one'), tool('unknown')]), null);
});
