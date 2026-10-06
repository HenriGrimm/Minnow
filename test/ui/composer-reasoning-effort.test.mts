/**
 * Composer reasoning effort dropdown and thinking toggle visibility.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');

const { setSessionStateForTests, createEmptyChatObject, flushScheduledSessionSaveForTests } =
  await import('../../src/state/sessions.ts');
const { modelCache } = await import('../../src/app-state.ts');
const { encodeModelSelectKey } = await import('../../src/lib/model-select-key.ts');
const { enrichModelsFromModelsDev, resetModelsDevContextCacheForTests } =
  await import('../../server/providers/models-dev-context.js');
const { reasoningEffortToCompletionBody } = await import('../../src/agents/thinking-to-body.ts');
const { resolveSendCapabilities } = await import('../../src/providers/model-capabilities.ts');
const { catalogCapabilitiesFromRow } = await import('../../src/providers/model-capabilities.ts');
const { cursorReasoningForModels, resolveCursorVariantId } =
  await import('../../src/models/cursor-variants.mjs');
const { initThinkingControl } = await import('../../src/ui/composer-thinking.ts');
const { initComposerModelTriggers, teardownComposerModelTriggers } = await import('../../src/ui/composer-model-trigger.ts');
const {
  initComposerReasoningEffort,
  syncComposerReasoningEffortFromActiveChat,
} = await import('../../src/ui/composer-reasoning-effort.ts');

function setupDom(): Window {
  const win = new Window();
  globalThis.document = win.document as unknown as Document;
  globalThis.window = win as unknown as Window & typeof globalThis.window;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event as typeof Event;

  document.body.innerHTML = `
    <div id="composerThinkingWrap" class="composer-control thinking-control-wrap hidden">
      <div id="composerThinkingControl" class="thinking-toggle-host"></div>
      <div id="composerReasoningEffortWrap" class="composer-reasoning-effort-wrap hidden">
        <select id="composerReasoningEffortSelect" class="composer-reasoning-effort-select" disabled></select>
        <div id="composerReasoningEffortSegments" class="composer-reasoning-effort-segments" role="radiogroup" aria-label="Reasoning effort"></div>
      </div>
    </div>
  `;
  return win;
}

function teardownDom(): void {
  teardownComposerModelTriggers();
  flushScheduledSessionSaveForTests();
  modelCache.clear();
  setSessionStateForTests(null);
}

function seedChat(overrides: Record<string, unknown> = {}) {
  const chat = createEmptyChatObject('gpt-5-preview');
  chat.id = 'chat-reasoning-1';
  chat.providerId = 'openai';
  chat.modelId = 'gpt-5-preview';
  Object.assign(chat, overrides);
  setSessionStateForTests({
    version: 2,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  return chat;
}

test('OpenCode catalog efforts reach the composer and request without losing Muse or DeepSeek levels', async () => {
  const originalFetch = globalThis.fetch;
  const entries = [
    { id: 'deepseek-v4.1-flash', values: ['low', 'high', 'max'] },
    { id: 'muse-spark-1.3-contributor', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  ];
  globalThis.fetch = async () => ({ ok: true, async json() { return {
    'opencode-go': { api: 'https://opencode.ai/zen/go/v1', models: Object.fromEntries(
      entries.map(({ id, values }) => [id, { reasoning: true, reasoning_options: [{ type: 'effort', values }] }]),
    ) },
  }; } }) as Response;
  resetModelsDevContextCacheForTests();
  try {
    const catalog = await enrichModelsFromModelsDev('https://opencode.ai/zen/go', {
      data: entries.map(({ id }) => ({ id, max_context_length: 262144 })),
    });
    for (const [index, { id, values }] of entries.entries()) {
      setupDom();
      const chat = seedChat({ providerId: 'opencode-go', modelId: id, reasoningEffort: 'off' });
      modelCache.set(encodeModelSelectKey('opencode-go', id), catalog.data[index]);
      initThinkingControl();
      initComposerReasoningEffort();
      syncComposerReasoningEffortFromActiveChat();
      const select = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement;
      assert.deepEqual([...select.options].map((option) => option.value), values);
      assert.ok(!document.getElementById('composerReasoningEffortWrap')?.classList.contains('hidden'));
      for (const value of values) {
        select.value = value;
        select.dispatchEvent(new Event('change'));
        assert.equal(chat.reasoningEffort, value);
        const patch = reasoningEffortToCompletionBody(chat.reasoningEffort!, 'openai-v1',
          resolveSendCapabilities('opencode-go', id, 'openai-v1'), undefined, id);
        assert.equal(patch.body.reasoning_effort, value);
      }
      teardownDom();
    }
  } finally {
    globalThis.fetch = originalFetch;
    resetModelsDevContextCacheForTests();
    teardownDom();
  }
});

describe('composer reasoning effort HTML', () => {
  test('index.html defines composer reasoning effort wrap and select', () => {
    assert.match(indexHtml, /id="composerReasoningEffortWrap"/);
    assert.match(indexHtml, /id="composerReasoningEffortSelect"/);
    assert.match(indexHtml, /id="composerReasoningEffortSegments"/);
    assert.match(indexHtml, /composer-reasoning-effort-wrap/);
  });
});

describe('syncComposerReasoningEffortFromActiveChat', () => {
  afterEach(() => {
    teardownDom();
  });

  test('Cursor uses the composer reasoning control and a per-chat Fast toggle', () => {
    setupDom();
    const ids = ['claude-opus-5-5-low', 'claude-opus-5-5-medium',
      'claude-opus-5-5-medium-fast', 'claude-opus-5-5-high', 'claude-opus-5-5-high-fast'];
    const rows = cursorReasoningForModels(ids.map(id => ({ id, api: 'agent-cli-v1' as const, state: 'loaded' })));
    for (const row of rows) {
      modelCache.set(encodeModelSelectKey('cursor-agent-cli', row.id), {
        ...row, capabilities: catalogCapabilitiesFromRow(row, 'agent-cli-v1'),
      });
    }
    const chat = seedChat({ providerId: 'cursor-agent-cli', modelId: 'claude-opus-5-5-medium' });
    const models = document.createElement('select');
    models.id = 'modelSelect';
    for (const id of ids) {
      const option = document.createElement('option');
      option.value = encodeModelSelectKey('cursor-agent-cli', id);
      option.textContent = `${id} — Cursor Agent`;
      models.append(option);
    }
    const anchor = document.createElement('div');
    anchor.id = 'desktopComposerModelAnchor';
    document.body.append(models, anchor);
    initComposerModelTriggers();
    initThinkingControl();
    initComposerReasoningEffort();
    const select = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement;
    assert.deepEqual([...select.options].map(option => option.value), ['low', 'medium', 'high']);
    const fast = document.querySelector<HTMLButtonElement>('.composer-cursor-fast-btn')!;
    assert.equal(fast.classList.contains('hidden'), false);
    fast.click();
    assert.equal(chat.cursorFast, true);
    assert.equal(chat.modelId, 'claude-opus-5-5-medium-fast');
    assert.equal(fast.getAttribute('role'), 'switch');
    assert.equal(fast.getAttribute('aria-checked'), 'true');
    select.value = 'high';
    select.dispatchEvent(new Event('change'));
    assert.equal(chat.reasoningEffort, 'high');
    assert.equal(chat.modelId, 'claude-opus-5-5-high-fast');
    assert.equal(anchor.querySelector('.composer-model-trigger__label')?.textContent,
      'claude-opus-5-5-high-fast — Cursor Agent');
    assert.equal(resolveCursorVariantId(chat.modelId, ids, {
      effort: chat.reasoningEffort, fast: chat.cursorFast,
    }), 'claude-opus-5-5-high-fast');
    fast.click();
    assert.equal(chat.modelId, 'claude-opus-5-5-high');
    assert.equal(fast.getAttribute('aria-checked'), 'false');
    fast.click();
    select.value = 'low';
    select.dispatchEvent(new Event('change'));
    assert.equal(chat.modelId, 'claude-opus-5-5-low');
    assert.equal(fast.disabled, true);
    assert.equal(fast.classList.contains('hidden'), false);
    assert.equal(fast.getAttribute('aria-checked'), 'false');
    select.value = 'high';
    select.dispatchEvent(new Event('change'));
    assert.equal(chat.modelId, 'claude-opus-5-5-high-fast');
    assert.equal(fast.disabled, false);

    // A saved chat from before the fix can have a stale Medium binding.
    chat.modelId = 'claude-opus-5-5-medium';
    syncComposerReasoningEffortFromActiveChat();
    assert.equal(chat.modelId, 'claude-opus-5-5-high-fast');
  });

  test('Cursor Fast remains available when a family has no reasoning levels', () => {
    setupDom();
    const ids = ['composer-2.5', 'composer-2.5-fast'];
    for (const id of ids) {
      modelCache.set(encodeModelSelectKey('cursor-agent-cli', id), {
        id, api: 'agent-cli-v1', state: 'loaded', reasoning: { allowed_options: [], default: 'off' },
      });
    }
    const chat = seedChat({ providerId: 'cursor-agent-cli', modelId: ids[0] });
    initThinkingControl();
    initComposerReasoningEffort();
    assert.equal(document.getElementById('composerThinkingWrap')?.classList.contains('hidden'), true);
    const fast = document.querySelector<HTMLButtonElement>('.composer-cursor-fast-btn')!;
    assert.equal(fast.classList.contains('hidden'), false);
    fast.click();
    assert.equal(chat.cursorFast, true);
    assert.equal(chat.modelId, ids[1]);
    assert.equal(resolveCursorVariantId(chat.modelId, ids, { fast: chat.cursorFast }), ids[1]);
  });

  test('shows brain only for off/on models (no Off/On select)', () => {
    setupDom();
    seedChat({ providerId: 'openai', modelId: 'kimi-k2' });

    modelCache.set(encodeModelSelectKey('openai', 'kimi-k2'), {
      id: 'kimi-k2',
      capabilities: {
        vision: false,
        tools: null,
        streaming: null,
        grammar: null,
        reasoning: true,
        reasoningAllowedOptions: ['off', 'on'],
        contextLength: null,
        loadState: null,
      },
    });

    initThinkingControl();
    initComposerReasoningEffort();
    syncComposerReasoningEffortFromActiveChat();

    const thinkingWrap = document.getElementById('composerThinkingWrap');
    const dropdownWrap = document.getElementById('composerReasoningEffortWrap');
    const thinkingControl = document.getElementById('composerThinkingControl');
    const select = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement;

    assert.ok(!thinkingWrap?.classList.contains('hidden'));
    assert.ok(dropdownWrap?.classList.contains('hidden'));
    assert.equal(select.options.length, 0);
    assert.ok(!thinkingControl?.classList.contains('hidden'));
  });

  test('shows brain and level dropdown when low/medium/high exist and reasoning is on', () => {
    const win = setupDom();
    const chat = seedChat();

    modelCache.set(encodeModelSelectKey('openai', 'gpt-5-preview'), {
      id: 'gpt-5-preview',
      reasoning: { allowed_options: ['off', 'low', 'medium', 'high'], default: 'medium' },
      capabilities: {
        vision: false,
        tools: null,
        streaming: null,
        grammar: null,
        reasoning: true,
        reasoningAllowedOptions: ['off', 'low', 'medium', 'high'],
        reasoningDefault: 'medium',
        contextLength: null,
        loadState: null,
      },
    });

    initThinkingControl();
    initComposerReasoningEffort();
    syncComposerReasoningEffortFromActiveChat();

    const dropdownWrap = document.getElementById('composerReasoningEffortWrap');
    const select = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement;
    const thinkingControl = document.getElementById('composerThinkingControl');
    const brainBtn = thinkingControl?.querySelector('.thinking-toggle-btn') as HTMLButtonElement;

    assert.ok(!dropdownWrap?.classList.contains('hidden'));
    assert.equal(select.options.length, 3);
    assert.equal(select.value, 'medium');
    const segments = document.querySelectorAll('.composer-reasoning-effort-segment');
    assert.equal(segments.length, 3);
    assert.equal(segments[1]?.getAttribute('aria-checked'), 'true');
    assert.ok(!thinkingControl?.classList.contains('hidden'));
    assert.equal(brainBtn?.getAttribute('aria-pressed'), 'true');

    select.value = 'high';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));

    assert.equal(chat.reasoningEffort, 'high');
  });

  test('the footer trigger opens a themed menu that drives the hidden select', () => {
    setupDom();
    const chat = seedChat();
    modelCache.set(encodeModelSelectKey('openai', 'gpt-5-preview'), {
      id: 'gpt-5-preview',
      reasoning: { allowed_options: ['off', 'low', 'medium', 'high'], default: 'medium' },
      capabilities: {
        vision: false,
        tools: null,
        streaming: null,
        grammar: null,
        reasoning: true,
        reasoningAllowedOptions: ['off', 'low', 'medium', 'high'],
        reasoningDefault: 'medium',
        contextLength: null,
        loadState: null,
      },
    });
    initThinkingControl();
    initComposerReasoningEffort();
    syncComposerReasoningEffortFromActiveChat();

    const trigger = document.getElementById('composerReasoningEffortBtn') as HTMLButtonElement;
    const menu = document.getElementById('composerReasoningEffortMenu') as HTMLElement;
    assert.ok(trigger && menu, 'trigger and menu mount');
    assert.equal(trigger.textContent, 'Medium');
    assert.ok(menu.classList.contains('hidden'));

    trigger.click();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[];
    assert.deepEqual(items.map((item) => item.textContent), ['Low', 'Medium', 'High']);
    assert.equal(items[1]?.getAttribute('aria-checked'), 'true');

    items[0]?.click();
    assert.ok(menu.classList.contains('hidden'));
    assert.equal(chat.reasoningEffort, 'low');
    assert.equal(trigger.textContent, 'Low');
  });

  test('brain off hides dropdown and sets reasoningEffort to off', () => {
    setupDom();
    const chat = seedChat({ reasoningEffort: 'medium' });

    modelCache.set(encodeModelSelectKey('openai', 'gpt-5-preview'), {
      id: 'gpt-5-preview',
      reasoning: { allowed_options: ['off', 'low', 'medium', 'high'], default: 'medium' },
      capabilities: {
        vision: false,
        tools: null,
        streaming: null,
        grammar: null,
        reasoning: true,
        reasoningAllowedOptions: ['off', 'low', 'medium', 'high'],
        reasoningDefault: 'medium',
        contextLength: null,
        loadState: null,
      },
    });

    initThinkingControl();
    initComposerReasoningEffort();
    syncComposerReasoningEffortFromActiveChat();

    const brainBtn = document.querySelector('.thinking-toggle-btn') as HTMLButtonElement;
    brainBtn.click();

    const dropdownWrap = document.getElementById('composerReasoningEffortWrap');
    assert.equal(chat.reasoningEffort, 'off');
    assert.ok(dropdownWrap?.classList.contains('hidden'));
    assert.equal(brainBtn.getAttribute('aria-pressed'), 'false');
  });

  test('brain on restores default level and shows dropdown again', () => {
    setupDom();
    const chat = seedChat({ reasoningEffort: 'off' });

    modelCache.set(encodeModelSelectKey('openai', 'gpt-5-preview'), {
      id: 'gpt-5-preview',
      reasoning: { allowed_options: ['off', 'low', 'medium', 'high'], default: 'medium' },
      capabilities: {
        vision: false,
        tools: null,
        streaming: null,
        grammar: null,
        reasoning: true,
        reasoningAllowedOptions: ['off', 'low', 'medium', 'high'],
        reasoningDefault: 'medium',
        contextLength: null,
        loadState: null,
      },
    });

    initThinkingControl();
    initComposerReasoningEffort();
    syncComposerReasoningEffortFromActiveChat();

    const brainBtn = document.querySelector('.thinking-toggle-btn') as HTMLButtonElement;
    brainBtn.click();

    const dropdownWrap = document.getElementById('composerReasoningEffortWrap');
    const select = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement;

    assert.equal(chat.reasoningEffort, 'medium');
    assert.ok(!dropdownWrap?.classList.contains('hidden'));
    assert.equal(select.value, 'medium');
    assert.equal(brainBtn.getAttribute('aria-pressed'), 'true');
  });

  test('shows brain and level dropdown for Qwen3.8 My Models rows without catalog caps', () => {
    setupDom();
    seedChat({
      providerId: 'minnow-library',
      modelId: 'gguf:unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q4_K_M.gguf',
    });

    modelCache.set(
      encodeModelSelectKey(
        'minnow-library',
        'gguf:unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q4_K_M.gguf',
      ),
      {
        id: 'gguf:unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q4_K_M.gguf',
        type: 'llm',
      },
    );

    initThinkingControl();
    initComposerReasoningEffort();
    syncComposerReasoningEffortFromActiveChat();

    const dropdownWrap = document.getElementById('composerReasoningEffortWrap');
    const select = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement;
    const thinkingControl = document.getElementById('composerThinkingControl');

    assert.ok(!dropdownWrap?.classList.contains('hidden'));
    assert.equal(select.options.length, 3);
    assert.equal(select.value, 'high');
    assert.ok(!thinkingControl?.classList.contains('hidden'));
  });

  test('GLM-5.3 shows Low/High/Max only, hides the brain Off toggle, defaults to Max', () => {
    setupDom();
    const chat = seedChat({
      providerId: 'zai',
      modelId: 'glm-5.3-flash',
      reasoningEffort: 'off',
    });

    modelCache.set(encodeModelSelectKey('zai', 'glm-5.3-flash'), {
      id: 'glm-5.3-flash',
      type: 'llm',
    });

    initThinkingControl();
    initComposerReasoningEffort();
    syncComposerReasoningEffortFromActiveChat();

    const dropdownWrap = document.getElementById('composerReasoningEffortWrap');
    const select = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement;
    const thinkingControl = document.getElementById('composerThinkingControl');
    const thinkingWrap = document.getElementById('composerThinkingWrap');

    assert.ok(!thinkingWrap?.classList.contains('hidden'));
    assert.ok(!dropdownWrap?.classList.contains('hidden'));
    assert.equal(select.options.length, 3);
    assert.deepEqual(
      [...select.options].map((o) => o.value),
      ['low', 'high', 'max'],
    );
    assert.equal(select.value, 'max');
    assert.ok(thinkingControl?.classList.contains('hidden'));
    assert.equal(chat.reasoningEffort, undefined);
  });

  test('GLM-5.3 clears stored medium and shows Max', () => {
    setupDom();
    const chat = seedChat({
      providerId: 'zai',
      modelId: 'z-ai/glm-5.3-flash',
      reasoningEffort: 'medium',
    });

    modelCache.set(encodeModelSelectKey('zai', 'z-ai/glm-5.3-flash'), {
      id: 'z-ai/glm-5.3-flash',
      type: 'llm',
    });

    initThinkingControl();
    initComposerReasoningEffort();
    syncComposerReasoningEffortFromActiveChat();

    const select = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement;
    assert.equal(chat.reasoningEffort, undefined);
    assert.equal(select.value, 'max');
  });
});
