import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let config: any = { types: { explore: { label: 'Explore', providerId: '', modelId: '' } } };
const patches: any[] = [];
mock.module('../../src/models/model-choices.ts', { namedExports: { loadModelChoices: async () => [{ value: 'cloud\u001fflash', label: 'Flash', group: 'Cloud' }] } });
mock.module('../../src/ui/model-select-picker.ts', { namedExports: { mountAuxiliaryModelSelectCombobox() {}, unmountAuxiliaryModelSelectCombobox() {} } });
mock.module('../../src/agents/sub-agent-config.ts', { namedExports: { loadSubAgentConfig: async () => config, setRuntimeSubAgentOverrides: (fresh: any) => { config = { types: { explore: { label: 'Explore', providerId: '', modelId: '' } }, ...fresh }; }, patchSubAgentUserOverrides: async (patch: any) => { patches.push(patch); config = { ...config, ...patch }; return true; } } });
const { mountRoutingForm } = await import('../../src/ui/routing-form.ts');

test('routing setup needs no chat and commits only dirty roles; skipping keeps settings', async () => {
  const original = globalThis.fetch; const writes: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    if (init?.method === 'PUT') writes.push(JSON.parse(init.body));
    return Response.json({ utilityModel: { providerId: 'existing', modelId: 'utility' }, editorAiCompletion: { useChatModel: true } });
  }) as typeof fetch;
  const host = document.createElement('div'); document.body.append(host);
  const form = mountRoutingForm(host);
  try {
    await form.ready;
    assert.equal(host.querySelectorAll('select').length, 5);
    assert.equal(writes.length, 0); assert.equal(patches.length, 0);
    const sub = host.querySelector<HTMLSelectElement>('[aria-label="Sub-agents model"]')!;
    sub.value = 'cloud\u001fflash'; sub.dispatchEvent(new window.Event('change'));
    assert.equal(patches.length, 0);
    await form.commit();
    assert.deepEqual(patches, [{ defaultModel: { providerId: 'cloud', modelId: 'flash' } }]);
    assert.equal(writes.length, 0);
    await form.commit(); assert.equal(patches.length, 1);
  } finally { form.dispose(); host.remove(); globalThis.fetch = original; }
});

test('failed routing reads offer a reload without inventing empty values', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
  const host = document.createElement('div'); document.body.append(host);
  const form = mountRoutingForm(host);
  try {
    await assert.rejects(form.ready, /load model routing/);
    assert.equal(host.querySelectorAll('select').length, 0);
    assert.equal(host.querySelector('button')?.textContent, 'Reload routing');
  } finally { form.dispose(); host.remove(); globalThis.fetch = original; }
});
