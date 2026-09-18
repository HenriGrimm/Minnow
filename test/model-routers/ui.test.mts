import '../tools/install-dom-before-imports.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveRouterConfig, routerOptions } from '../../src/models/routers.ts';
import { readDefaultModelBinding, applyDefaultModelToChat, resolveEffectiveChatModelBinding } from '../../src/ui/default-model.ts';
import { createChatTurnEventPainter } from '../../src/chat/run-turn-chat-paint.ts';

test('router is a distinct picker option and default changes do not mutate existing chat bindings', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => new Response(String(init?.body), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const config = { revision: 0, defaultRouterId: 'router', routers: [{ id: 'router', name: 'Build', policy: 'priority' as const, enabled: true, entries: [] }] };
    await saveRouterConfig(config);
    const select = document.createElement('select'); select.id = 'modelSelect'; document.body.append(select);
    routerOptions(select, config);
    assert.equal(select.options[0].text, 'Build — Model pool');
    assert.equal(select.options[0].value, 'minnow-router\u001frouter');
    const existing = { providerId: 'original-provider', modelId: 'original-model' };
    const fresh = { providerId: '', modelId: '' }; applyDefaultModelToChat(fresh);
    assert.deepEqual(fresh, { providerId: 'minnow-router', modelId: 'router' });
    assert.deepEqual(readDefaultModelBinding(), fresh);
    assert.equal(resolveEffectiveChatModelBinding(existing).modelId, 'original-model');
    assert.equal(existing.providerId, 'original-provider');
    select.remove();
    await saveRouterConfig({ revision: 0, defaultRouterId: null, routers: [] });
  } finally { globalThis.fetch = original; }
});
test('restart clears pending paints and reasoning and leaves a visible warning', () => {
  const wrap = document.createElement('div'); const bubble = document.createElement('div'); const cursor = document.createElement('span');
  wrap.append(bubble); document.body.append(wrap); let reset = false; const ticks: (() => void)[] = [];
  const painter = createChatTurnEventPainter({ wrap, bubble, cursor, mount: wrap, revealProse: () => {}, thoughtController: { appendReasoningDelta: () => {}, resetFailedResponse: () => { reset = true; } }, schedulePaintTick: (fn) => ticks.push(fn), scheduleMarkdown: (el, text) => { el.textContent = text; } });
  painter.onEvent({ type: 'delta', text: 'failed text' });
  painter.onEvent({ type: 'thinking', text: 'failed reasoning' });
  painter.onEvent({ type: 'response_restart', warning: 'Response restarted on backup' });
  painter.onEvent({ type: 'delta', text: 'replacement' });
  ticks.forEach((tick) => tick());
  assert.equal(bubble.textContent, 'replacement'); assert.equal(reset, true);
  assert.equal(wrap.querySelector('[role=status]')?.textContent, 'Response restarted on backup');
  assert.doesNotMatch(wrap.textContent || '', /failed/); wrap.remove();
});

test('remapRouterEntriesToLibrary rewrites llama-cpp-local onto My Models ids', async () => {
  const { remapRouterEntriesToLibrary, routerEntryProviderLabel } = await import('../../src/models/routers.ts');
  const entries = [
    { id: 'e1', providerId: 'llama-cpp-local', modelId: 'Qwen3-8B', enabled: true, concurrencyLimit: 1 },
  ];
  const library = [{
    id: 'gguf:qwen/qwen3:file.gguf',
    name: 'Qwen3-8B',
    repoId: 'qwen/qwen3',
    publisher: 'qwen',
    producerSlug: 'qwen',
    producerName: 'Qwen',
    producerLogoId: 'Qwen3-8B',
    format: 'GGUF' as const,
    quant: 'Q4',
    arch: 'qwen',
    domain: 'chat',
    paramsB: 8,
    contextLength: 32768,
    capabilities: [],
    sizeBytes: 1000,
    path: '/tmp/file.gguf',
    fileName: 'file.gguf',
    source: 'hf-cache' as const,
    servable: true,
    incomplete: false,
    isMoe: false,
  }];
  assert.equal(remapRouterEntriesToLibrary(entries, library), true);
  assert.equal(entries[0].providerId, 'minnow-library');
  assert.equal(entries[0].modelId, 'gguf:qwen/qwen3:file.gguf');
  assert.equal(routerEntryProviderLabel(entries[0], []), 'My Models');
});
