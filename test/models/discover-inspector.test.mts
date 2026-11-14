import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import type { HardwareSnapshot } from '../../src/models/types.ts';

test('Discover starts with one download and keeps an explicit quant selection', async (t) => {
  const window = new Window({ url: 'http://localhost' });
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, _init?: RequestInit) => {
    if (url === '/api/models/download') return Response.json({ error: 'Disk full' }, { status: 507 });
    return Response.json({
      files: [
        { filename: 'small.gguf', quant: 'Q3_K_M', sizeBytes: 2 * 1024 ** 3, files: ['small.gguf'], error: null },
        { filename: 'balanced.gguf', quant: 'Q4_K_M', sizeBytes: 4 * 1024 ** 3, files: ['balanced.gguf'], error: null },
        { filename: 'large.gguf', quant: 'Q8_0', sizeBytes: 14 * 1024 ** 3, files: ['large.gguf'], error: null },
      ],
    });
  });
  Object.assign(globalThis, { window, document: window.document });
  t.after(async () => {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    await window.happyDOM.close();
  });
  const { createDiscoverInspector } = await import('../../src/ui/models/discover-inspector.ts');
  const host = document.createElement('aside');
  document.body.append(host);
  const hardware = {
    hasGpu: true, gpuVramGb: 12, availableRamGb: 9, backend: 'cuda', unifiedMemory: false,
  } as HardwareSnapshot;
  const inspector = createDiscoverInspector(host, () => ({ hardware, context: 4096 }), () => {});
  const model = { name: 'Test 4B', repoId: 'test/model-gguf', format: 'gguf' as const, params: 4 };
  const toggle = () => host.querySelector<HTMLButtonElement>('.discover-quant-toggle')!;
  const variant = () => host.querySelector('.discover-variant-summary__file strong')?.textContent;
  const radios = () => [...host.querySelectorAll<HTMLInputElement>('input[type=radio]')];

  await inspector.select(model);
  assert.equal(variant(), 'Q4_K_M');
  assert.equal(toggle().textContent, 'Show all quants');
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.equal(radios().length, 0);

  hardware.gpuVramGb = 5;
  inspector.refresh();
  assert.equal(variant(), 'Q3_K_M');

  toggle().click();
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
  assert.equal(radios().length, 3);
  assert.equal(radios()[0].checked, true);
  assert.equal(host.querySelectorAll('.discover-file .fi-rr-check').length, 2);
  assert.match(host.querySelector('.discover-file:last-child')!.textContent!, /Over budget/);

  const balanced = radios()[1];
  balanced.focus();
  balanced.click();
  assert.equal(variant(), 'Q4_K_M');
  assert.equal(document.activeElement, balanced);
  hardware.gpuVramGb = 24;
  inspector.refresh();
  assert.equal(radios()[1].checked, true);
  assert.equal(document.activeElement, radios()[1]);

  toggle().click();
  assert.equal(radios().length, 0);
  assert.equal(variant(), 'Q4_K_M');

  host.querySelector<HTMLButtonElement>('[aria-label="Download Q4_K_M"]')!.click();
  const [url, request] = fetch.mock.calls.at(-1)!.arguments;
  assert.equal(url, '/api/models/download');
  assert.equal(JSON.parse(request!.body as string).filename, 'balanced.gguf');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.querySelector('[role=alert]')?.textContent, 'Disk full');
  assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="Download Q4_K_M"]')?.disabled, false);

  await inspector.select({ ...model, repoId: 'test/another-gguf' });
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  inspector.dispose();
});
