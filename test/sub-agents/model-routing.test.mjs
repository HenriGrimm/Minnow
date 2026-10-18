import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSubAgentBinding } from '../../src/agents/sub-agent-binding.mjs';
import { makeEvent } from '../../server/sub-agents/events.js';
import { emptyState, foldInto, serializeState } from '../../server/sub-agents/derive.js';

test('sub-agent routing uses type, general routing, then the whole parent pair', () => {
  const parent = { providerId: 'parent', modelId: 'model-a' }, routing = { providerId: 'support', modelId: 'model-b' };
  assert.deepEqual(resolveSubAgentBinding({}, parent), { ...parent, source: 'parent' });
  assert.deepEqual(resolveSubAgentBinding({}, parent, routing), { ...routing, source: 'routing' });
  assert.deepEqual(resolveSubAgentBinding({ providerId: 'type', modelId: 'model-c' }, parent, routing), { providerId: 'type', modelId: 'model-c', source: 'type' });
  assert.deepEqual(resolveSubAgentBinding({ providerId: 'unused', modelId: '' }, parent), { ...parent, source: 'parent' });
  assert.throws(() => resolveSubAgentBinding({}, undefined), /No parent/);
});

test('a queued run persists its captured model and routing source independently of later settings', () => {
  const state = emptyState();
  foldInto(state, [makeEvent('run.requested', { runId: 'run', agentType: 'explore', task: 'inspect', parentChatId: 'parent', cwd: '/workspace', requestedAt: 1, model: { providerId: 'minnow-router', id: 'pool' }, modelSource: 'parent' })]);
  const saved = JSON.parse(serializeState(state));
  assert.deepEqual(saved.runs[0].model, { providerId: 'minnow-router', id: 'pool' });
  assert.equal(saved.runs[0].modelSource, 'parent');
});
