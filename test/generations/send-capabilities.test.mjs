/**
 * The generations store re-sanitizes every body before the wire. Callers that
 * already sanitized with the model's capabilities pass them along so that pass
 * keeps the reasoning effort instead of stripping it as unsupported.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, afterEach, before, describe, test } from 'node:test';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createProvider } from '../../server/providers/store.js';
import {
  createGenerationState,
  deleteGenerationsForProviderShutdown,
  getGenerationState,
} from '../../server/generations/store.js';
import { pumpUpstreamAsync } from '../../server/generations/upstream.js';
import { handleGenerationsRequest } from '../../server/generations/routes.js';
import { prepareResponsesRequest } from '../../server/generations/openai-responses/pump.js';
import { resetHostCooldownForTests } from '../../server/generations/host-cooldown.js';

const REASONING_CAPS = { reasoning: true, reasoningAllowedOptions: ['low', 'medium', 'high'] };
const OK_SSE = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

let homeDir;

function reasoningBody(model) {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    reasoning_effort: 'high',
  };
}

/** @param {import('node:test').TestContext} t */
function captureUpstream(t, failHosts = []) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body.toString()) });
    if (failHosts.some((host) => String(url).startsWith(host))) {
      return new Response('unavailable', { status: 503 });
    }
    return new Response(OK_SSE, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return requests;
}

function waitForTerminal(id, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const state = getGenerationState(id);
      if (state && ['complete', 'error', 'cancelled'].includes(state.status)) return resolve(state);
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for generation'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

before(async () => {
  homeDir = setTestHome(process.env, 'minnow-test-send-capabilities');
  await ensureMinnowLayout();
  await createProvider({ id: 'hosted-a', label: 'Hosted A', baseUrl: 'https://a.example.test/api/v1', apiKind: 'openai-v1' });
  await createProvider({ id: 'hosted-b', label: 'Hosted B', baseUrl: 'https://b.example.test/api/v1', apiKind: 'openai-v1' });
});

afterEach(() => {
  deleteGenerationsForProviderShutdown();
  resetHostCooldownForTests();
});

after(async () => {
  deleteGenerationsForProviderShutdown();
  await rmTestHome(homeDir);
});

describe('send capabilities in the upstream sanitize pass', () => {
  test('without capabilities the reasoning effort is still stripped', async (t) => {
    const requests = captureUpstream(t);
    const state = createGenerationState({ providerId: 'hosted-a', body: reasoningBody('vendor/reasoner') });
    await pumpUpstreamAsync({ state });
    assert.equal(state.status, 'complete', state.errorMessage);
    assert.equal('reasoning_effort' in requests[0].body, false);
  });

  test('capabilities with reasoning keep the effort on the wire', async (t) => {
    const requests = captureUpstream(t);
    const state = createGenerationState({
      providerId: 'hosted-a',
      body: reasoningBody('vendor/reasoner'),
      modelCapabilities: { ...REASONING_CAPS, vision: true, probeErrors: { tools: 'x' } },
    });
    assert.deepEqual(state.modelCapabilities, { 'vendor/reasoner': REASONING_CAPS });
    await pumpUpstreamAsync({ state });
    assert.equal(state.status, 'complete', state.errorMessage);
    assert.equal(requests[0].body.reasoning_effort, 'high');
  });

  test('capabilities that rule reasoning out still strip it', async (t) => {
    const requests = captureUpstream(t);
    const state = createGenerationState({
      providerId: 'hosted-a',
      body: reasoningBody('vendor/plain'),
      modelCapabilities: { reasoning: false },
    });
    await pumpUpstreamAsync({ state });
    assert.equal('reasoning_effort' in requests[0].body, false);
  });

  test('a fallback model does not inherit the requested model\'s capabilities', async (t) => {
    const requests = captureUpstream(t, ['https://a.example.test']);
    const state = createGenerationState({
      providerId: 'hosted-a',
      body: reasoningBody('vendor/reasoner'),
      candidates: [
        { providerId: 'hosted-a', modelId: 'vendor/reasoner' },
        { providerId: 'hosted-b', modelId: 'vendor/plain' },
      ],
      modelCapabilities: REASONING_CAPS,
    });
    await pumpUpstreamAsync({ state });
    assert.equal(state.status, 'complete', state.errorMessage);
    assert.equal(state.chosenModelId, 'vendor/plain');
    const primary = requests.filter((r) => r.url.startsWith('https://a.example.test'));
    const fallback = requests.filter((r) => r.url.startsWith('https://b.example.test'));
    assert.ok(primary.length > 0 && fallback.length === 1);
    assert.equal(primary[0].body.reasoning_effort, 'high');
    assert.equal('reasoning_effort' in fallback[0].body, false);
  });

  test('POST /api/generations forwards modelCapabilities to the upstream pass', async (t) => {
    const requests = captureUpstream(t);
    const payload = {
      providerId: 'hosted-a',
      body: reasoningBody('vendor/reasoner'),
      modelCapabilities: REASONING_CAPS,
    };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), {
      method: 'POST',
      url: '/api/generations',
    });
    const res = await new Promise((resolve) => {
      const out = { statusCode: 0, text: '', setHeader() {}, end(text) { out.text = text; resolve(out); } };
      void handleGenerationsRequest(req, out, '/api/generations');
    });
    assert.equal(res.statusCode, 201, res.text);
    const state = await waitForTerminal(JSON.parse(res.text).generationId);
    assert.equal(state.status, 'complete', state.errorMessage);
    assert.equal(requests[0].body.reasoning_effort, 'high');
  });

  test('the Responses mapping keeps the effort when capabilities allow it', () => {
    const profile = { apiKind: 'openai-v1', id: 'hosted-a', baseUrl: 'https://a.example.test/api/v1' };
    const raw = Buffer.from(JSON.stringify(reasoningBody('gpt-5')));
    const blind = prepareResponsesRequest(raw, profile, 'gpt-5', 'hosted-a', null);
    assert.equal(blind.responsesBody.reasoning, undefined);
    const known = prepareResponsesRequest(raw, profile, 'gpt-5', 'hosted-a', null, REASONING_CAPS);
    assert.equal(known.responsesBody.reasoning?.effort, 'high');
  });
});
