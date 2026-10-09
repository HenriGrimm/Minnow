import test from 'node:test';
import assert from 'node:assert/strict';
import { saveImageGenerationConfig } from '../../src/config/image-generation-meta.ts';
import { mergeImageGenerationConfig } from '../../server/image-generation/contracts.js';

test('saving a different image model removes old defaults rather than merging them back', async t => {
  let stored = mergeImageGenerationConfig(null, { enabled: true, providerId: 'images', adapterId: 'openai', modelId: 'old', defaults: { quality: 'high', size: '1024x1024' } });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const patch = JSON.parse(String(init?.body));
    stored = mergeImageGenerationConfig(stored, patch.imageGeneration);
    return new Response('{}');
  });
  await saveImageGenerationConfig({ ...stored, modelId: 'new', defaults: {} });
  assert.equal(stored.modelId, 'new'); assert.deepEqual(stored.defaults, {});
  await saveImageGenerationConfig({ ...stored, defaults: { format: 'webp' } });
  assert.deepEqual(stored.defaults, { format: 'webp' });
});
