import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexReadBatchTool, expandCodexReadBatch } from '../../server/generations/codex-app-server/read-batch.js';

const tools = new Map([['mn_tool_0', { originalName: 'read_file' }], ['mn_tool_1', { originalName: 'apply_patch' }]]);
const call = { name: 'read_file', arguments: { path: 'a' } };

test('read batch validates every member and bounds fan-out before execution', () => {
  assert.deepEqual(expandCodexReadBatch({ calls: [call, call] }, tools), [
    { name: 'read_file', arguments: '{"path":"a"}' }, { name: 'read_file', arguments: '{"path":"a"}' },
  ]);
  for (const args of [{ calls: [] }, { calls: Array(7).fill(call) }, { calls: [call], extra: true },
    { calls: [call, { name: 'apply_patch', arguments: {} }] }, { calls: [{ name: 'read_file', arguments: [] }] },
    { calls: [{ name: 'read_file', arguments: {}, extra: true }] }, { calls: [{ name: 'not_available', arguments: {} }] }]) {
    assert.throws(() => expandCodexReadBatch(args, tools), /Invalid|unavailable|non-read-only/);
  }
});

test('empty or mutating-only catalogs do not expose a batch tool', () => {
  assert.equal(codexReadBatchTool([]), null);
  assert.equal(codexReadBatchTool([{ originalName: 'apply_patch' }]), null);
});

test('batch members expose their argument schemas with local references rebased', () => {
  const schema = { type: 'object', required: ['path'], properties: { path: { $ref: '#/$defs/path' } },
    $defs: { path: { type: 'string' } } };
  const batch = codexReadBatchTool([{ originalName: 'read_file', description: 'Read a source file.', inputSchema: schema }]);
  const member = batch.inputSchema.properties.calls.items.anyOf[0];
  assert.equal(member.properties.name.const, 'read_file');
  assert.equal(member.properties.name.description, 'Read a source file.');
  assert.deepEqual(member.properties.arguments.required, ['path']);
  assert.equal(member.properties.arguments.properties.path.$ref,
    '#/properties/calls/items/anyOf/0/properties/arguments/$defs/path');
  assert.equal(schema.properties.path.$ref, '#/$defs/path', 'caller schema is unchanged');
});
