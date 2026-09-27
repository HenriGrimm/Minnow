import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import type { ModelFitCandidate } from '../../src/models/model-fit.ts';
import { renderModelFitPanel } from '../../src/ui/model-fit-recommendations.ts';

function installDom(): Window {
  const window = new Window();
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  return window;
}

function fitCandidate(
  key: string,
  tools: boolean | null,
  extra: Partial<ModelFitCandidate> = {},
): ModelFitCandidate {
  return {
    key,
    providerId: 'provider',
    modelId: key,
    label: key,
    local: true,
    loaded: false,
    capabilities: {
      vision: null,
      tools,
      reasoning: null,
      contextLength: 32_768,
      sources: { tools: 'probe' },
    },
    ...extra,
  };
}

test('model fit panel warns without replacing an incompatible current choice', () => {
  installDom();
  const mount = document.createElement('div');
  const applied: string[] = [];
  renderModelFitPanel(
    mount,
    [fitCandidate('capable', true), fitCandidate('failed', false)],
    { selectedKey: 'failed', onApply: (candidate) => applied.push(candidate.key) },
  );

  const warning = mount.querySelector('.settings-model-fit__selected') as HTMLElement;
  assert.equal(warning.getAttribute('role'), 'alert');
  assert.match(warning.textContent ?? '', /failed its capability probe/);
  assert.match(warning.textContent ?? '', /Minnow will keep your choice/);
  assert.deepEqual(applied, []);

  const useButton = [...mount.querySelectorAll('button')].find(
    (button) => button.textContent === 'Use for main chat',
  ) as HTMLButtonElement;
  useButton.click();
  assert.deepEqual(applied, ['capable']);
  assert.match(mount.querySelector('.settings-model-fit__selected')?.textContent ?? '', /compatible/);
});

test('model fit panel changes profile and reports an unverified requirement', () => {
  const window = installDom();
  const mount = document.createElement('div');
  renderModelFitPanel(mount, [fitCandidate('model', true)], {
    selectedKey: 'model',
    onApply: () => {},
  });

  const select = mount.querySelector('#modelFitProfile') as HTMLSelectElement;
  select.value = 'vision-ui';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.match(
    mount.querySelector('.settings-model-fit__selected')?.textContent ?? '',
    /Vision has not been verified/,
  );
  assert.equal(mount.querySelector('.settings-model-fit__selected')?.getAttribute('role'), null);
});
