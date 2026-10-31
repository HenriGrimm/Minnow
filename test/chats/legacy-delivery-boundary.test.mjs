import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDelivery, createMemoryJournal, buildProductionParentMessage } from '../../server/sub-agents/delivery.js';
import { makeEvent } from '../../server/sub-agents/events.js';

test('legacy delivery, acknowledgement and nudges cannot consume persistent-chat task subscriptions', async () => {
  const journal = createMemoryJournal(), delivered = [];
  for (const [runId, managed, finished] of [['legacy', false, true], ['managed', true, true], ['running-managed', true, false]]) {
    await journal.appendEvent('family', makeEvent('run.requested', { runId, agentType: 'explore', task: runId,
      parentChatId: 'family', cwd: '/fixture', requestedAt: 1000,
      ...(managed ? { childChatId: 'child-' + runId, journalOwnerId: 'family', commandId: 'command-' + runId, executionKind: 'chat',
        completionPolicy: { version: 1, kind: 'wake_delegator', recipientChatId: 'recipient', subscriptionId: 'wake-' + runId, cancellationEpoch: 0 } } : {}) }));
    await journal.appendEvent('family', makeEvent('attempt.started', { runId, attemptId: 'attempt-' + runId, seed: { kind: 'initial' } }));
    if (finished) await journal.appendEvent('family', makeEvent('attempt.ended', { runId, attemptId: 'attempt-' + runId,
      outcome: 'pass', summary: runId + ' summary' }));
  }
  const delivery = createDelivery({ journal, buildMessage: buildProductionParentMessage,
    deliverToParent: async (_parent, message, meta) => delivered.push({ message, meta }) });
  await delivery.tick('family');
  assert.equal(delivered.length, 1); assert.deepEqual(delivered[0].meta.runIds, ['legacy']);
  assert.doesNotMatch(delivered[0].message, /managed summary/);
  assert.deepEqual(await delivery.acknowledge('family', ['managed']), []);
  assert.equal(await delivery.offerNudge({ parentChatId: 'family', runId: 'running-managed', elapsedSec: 30 }), false);
  const state = await journal.loadState('family');
  assert.equal(state.runs.get('managed').delivered, false);
  assert.equal(state.runs.get('running-managed').nudged, false);
  delivery.reset();
});
