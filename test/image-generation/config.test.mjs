import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeImageGenerationConfig, normalizeImageRequest, validateImageCapabilities } from '../../server/image-generation/contracts.js';
import { mergeConfigMeta, normalizeToolConfig } from '../../server/config/validators.js';
import { resolveImageBinding } from '../../server/image-generation/config.js';
import { createOpenAIImageAdapter } from '../../server/image-generation/adapters/openai.js';

test('old profiles remain disabled; settings merge without changing chat routing', () => {
  assert.equal(mergeImageGenerationConfig(null, {}).enabled, false);
  const before = { utilityModel: { modelId: 'chat' }, imageGeneration: { providerId: 'images', defaults: { format: 'png' } } };
  const after = mergeConfigMeta(before, { imageGeneration: { modelId: 'image', defaults: { quality: 'high' } } });
  assert.equal(after.utilityModel.modelId, 'chat');
  assert.equal(after.imageGeneration.providerId, 'images');
  assert.deepEqual(after.imageGeneration.defaults, { format: 'png', quality: 'high' });
  assert.equal(mergeConfigMeta(after, { imageGeneration: null }).imageGeneration.enabled, false);
});

test('invalid settings and arguments fail closed', () => {
  for (const patch of [{ enabled: 'yes' }, { timeoutSeconds: 0 }, { maxConcurrentJobs: 99 }, { apiKey: 'secret' }, { defaults: { seed: 4 } }]) assert.throws(() => mergeImageGenerationConfig(null, patch));
  for (const request of [{ prompt: '' }, { prompt: 'x', n: 2 }, { prompt: 'x', operation: 'edit' }, { prompt: 'x', reference_paths: ['a'] }]) assert.throws(() => normalizeImageRequest(request));
  const caps = createOpenAIImageAdapter().capabilities('gpt-image-1');
  assert.throws(() => validateImageCapabilities(normalizeImageRequest({ prompt: 'x', format: 'jpeg', background: 'transparent' }), caps));
  assert.throws(() => validateImageCapabilities(normalizeImageRequest({ prompt: 'x', quality: 'unknown' }), caps));
});

test('bindings require an explicit enabled provider and adapter', async () => {
  const config = { enabled: true, providerId: 'separate', adapterId: 'test', modelId: 'image' };
  await assert.rejects(resolveImageBinding(config), /adapter unavailable/);
  await assert.rejects(resolveImageBinding(config, async () => { throw new Error('secret'); }, () => ({})), /provider unavailable/);
  const resolved = await resolveImageBinding(config, async () => ({ profile: { enabled: true, apiKind: 'openai-v1' }, secrets: { key: 'secret' } }), () => ({}));
  assert.equal(resolved.binding.modelId, 'image');
  assert.ok(!JSON.stringify(resolved.binding).includes('secret'));
  assert.equal(normalizeToolConfig({}).permissions.default.generate_image, 'ask');
});
