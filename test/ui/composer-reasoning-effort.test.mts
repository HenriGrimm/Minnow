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
const { initThinkingControl } = await import('../../src/ui/composer-thinking.ts');
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

  test('brain off hides dropdown and sets reasoningEffort to off', () => {
    setupDom();
    const chat = seedChat({ reasoningEffort: 'medium' });

    modelCache.set(encodeModelSelectKey('openai', 'gpt-5-preview'), {
      id: 'gpt-5-preview',
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
