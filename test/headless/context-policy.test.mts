import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { resetSubAgentConfigCache } from '../../src/agents/sub-agent-config.ts';
import { resetWorkAgentRegistry } from '../../src/agents/work-agent-registry.ts';
import { resolveChatContextBudget } from '../../src/chat/context/chat-context-budget.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { resolveHeadlessContextLimits } from '../../src/headless/context-policy.ts';
import { installHeadlessLocalStorage } from '../../src/headless/server-context.ts';
import type { Chat } from '../../src/types';

const chat = { id: 'reef-context', modelId: 'custom/model', providerId: 'custom-cloud', modeId: 'build' } as Chat;
const settings = {
  defaultContextEnforcementPolicy: 'compact',
  defaultContextCompaction: { workingContextTokens: 0, highWater: 0.65, lowWater: 0.35, minRecentTurns: 4 },
};

beforeEach(() => {
  installHeadlessLocalStorage();
  setStorageModeForTests('server');
  resetSubAgentConfigCache();
  resetWorkAgentRegistry();
});
afterEach(() => {
  resetSubAgentConfigCache();
  resetWorkAgentRegistry();
  setStorageModeForTests(null);
});

test('headless loads saved chat compaction settings and the provider-scoped live model window', async t => {
  const requests: string[] = [];
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    requests.push(input);
    if (input === '/api/config/sub-agents') return Response.json(settings);
    assert.equal(init?.signal, controller.signal);
    return Response.json({ contextLength: 131072 });
  });
  const limits = await resolveHeadlessContextLimits(chat, controller.signal);
  assert.deepEqual(requests, ['/api/config/sub-agents', '/api/providers/custom-cloud/context-window?modelId=custom%2Fmodel']);
  assert.equal(limits.modelContextLimit, 131072);
  assert.deepEqual(limits.contextBudget, resolveChatContextBudget(chat));
  assert.deepEqual(limits.contextBudget, { enforcementPolicy: 'compact', workingContextTokens: 0, highWater: 0.65, lowWater: 0.35, minRecentTurns: 4 });
});

test('unknown model windows remain uncapped instead of falling back to 32K', async t => {
  t.mock.method(globalThis, 'fetch', async (input: string) => Response.json(
    input === '/api/config/sub-agents' ? { defaultContextEnforcementPolicy: 'slide' } : { contextLength: null },
  ));
  const limits = await resolveHeadlessContextLimits(chat, new AbortController().signal);
  assert.equal(limits.modelContextLimit, null);
  assert.equal((limits.contextBudget as { workingContextTokens?: number }).workingContextTokens, undefined);
  assert.deepEqual(limits.contextBudget, resolveChatContextBudget(chat));
});

test('unavailable model metadata retains the same known-model window as regular chat', async t => {
  t.mock.method(globalThis, 'fetch', async (input: string) => input === '/api/config/sub-agents'
    ? Response.json(settings) : new Response('Unavailable', { status: 503 }));
  const limits = await resolveHeadlessContextLimits({ ...chat, modelId: 'deepseek-v4.1-flash' }, new AbortController().signal);
  assert.equal(limits.modelContextLimit, 1_000_000);
});

test('cancellation during window lookup stops the build', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    if (input === '/api/config/sub-agents') return Response.json(settings);
    controller.abort(new Error('Build cancelled'));
    controller.signal.throwIfAborted();
  });
  await assert.rejects(resolveHeadlessContextLimits(chat, controller.signal), /Build cancelled/);
});
