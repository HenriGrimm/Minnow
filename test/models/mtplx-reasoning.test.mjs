import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mtplxReasoningCatalog } from '../../server/models/mtplx-reasoning.js';

test('MTPLX library and runtime aliases use descriptor effort controls', () => {
  const descriptor = { reasoning: { supported: true, modes: ['auto', 'on', 'off'],
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'xhigh' } };
  const reasoning = mtplxReasoningCatalog('opaque-alias', descriptor);
  assert.deepEqual(reasoning.allowed_options, ['off', 'on', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(reasoning.default, 'xhigh');
  assert.equal(mtplxReasoningCatalog('opaque-alias'), undefined);
  assert.deepEqual(mtplxReasoningCatalog('Qwen3.8', { reasoning: { supported: false } }), {
    allowed_options: ['off'], default: 'off',
  });
});
