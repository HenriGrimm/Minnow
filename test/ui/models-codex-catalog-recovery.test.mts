import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { modelsFetchAbort, setModelsFetchAbort } from '../../src/app-state.ts';
import { fetchModels, modelCache } from '../../src/api/models.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { flushScheduledSessionSaveForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { closeComposerModelMenu, mountComposerModelTrigger } from '../../src/ui/composer-model-trigger.ts';
import { seedMinimalSession } from '../os/dom-helpers.mts';

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'The model picker did not update.');
    await delay(10);
  }
}

test('after a cold reload, the picker restores Codex reasoning as soon as the catalog arrives', async () => {
  const originalFetch = globalThis.fetch;
  const codexKey = encodeModelSelectKey('codex-cli', 'current-codex-model');
  const otherKey = encodeModelSelectKey('other', 'other-model');
  const chat = seedMinimalSession();
  chat.modelId = 'current-codex-model';
  chat.reasoningEffort = 'xhigh';
  const select = document.createElement('select');
  select.id = 'modelSelect';
  const anchor = document.createElement('div');
  document.body.append(select, anchor);
  mountComposerModelTrigger(anchor, 'desktop');
  setStorageModeForTests('server');
  let codexCalls = 0;
  let otherCalls = 0;
  let busy = true;
  globalThis.fetch = async input => {
    switch (String(input)) {
      case '/api/config/default-model': return Response.json({ value: codexKey });
      case '/api/providers': return Response.json({ providers: [
        { id: 'codex-cli', label: 'Codex CLI', baseUrl: '', apiKind: 'agent-cli-v1' },
        { id: 'other', label: 'Other', baseUrl: 'https://other.invalid', apiKind: 'openai-v1' },
      ] });
      case '/api/providers/codex-cli/models':
        codexCalls += 1;
        return busy
          ? Response.json({ code: 'CODEX_CATALOG_BUSY' }, { status: 503, headers: { 'Retry-After': '0.01' } })
          : Response.json({ data: [{
            id: 'current-codex-model', display_name: 'Current Codex model', supportsFastMode: true,
            reasoning: { allowed_options: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
          }] });
      case '/api/providers/other/models':
        otherCalls += 1;
        return Response.json({ data: [{ id: 'other-model' }] });
      case '/api/generations/routers': return Response.json({ routers: [] });
      case '/api/models/cached': return Response.json({ models: [] });
      case '/api/models/serve': return Response.json({ serves: [] });
      default: return Response.json({ models: {}, defaults: {} });
    }
  };
  try {
    await fetchModels();
    assert.match(select.selectedOptions[0].text, /checking availability/);
    assert.equal(select.value, codexKey);
    assert.ok(modelCache.has(otherKey), 'Other providers are usable during discovery.');
    assert.equal(chat.reasoningEffort, 'xhigh', 'A pending catalog should preserve the saved effort.');
    const trigger = anchor.querySelector<HTMLButtonElement>('.composer-model-trigger')!;
    trigger.click();
    const picker = document.querySelector<HTMLElement>('.composer-model-menu:not(.hidden)')!;
    assert.ok(picker);
    await waitFor(() => codexCalls >= 2);
    assert.equal(otherCalls, 1, 'Only Codex is retried while the catalog is pending.');
    busy = false;
    await waitFor(() => modelCache.has(codexKey) && modelsFetchAbort === null);
    assert.equal(modelCache.get(codexKey)?.display_name, 'Current Codex model');
    assert.match(select.selectedOptions[0].text, /Current Codex model/);
    assert.equal(select.value, codexKey);
    assert.equal(chat.modelId, 'current-codex-model');
    assert.deepEqual([...picker.querySelectorAll<HTMLElement>('[data-composer-reasoning]')]
      .map(choice => choice.dataset.composerReasoning), ['inherit', 'low', 'medium', 'high', 'xhigh']);
    assert.equal(picker.querySelector('[data-composer-reasoning="xhigh"]')?.getAttribute('aria-pressed'), 'true');
    assert.match(trigger.textContent ?? '', /Extra high/);
    picker.querySelector<HTMLButtonElement>('[data-composer-reasoning="high"]')!.click();
    assert.equal(chat.reasoningEffort, 'high');
  } finally {
    closeComposerModelMenu();
    modelsFetchAbort?.abort();
    setModelsFetchAbort(null);
    setSessionStateForTests(null);
    flushScheduledSessionSaveForTests();
    setStorageModeForTests(null);
    globalThis.fetch = originalFetch;
    select.remove();
    anchor.remove();
  }
});
