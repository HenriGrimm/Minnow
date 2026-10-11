/**
 * The renderer sanitizes a chat body with the model's send capabilities, so it
 * must hand the reasoning half of them to /api/generations: the server
 * re-sanitizes before the wire and strips reasoning effort without them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeneration } from '../../src/api/generations.ts';

test('createGeneration forwards only the reasoning capabilities', async (t) => {
  let payload: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    payload = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ generationId: 'gen_caps' }), { status: 201 });
  });

  await createGeneration('hosted', { model: 'vendor/reasoner', reasoning_effort: 'high' }, {
    modelCapabilities: {
      reasoning: true,
      reasoningAllowedOptions: ['low', 'high'],
      vision: true,
      probeErrors: { tools: 'unsupported' },
    } as never,
  });
  assert.deepEqual(payload.modelCapabilities, {
    reasoning: true,
    reasoningAllowedOptions: ['low', 'high'],
  });

  await createGeneration('hosted', { model: 'vendor/reasoner' });
  assert.equal('modelCapabilities' in payload, false);
});
