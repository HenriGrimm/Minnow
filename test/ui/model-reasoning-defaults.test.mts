import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';

import { modelCache } from '../../src/app-state.ts';
import {
  getModelReasoningDefault,
  resetModelReasoningDefaultsForTests,
} from '../../src/config/model-reasoning-defaults.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import type { ReasoningEffortOption } from '../../src/types.ts';
import { applyModelReasoningDefaultToChat } from '../../src/ui/default-model.ts';
import { mountModelMenuActions } from '../../src/ui/model-select-picker.ts';
import { teardownHappyDomAsync } from '../os/dom-helpers.mts';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: window.localStorage,
});

after(async () => teardownHappyDomAsync(window));

describe('model reasoning defaults', { concurrency: false }, () => {
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    modelCache.clear();
    resetModelReasoningDefaultsForTests();
    setStorageModeForTests(null);
  });

  test('picker footer appears for level-capable models and persists a selection', async () => {
    setStorageModeForTests('browser');
    const key = encodeModelSelectKey('openai', 'gpt-5');
    modelCache.set(key, {
      id: 'gpt-5',
      capabilities: {
        reasoning: true,
        reasoningAllowedOptions: ['off', 'low', 'medium', 'high'],
        reasoningDefault: 'medium',
      },
    });

    const host = document.createElement('div');
    const modelSelect = document.createElement('select');
    modelSelect.id = 'modelSelect';
    const modelOption = document.createElement('option');
    modelOption.value = key;
    modelOption.textContent = 'GPT-5';
    modelSelect.appendChild(modelOption);
    document.body.append(modelSelect, host);
    let changed: string | null = null;
    mountModelMenuActions(host, {
      resolveSelectValue: () => key,
      onReasoningDefaultChange: (_value, effort) => {
        changed = effort;
      },
    });

    const wrap = host.querySelector<HTMLElement>('.model-menu-reasoning-default');
    const select = host.querySelector<HTMLSelectElement>('.model-menu-reasoning-default__select');
    assert.equal(wrap?.hidden, false);
    assert.deepEqual(
      [...(select?.options ?? [])].map((option) => option.textContent),
      ['Model default (Medium)', 'Low', 'Medium', 'High'],
    );

    select!.value = 'high';
    select!.dispatchEvent(new window.Event('change', { bubbles: true }));
    await Promise.resolve();

    assert.equal(changed, 'high');
    assert.equal(getModelReasoningDefault(key), 'high');
    const chat: { modelId: string; reasoningEffort?: ReasoningEffortOption } = {
      modelId: 'gpt-5',
    };
    applyModelReasoningDefaultToChat(chat, key);
    assert.equal(chat.reasoningEffort, 'high');
  });

  test('picker footer stays hidden when a model has no reasoning levels', () => {
    setStorageModeForTests('browser');
    const key = encodeModelSelectKey('openai', 'binary-thinker');
    modelCache.set(key, {
      id: 'binary-thinker',
      capabilities: {
        reasoning: true,
        reasoningAllowedOptions: ['off', 'on'],
      },
    });

    const host = document.createElement('div');
    const modelSelect = document.createElement('select');
    modelSelect.id = 'modelSelect';
    const modelOption = document.createElement('option');
    modelOption.value = key;
    modelOption.textContent = 'Binary thinker';
    modelSelect.appendChild(modelOption);
    document.body.append(modelSelect, host);
    mountModelMenuActions(host, { resolveSelectValue: () => key });

    assert.equal(
      host.querySelector<HTMLElement>('.model-menu-reasoning-default')?.hidden,
      true,
    );
  });
});
