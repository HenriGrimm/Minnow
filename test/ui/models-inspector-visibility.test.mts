import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('models inspector visibility', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;

    document.body.innerHTML = `
      <main id="modelsView" class="models-page is-inspector-hidden">
        <button id="btnModelsInspector" type="button" aria-expanded="false"></button>
      </main>
    `;
  });

  afterEach(() => {
    document.documentElement.classList.remove('mn-graphite-apps');
    document.body.innerHTML = '';
  });

  test('setModelsInspectorOpen reveals the panel and persists preference', async () => {
    const { isModelsInspectorOpen, setModelsInspectorOpen } = await import(
      '../../src/ui/models/inspector-visibility.ts'
    );

    assert.equal(isModelsInspectorOpen(), false);
    setModelsInspectorOpen(true);
    assert.equal(isModelsInspectorOpen(), true);
    assert.equal(document.getElementById('btnModelsInspector')?.getAttribute('aria-expanded'), 'true');
    assert.equal(localStorage.getItem('minnow.models.inspector'), '1');
  });

  test('Local Server highlights the toggle only while its inspector is visible', async () => {
    const { setModelsInspectorOpen, syncModelsInspectorToggle, toggleModelsInspector } = await import(
      '../../src/ui/models/inspector-visibility.ts'
    );
    const root = document.getElementById('modelsView')!;
    const toggle = document.getElementById('btnModelsInspector')!;
    document.documentElement.classList.add('mn-graphite-apps');
    setModelsInspectorOpen(true);

    root.dataset.modelsSection = 'server';
    syncModelsInspectorToggle();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(localStorage.getItem('minnow.models.inspector'), '1');

    toggleModelsInspector();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(root.classList.contains('is-runtime-inspector'));

    toggleModelsInspector();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(root.classList.contains('is-inspector-hidden'));
  });
});

describe('showInspectorTab', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;

    document.body.innerHTML = `
      <main id="modelsView" class="models-page is-inspector-hidden is-workbench">
        <button id="btnModelsInspector" type="button" aria-expanded="false"></button>
        <aside id="modelsInspector"></aside>
      </main>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('opens hidden inspector when switching to load tab', async () => {
    const { isModelsInspectorOpen } = await import('../../src/ui/models/inspector-visibility.ts');
    const { showInspectorTab } = await import('../../src/ui/models/inspector.ts');
    const { selectModel } = await import('../../src/ui/models/store.ts');

    selectModel('gguf:test/repo:file.gguf');
    showInspectorTab('load');
    assert.equal(isModelsInspectorOpen(), true);
  });

  test('showModelInInspector selects a row and opens the panel', async () => {
    const { isModelsInspectorOpen } = await import('../../src/ui/models/inspector-visibility.ts');
    const { showModelInInspector } = await import('../../src/ui/models/inspector.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');

    showModelInInspector('gguf:acme/model:weights/model-Q4_K_M.gguf');
    assert.equal(isModelsInspectorOpen(), true);
    assert.equal(getModelsState().selectedId, 'gguf:acme/model:weights/model-Q4_K_M.gguf');
  });
});
