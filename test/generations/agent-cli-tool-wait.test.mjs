import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentCliToolWaitMs } from '../../server/generations/agent-cli/tool-wait.js';

const call = (name, args = {}) => ({ function: { name, arguments: JSON.stringify(args) } });

test('CLI handoff remains alive through long commands and sequential batches', () => {
  assert.ok(agentCliToolWaitMs([call('execute_command', { timeout_ms: 600000 })]) > 630000);
  assert.ok(agentCliToolWaitMs([
    call('execute_command', { timeout_ms: 600000 }), call('execute_command', { timeout_ms: 600000 }),
  ]) > 2 * 630000);
  assert.ok(agentCliToolWaitMs([call('read_file')]) >= 300000);
});

test('CLI abandoned handoffs still have a finite deadline', () => {
  for (const calls of [[], [call('ask_question')], [call('execute_command', { timeout_ms: 1e15 })],
    [{ function: { name: 'read_file', arguments: '{bad json' } }]]) {
    const wait = agentCliToolWaitMs(calls);
    assert.ok(Number.isFinite(wait) && wait >= 300000 && wait <= 660000);
  }
});
