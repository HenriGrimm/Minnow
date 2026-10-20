import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { latestAttemptModel, renderAttemptModel } from '../../src/orchestrator/attempt-model.ts';

test('uses the latest valid assignment, including pool failover', () => {
  const events = [
    { type: 'model_selected', providerId: 'minnow-router', modelId: 'build-pool' },
    { type: 'model_selected', providerId: 'host-a', modelId: 'model-a', routerId: 'build-pool' },
    { type: 'model_selected', providerId: 'host-b', modelId: 'model-b', routerId: 'build-pool' },
    { type: 'model_selected', providerId: '', modelId: 'invalid' },
    { type: 'round_end' },
  ];
  assert.deepEqual(latestAttemptModel(events), { providerId: 'host-b', modelId: 'model-b', routerId: 'build-pool' });
  assert.deepEqual(latestAttemptModel(JSON.parse(JSON.stringify(events))), latestAttemptModel(events));
  assert.equal(latestAttemptModel([]), null);
});

test('renders direct models, routed models, awaiting routing and legacy transcripts', () => {
  const window = new Window();
  globalThis.document = window.document as unknown as Document;
  try {
    const direct = renderAttemptModel([{ type: 'model_selected', providerId: 'host', modelId: 'model' }]);
    assert.equal(direct.textContent, 'Modelhost / model');
    assert.equal(direct.querySelector('.ov2-attempt-model__pool'), null);
    const routed = renderAttemptModel([{ type: 'model_selected', providerId: 'host', modelId: '<model>', routerId: 'pool' }]);
    assert.equal(routed.querySelector('.ov2-attempt-model__value')?.textContent, 'host / <model>');
    assert.equal(routed.querySelector('model'), null);
    assert.match(routed.textContent!, /Pool: pool/);
    assert.match(renderAttemptModel([{ type: 'model_selected', providerId: 'minnow-router', modelId: 'pool' }]).textContent!, /Awaiting pool routing/);
    assert.match(renderAttemptModel([]).textContent!, /Not recorded/);
    assert.match(renderAttemptModel([
      { type: 'model_selected', providerId: 'minnow-router', modelId: 'pool' },
      { type: 'attempt_end', outcome: 'crashed' },
    ]).textContent!, /No routed model recorded/);
  } finally {
    window.happyDOM.abort();
  }
});
