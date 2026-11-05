import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMessages, prepareConversation, continuation, seedConversation } from '../../server/generations/codex-app-server/conversation.js';

const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=', detail: 'high' } };
const user = content => ({ role: 'user', content });

test('read batch advertises only permitted safe names and preserves explicit tool choice', () => {
  const tools = ['read_file', 'apply_patch', 'mcp__external', 'read_symbol'].map(name => ({ type: 'function',
    function: { name, parameters: { type: 'object', properties: {} } } }));
  const prepare = tool_choice => prepareConversation({ messages: [user('Read.')], tools, tool_choice }, {});
  const batch = prepare().dynamicTools.find(tool => tool.name === 'mn_read_batch');
  assert.deepEqual(batch.inputSchema.properties.calls.items.properties.name.enum, ['read_file', 'read_symbol']);
  assert.equal(batch.inputSchema.properties.calls.maxItems, 6);
  for (const choice of ['none', 'required', { type: 'function', function: { name: 'read_file' } }]) {
    assert.ok(!prepare(choice).dynamicTools.some(tool => tool.name === 'mn_read_batch'));
  }
});

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

test('native seed elides an older result while a pending handoff uses the original receipts', () => {
  const call = { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] };
  const result = { role: 'tool', tool_call_id: 'a', content: 'r'.repeat(8 * 1024 * 1024) };
  const before = [user('first'), call, result, user('current'), { ...call, tool_calls: [{ ...call.tool_calls[0], id: 'b' }] }];
  const after = [...before, { role: 'tool', tool_call_id: 'b', content: 'written once' }];
  const prepared = prepareConversation({ messages: after }, {});
  assert.ok(prepared.messages[2].content.startsWith('[tool result elided'));
  assert.equal(prepared.messages.at(-1).content, 'written once');
  const resume = continuation({ signature: prepared.signature, waiting: true, handed: [{ id: 'b' }], accepted: normalizeMessages(before) }, prepared);
  assert.equal(resume.results.get('b')[0].text, 'written once');
  assert.equal(result.content.length, 8 * 1024 * 1024);
});

test('the native byte limit includes JSON framing and measures UTF-8', () => {
  const limit = 8 * 1024 * 1024, room = limit - Buffer.byteLength(JSON.stringify([user('')]));
  const exact = user('a'.repeat(room - 2) + 'é');
  assert.equal(prepareConversation({ messages: [exact] }, {}).messages[0].content, exact.content);
  assert.throws(() => prepareConversation({ messages: [user(exact.content + 'x')] }, {}), /8388609 bytes remain/);
});

test('an old image-heavy turn yields space to the current image and text', () => {
  const historical = user(Array(12).fill(image));
  const current = user([{ type: 'text', text: 'inspect this' }, image]);
  const seed = prepareConversation({ messages: [historical, { role: 'assistant', content: 'done' }, current] }, {});
  assert.deepEqual(seed.messages, normalizeMessages([current]));
  assert.equal(historical.content.length, 12);
  const large = user([{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'AAAA'.repeat(2 * 1024 * 1024) } }]);
  assert.deepEqual(prepareConversation({ messages: [large, { role: 'assistant', content: 'done' }, current] }, {}).messages, normalizeMessages([current]));
  assert.throws(() => prepareConversation({ messages: [large] }, {}), /Reduce the current input, attachments/);
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
  assert.deepEqual(resume([tool('one'), tool('two'), { ...followUp, toolImageCallId: 'one' }]).results, valid.results);
  assert.equal(resume([tool('one'), tool('two'), { ...followUp, toolImageCallId: 'unknown' }]), null);
  assert.equal(resume([tool('one'), followUp]), null);
  assert.equal(resume([tool('one'), followUp, tool('one')]), null);
  assert.equal(resume([tool('one'), user([image]), tool('two')]), null);
  assert.equal(resume([tool('one'), tool('unknown')]), null);
});
