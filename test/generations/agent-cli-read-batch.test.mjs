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
