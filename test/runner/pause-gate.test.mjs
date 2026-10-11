import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPauseGate } from '../../server/runner/pause-gate.js';
import { executeToolCallBatch } from '../../server/runner/tool-batch.js';

test('paused tool waits do not spend the tool timeout or execute twice', async () => {
  const gate = createPauseGate();
  gate.setPaused(true);
  let calls = 0;
  let settled = false;
  const pending = executeToolCallBatch({
    toolCalls: [{ id: 'edit', function: { name: 'save_file', arguments: '{}' } }],
    pauseGate: gate,
    toolTimeoutMs: 10,
    execute: async () => { calls++; return { content: 'saved' }; },
  }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, 0);
  assert.equal(settled, false);
  gate.setPaused(false);
  assert.equal((await pending)[0].result.content, 'saved');
  assert.equal(calls, 1);
});

test('stop releases paused tool waiters without executing them', async () => {
  const gate = createPauseGate();
  const controller = new AbortController();
  gate.setPaused(true);
  const pending = executeToolCallBatch({
    toolCalls: [{ id: 'edit', function: { name: 'save_file', arguments: '{}' } }],
    pauseGate: gate,
    signal: controller.signal,
    execute: async () => { assert.fail('must not execute after stop'); },
  });
  controller.abort();
  assert.match((await pending)[0].result.content, /Stopped/);
});

test('rapid resume then pause does not leak a waiting operation', async () => {
  const gate = createPauseGate();
  gate.setPaused(true);
  let released = false;
  const pending = gate.wait().then(() => { released = true; });
  gate.setPaused(false);
  gate.setPaused(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, false);
  gate.setPaused(false);
  await pending;
  assert.equal(released, true);
});
