import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIImageAdapter } from '../../server/image-generation/adapters/openai.js';
import { createOpenRouterImageAdapter } from '../../server/image-generation/adapters/openrouter.js';
import { normalizeImageRequest } from '../../server/image-generation/contracts.js';

const runtime = { profile: { baseUrl: 'https://images.example.test' }, headers: { Authorization: 'Bearer fixture-key' } };
const response = () => new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=', media_type: 'image/png' }], usage: { total_tokens: 7, cost: 0.03 } }), { headers: { 'x-request-id': 'fixture' } });

test('OpenAI generates and edits using dedicated endpoints without retries', async () => {
  const calls = [];
  const adapter = createOpenAIImageAdapter(async (url, options) => { calls.push({ url: String(url), ...options }); return response(); });
  const request = normalizeImageRequest({ prompt: 'a fish', format: 'png' });
  const output = await adapter.generate({ runtime, modelId: 'gpt-image-1', request, references: [] });
  assert.equal(calls[0].url, 'https://images.example.test/v1/images/generations');
  assert.equal(calls[0].headers.Authorization, 'Bearer fixture-key');
  assert.equal(JSON.parse(calls[0].body).output_format, 'png');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(output.requestId, 'fixture');
  await adapter.generate({ runtime, modelId: 'gpt-image-1', request: { ...request, operation: 'edit' }, references: [{ bytes: Buffer.from('reference'), mime: 'image/png', extension: 'png' }] });
  assert.equal(calls[1].url, 'https://images.example.test/v1/images/edits');
  assert.equal(await calls[1].body.get('image[]').text(), 'reference');
  assert.equal(calls[1].body.get('n'), '1');
  let attempts = 0;
  const failing = createOpenAIImageAdapter(async () => { attempts++; return new Response('secret', { status: 429 }); });
  await assert.rejects(failing.generate({ runtime, modelId: 'gpt-image-1', request, references: [] }), /HTTP 429/);
  assert.equal(attempts, 1);
  await assert.rejects(adapter.generate({ runtime, modelId: 'gpt-image-1', request: { ...request, quality: 'invalid' }, references: [] }), /Unsupported/);
  assert.equal(calls.length, 2);
});

test('OpenRouter pins discovered endpoint, respects capability subsets, and preserves actual cost', async () => {
  const calls = [];
  const adapter = createOpenRouterImageAdapter(async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (String(url).endsWith('/images/models')) return Response.json({ data: [{ id: 'test/image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } }] });
    if (String(url).endsWith('/endpoints')) return Response.json({ endpoints: [{ provider_tag: 'fixture', supported_parameters: { output_format: { type: 'enum', values: ['png', 'svg'] }, input_references: { type: 'boolean' } } }] });
    return response();
  });
  const caps = await adapter.capabilities('test/image', runtime);
  assert.deepEqual(caps.options.format, ['png']);
  const request = normalizeImageRequest({ prompt: 'fish', operation: 'edit', reference_paths: ['fish.png'], format: 'png' });
  const output = await adapter.generate({ runtime, modelId: 'test/image', request, references: [{ mime: 'image/png', bytes: Buffer.from('ref') }], capabilities: caps });
  const wire = JSON.parse(calls.at(-1).body);
  assert.equal(calls.at(-1).url, 'https://images.example.test/v1/images');
  assert.deepEqual(wire.provider, { only: ['fixture'], allow_fallbacks: false });
  assert.match(wire.input_references[0].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(output.cost, { amount: 0.03, currency: 'USD', source: 'provider' });
  await assert.rejects(adapter.generate({ runtime, modelId: 'test/image', request: { ...request, quality: 'high' }, references: [], capabilities: caps }), /Unsupported quality/);
  assert.equal(calls.length, 3);
});

test('URLs, redirects and unbounded outputs are not downloaded', async () => {
  const adapter = createOpenAIImageAdapter(async () => Response.json({ data: [{ url: 'http://169.254.169.254/secret' }] }));
  await assert.rejects(adapter.generate({ runtime, modelId: 'gpt-image-1', request: normalizeImageRequest({ prompt: 'fish' }), references: [] }), /base64/);
});
