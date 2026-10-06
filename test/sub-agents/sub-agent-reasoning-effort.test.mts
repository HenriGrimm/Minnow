/**
 * Sub-agent runner inherits parent chat reasoning effort when model supports levels.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { defaultSubAgentRunner } from './test-helpers.mts';
import { modelCache } from '../../src/app-state.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import {
  resetSubAgentConfigCache,
  setRuntimeSubAgentOverrides,
} from '../../src/agents/sub-agent-config.ts';
import {
  resetCapabilitiesCache,
  setProviderCapabilitiesForTests,
} from '../../src/providers/capability-probe.ts';
import {
  resetToolCallsMetaCache,
  setToolCallsMetaForTests,
} from '../../src/config/tool-calls-meta.ts';

const PROVIDER_ID = 'lm-studio-local';
const MODEL_ID = 'openai/gpt-5-preview';
const PARENT_CHAT_ID = 'parent-chat-reasoning-1';
const GEN_WORK = 'gen-reasoning-work-11111111-1111-1111-1111-111111111111';
const GEN_FINAL = 'gen-reasoning-final-22222222-2222-2222-2222-222222222222';

const STRUCTURED_JSON = JSON.stringify({
  summary: 'Done.',
  findings: [],
  artifacts: [],
});

function proseSse(text: string): Response {
  const payload = `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: null }],
  })}\n\ndata: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
  })}\n\nevent: end\ndata: ${JSON.stringify({ status: 'complete' })}\n\n`;
  return new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('sub-agent runner reasoning effort', () => {
  const originalFetch = globalThis.fetch;
  let capturedWorkBody: Record<string, unknown> | undefined;
  let generationCounter = 0;

  beforeEach(() => {
    capturedWorkBody = undefined;
    generationCounter = 0;
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides(null);
    resetCapabilitiesCache();
    resetToolCallsMetaCache();
    setToolCallsMetaForTests({ useConstrainedDecoding: false });
    setProviderCapabilitiesForTests(PROVIDER_ID, {
      schemaVersion: 1,
      probedAt: '2026-06-28T12:00:00.000Z',
      providerId: PROVIDER_ID,
      structuredOutput: false,
      structuredOutputWithTools: false,
      structuredOutputStreaming: false,
      probeError: null,
    });

    const parentChat = createEmptyChatObject(MODEL_ID);
    parentChat.id = PARENT_CHAT_ID;
    parentChat.providerId = PROVIDER_ID;
    parentChat.modelId = MODEL_ID;
    parentChat.reasoningEffort = 'high';
    setSessionStateForTests({
      version: 2,
      activeId: PARENT_CHAT_ID,
      sidebarCollapsed: false,
      chats: [parentChat],
    });

    modelCache.set(encodeModelSelectKey(PROVIDER_ID, MODEL_ID), {
      id: MODEL_ID,
      // Send-time capabilities trust the provider-advertised catalog, not cached guesses.
      reasoning: { allowed_options: ['low', 'medium', 'high'], default: 'medium' },
      capabilities: {
        vision: false,
        tools: null,
        streaming: null,
        grammar: null,
        reasoning: true,
        reasoningAllowedOptions: ['low', 'medium', 'high'],
        reasoningDefault: 'medium',
        contextLength: null,
        loadState: null,
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    modelCache.clear();
    setSessionStateForTests(null);
    resetCapabilitiesCache();
    resetToolCallsMetaCache();
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides(null);
  });

  test('sends parent chat reasoningEffort on completion body when selectable', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/api/config/ping')) {
        return Response.json({ ok: true, home: '.minnow', homeResolved: true });
      }
      if (url.includes('/api/config/meta')) {
        return Response.json({ toolCalls: { useConstrainedDecoding: false } });
      }
      if (url.includes('/api/config/sub-agents')) {
        return Response.json({});
      }
      if (url.includes('/api/providers') && !url.includes('/capabilities')) {
        return Response.json({
          providers: [
            {
              id: PROVIDER_ID,
              label: 'LM Studio',
              baseUrl: 'http://127.0.0.1:1234',
              apiKind: 'openai-v1',
              enabled: true,
              hasApiKey: false,
              hasBearer: false,
            },
          ],
          activeProviderId: PROVIDER_ID,
        });
      }
      if (url.includes('/capabilities')) {
        return Response.json({
          schemaVersion: 1,
          probedAt: '2026-06-28T12:00:00.000Z',
          providerId: PROVIDER_ID,
          structuredOutput: false,
          probeError: null,
        });
      }
      if (url.includes('/api/generations') && init?.method === 'POST' && !url.includes('/stream')) {
        generationCounter += 1;
        const payload = JSON.parse(String(init.body)) as { body?: Record<string, unknown> };
        if (generationCounter === 1) {
          capturedWorkBody = payload.body;
        }
        const genId = generationCounter === 1 ? GEN_WORK : GEN_FINAL;
        return Response.json({ generationId: genId });
      }
      if (url.includes(GEN_WORK) && url.includes('/stream')) {
        return proseSse('Working.');
      }
      if (url.includes(GEN_FINAL) && url.includes('/stream')) {
        return proseSse(STRUCTURED_JSON);
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const out = await defaultSubAgentRunner.run({
      runId: 'run-reasoning-effort',
      type: 'generalPurpose',
      task: 'Summarize',
      systemPrompt: 'You are a sub-agent.',
      tools: [],
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      parentChatId: PARENT_CHAT_ID,
      signal: AbortSignal.timeout(5000),
      executeTool: async () => ({ content: 'ok' }),
    });

    assert.ok(capturedWorkBody, 'expected work-turn generation body');
    assert.equal(capturedWorkBody.reasoning_effort, 'high');
    assert.deepEqual(capturedWorkBody.reasoning, { effort: 'high' });
    assert.match(out.summary, /Done/);
  });
});
