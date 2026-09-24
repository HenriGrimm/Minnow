/**
 * Sub-agent runner retries transient fetch errors on cloud providers (parity with main chat loop).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { defaultSubAgentRunner } from './test-helpers.mts';
import {
  resetSubAgentConfigCache,
  setRuntimeSubAgentOverrides,
} from '../../src/agents/sub-agent-config.ts';
import {
  resetCapabilitiesCache,
  setProviderCapabilitiesForTests,
  type ProviderCapabilities,
} from '../../src/providers/capability-probe.ts';
import {
  resetToolCallsMetaCache,
  setToolCallsMetaForTests,
} from '../../src/config/tool-calls-meta.ts';

const PROVIDER_ID = 'opencode-go-test';
const MODEL_ID = 'gpt-4o-mini';
const GEN_ID = 'gen-retry-11111111-1111-1111-1111-111111111111';

const CAPS: ProviderCapabilities = {
  schemaVersion: 1,
  probedAt: '2026-07-15T12:00:00.000Z',
  providerId: PROVIDER_ID,
  structuredOutput: true,
  structuredOutputWithTools: false,
  structuredOutputStreaming: false,
  probeError: null,
};

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

/** Headers and a few tokens land, then the socket dies under the reader. */
function severedSse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: text }, finish_reason: null }],
          })}\n\n`,
        ),
      );
      controller.error(
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function toolCallSse(): string {
  return [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_list',
                type: 'function',
                function: { name: 'list_directory', arguments: '{"path":"."}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    `event: end\ndata: ${JSON.stringify({ status: 'complete' })}\n\n`,
  ].join('');
}

const LIST_DIRECTORY_TOOL = {
  type: 'function' as const,
  function: {
    name: 'list_directory',
    description: 'List files',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
};

describe('sub-agent runner transient fetch retry', () => {
  const originalFetch = globalThis.fetch;
  let generationPosts = 0;
  let streamAttempts = 0;

  beforeEach(() => {
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides(null);
    resetCapabilitiesCache();
    resetToolCallsMetaCache();
    setToolCallsMetaForTests({ useConstrainedDecoding: false });
    setProviderCapabilitiesForTests(PROVIDER_ID, CAPS);
    generationPosts = 0;
    streamAttempts = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCapabilitiesCache();
    resetToolCallsMetaCache();
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides(null);
  });

  test('re-subscribes to the same generation after Failed to fetch', async () => {
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
              label: 'OpenCode Go test',
              baseUrl: 'https://opencode.ai/zen/go',
              apiKind: 'openai-v1',
              enabled: true,
              hasApiKey: true,
              hasBearer: false,
            },
          ],
          activeProviderId: PROVIDER_ID,
        });
      }
      if (url.includes('/capabilities')) {
        return Response.json(CAPS);
      }
      if (url.includes('/api/generations') && init?.method === 'POST' && !url.includes('/stream')) {
        generationPosts += 1;
        return Response.json({ generationId: GEN_ID });
      }
      if (url.includes(GEN_ID) && url.includes('/stream')) {
        streamAttempts += 1;
        if (streamAttempts === 1) {
          throw new TypeError('Failed to fetch');
        }
        return proseSse(
          '{"summary":"Done","findings":[],"artifacts":[]}',
        );
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const out = await defaultSubAgentRunner.run({
      runId: 'run-transient-retry',
      type: 'generalPurpose',
      task: 'Say hello',
      systemPrompt: 'You are a sub-agent.',
      tools: [],
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      summarySchema: 'minnow.sub-agent.v1',
      modelContextLimit: null,
      signal: AbortSignal.timeout(15_000),
      executeTool: async () => ({ content: 'ok' }),
    });

    assert.equal(streamAttempts, 2, 'should retry stream subscribe once');
    assert.equal(generationPosts, 1, 'transport reconnect should keep the backend generation');
    assert.equal(out.structuredOutcome?.summary, 'Done');
  });

  test('retries a 429 on the generation stream and keeps the run', { timeout: 15_000 }, async () => {
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
              label: 'OpenCode Go test',
              baseUrl: 'https://opencode.ai/zen/go',
              apiKind: 'openai-v1',
              enabled: true,
              hasApiKey: true,
              hasBearer: false,
            },
          ],
          activeProviderId: PROVIDER_ID,
        });
      }
      if (url.includes('/capabilities')) {
        return Response.json(CAPS);
      }
      if (url.includes('/api/generations') && init?.method === 'POST' && !url.includes('/stream')) {
        generationPosts += 1;
        return Response.json({ generationId: GEN_ID });
      }
      if (url.includes(GEN_ID) && url.includes('/stream')) {
        streamAttempts += 1;
        if (streamAttempts === 1) {
          return new Response('rate limited', { status: 429 });
        }
        return proseSse('{"summary":"Done after 429","findings":[],"artifacts":[]}');
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const out = await defaultSubAgentRunner.run({
      runId: 'run-http-429-retry',
      type: 'generalPurpose',
      task: 'Say hello',
      systemPrompt: 'You are a sub-agent.',
      tools: [],
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      summarySchema: 'minnow.sub-agent.v1',
      modelContextLimit: null,
      signal: AbortSignal.timeout(15_000),
      executeTool: async () => ({ content: 'ok' }),
    });

    assert.equal(streamAttempts, 2, 'should retry the 429');
    assert.equal(out.structuredOutcome?.summary, 'Done after 429');
  });

  test('fails the turn when a later work turn hits a persistent 502', { timeout: 15_000 }, async () => {
    const genTool = 'gen-tool-retry-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const genFail = 'gen-fail-retry-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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
              label: 'OpenCode Go test',
              baseUrl: 'https://opencode.ai/zen/go',
              apiKind: 'openai-v1',
              enabled: true,
              hasApiKey: true,
              hasBearer: false,
            },
          ],
          activeProviderId: PROVIDER_ID,
        });
      }
      if (url.includes('/capabilities')) {
        return Response.json(CAPS);
      }
      if (url.includes('/api/generations') && init?.method === 'POST' && !url.includes('/stream')) {
        generationPosts += 1;
        const generationId = generationPosts === 1 ? genTool : genFail;
        return Response.json({ generationId });
      }
      if (url.includes(genTool) && url.includes('/stream')) {
        return new Response(toolCallSse(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (url.includes(genFail) && url.includes('/stream')) {
        streamAttempts += 1;
        return new Response('bad gateway', { status: 502 });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    /** @see run-turn: the store is fed from here, so a thrown round keeps its transcript. */
    let lastMessages: Array<Record<string, unknown>> = [];

    await assert.rejects(
      () =>
        defaultSubAgentRunner.run({
          runId: 'run-http-502-partial',
          type: 'explore',
          task: 'Explore then continue',
          systemPrompt: 'You are a sub-agent.',
          tools: [LIST_DIRECTORY_TOOL],
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          summarySchema: 'minnow.sub-agent.v1',
          modelContextLimit: null,
          signal: AbortSignal.timeout(15_000),
          executeTool: async () => ({ content: 'README.md' }),
          onMessagesChange: (messages: Array<Record<string, unknown>>) => {
            lastMessages = messages;
          },
        }),
      /HTTP 502/,
      'a dead round must fail the turn, never resolve as a quiet outcome',
    );

    assert.ok(streamAttempts >= 3, 'persistent 502 should exhaust backoff retries');
    assert.ok(
      lastMessages.some((m) => m.role === 'assistant' && 'tool_calls' in m),
      'prior tool turn must remain on the transcript',
    );
  });

  test('retries a mid-stream socket reset and completes the round', { timeout: 15_000 }, async () => {
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
              label: 'OpenCode Go test',
              baseUrl: 'https://opencode.ai/zen/go',
              apiKind: 'openai-v1',
              enabled: true,
              hasApiKey: true,
              hasBearer: false,
            },
          ],
          activeProviderId: PROVIDER_ID,
        });
      }
      if (url.includes('/capabilities')) {
        return Response.json(CAPS);
      }
      if (url.includes('/api/generations') && init?.method === 'POST' && !url.includes('/stream')) {
        generationPosts += 1;
        return Response.json({ generationId: GEN_ID });
      }
      if (url.includes(GEN_ID) && url.includes('/stream')) {
        streamAttempts += 1;
        // Headers arrive, some tokens land, then the socket dies: the case the
        // pre-stream `Failed to fetch` retry never covered. Two deaths, because
        // the generations transport absorbs the first with its own single
        // reconnect — only the second escapes to the runner.
        if (streamAttempts <= 2) return severedSse('Half a th');
        return proseSse('{"summary":"Recovered","findings":[],"artifacts":[]}');
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const restarts: string[] = [];
    const out = await defaultSubAgentRunner.run({
      runId: 'run-mid-stream-reset',
      type: 'generalPurpose',
      task: 'Say hello',
      systemPrompt: 'You are a sub-agent.',
      tools: [],
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      summarySchema: 'minnow.sub-agent.v1',
      modelContextLimit: null,
      signal: AbortSignal.timeout(15_000),
      executeTool: async () => ({ content: 'ok' }),
      onTurnEvent: (event: { type: string; warning?: string }) => {
        if (event.type === 'response_restart') restarts.push(event.warning ?? '');
      },
    });

    assert.equal(streamAttempts, 3, 'the runner replays the round the transport gave up on');
    assert.equal(out.structuredOutcome?.summary, 'Recovered');
    assert.equal(restarts.length, 1, 'consumers must be told to drop the dead attempt');
    assert.match(restarts[0], /retrying/i);
  });
});
