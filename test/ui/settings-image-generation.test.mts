import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

let saved = { enabled: true, providerId: 'images', adapterId: 'openai', modelId: 'image-model', defaults: {}, maxConcurrentJobs: 1, timeoutSeconds: 600 };
let fail = false;
const calls: string[] = [];
mock.module('../../src/config/image-generation-meta.ts', { namedExports: {
  loadImageGenerationConfig: async () => saved,
  saveImageGenerationConfig: async (next: typeof saved) => { if (fail) throw new Error('Save failed'); saved = next; },
} });
mock.module('../../src/providers/store.ts', { namedExports: { listProviders: async () => ({ providers: [{ id: 'images', label: 'Images', enabled: true, apiKind: 'openai-v1' }] }) } });
mock.module('../../src/tools/client.ts', { namedExports: { executeTool: async (name: string) => { calls.push(name); return { content: JSON.stringify({ status: 'Ready', capabilities: { options: { format: ['png', 'webp'] } } }) }; } } });
mock.module('../../src/state/workspace.ts', { namedExports: { getWorkspacePath: () => '/workspace' } });
mock.module('../../src/ui/settings-layout.ts', { namedExports: {
  appendSettingsGroup: (mount: HTMLElement) => { const body = document.createElement('section'); mount.append(body); return body; },
  linkToSettingsSection: (label: string) => { const link = document.createElement('a'); link.textContent = label; return link; },
} });

test('settings preserve edits on save failure; metadata and test buttons use separate approved tools', async () => {
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document });
  const { renderImageGenerationSettings } = await import('../../src/ui/settings-image-generation.ts');
  const mount = document.createElement('div'); document.body.append(mount);
  await renderImageGenerationSettings(mount);
  const button = (text: string) => [...mount.querySelectorAll('button')].find(b => b.textContent === text)!;
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  button('Check connection').click(); await settle();
  assert.deepEqual(calls, ['image_generation_info']);
  assert.ok(mount.textContent?.includes('No image was generated'));
  const input = mount.querySelector('input[type="text"]') as HTMLInputElement;
  input.value = 'new-image'; input.dispatchEvent(new window.Event('change') as unknown as Event);
  fail = true; button('Save').click(); await settle();
  assert.equal(saved.modelId, 'image-model'); assert.equal(input.value, 'new-image');
  fail = false; button('Retry save').click(); await settle();
  assert.equal(saved.modelId, 'new-image');
  button('Generate test image…').click(); await settle();
  assert.deepEqual(calls, ['image_generation_info', 'generate_image']);
  await window.happyDOM.close();
});
