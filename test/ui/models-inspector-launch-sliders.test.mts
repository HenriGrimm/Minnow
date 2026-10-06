import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { LibraryModel } from '../../src/models/library.ts';
import type { HardwareSnapshot } from '../../src/models/types.ts';

function ggufModel(overrides: Partial<LibraryModel> = {}): LibraryModel {
  return {
    id: 'gguf:test/slider-model:weights/model-Q4_K_M.gguf',
    name: 'slider-model-Q4_K_M',
    repoId: 'test/slider-model',
    publisher: 'test',
    producerSlug: 'meta',
    producerName: 'Meta',
    producerLogoId: 'meta',
    format: 'GGUF',
    quant: 'Q4_K_M',
    arch: 'llama',
    domain: 'chat',
    paramsB: 7,
    contextLength: 8192,
    capabilities: [],
    sizeBytes: 4_000_000_000,
    path: '/tmp/slider-model-Q4_K_M.gguf',
    fileName: 'model-Q4_K_M.gguf',
    source: 'downloaded',
    servable: true,
    incomplete: false,
    isMoe: false,
    ...overrides,
  };
}

/** CUDA-class snapshot so the launch plan starts on GPU Auto (`n_gpu_layers` null). */
function cudaHardware(): HardwareSnapshot {
  return {
    os: 'Windows',
    platform: 'win32',
    arch: 'x64',
    cpuName: 'test-cpu',
    cpuCores: 8,
    totalRamGb: 64,
    availableRamGb: 31,
    hasGpu: true,
    gpuName: 'Test GPU',
    gpuVramGb: 24,
    gpuCount: 1,
    gpus: [{ index: 0, name: 'Test GPU', vramGb: 24 }],
    gpuGroups: [{ name: 'Test GPU', vramEach: 24, count: 1, indices: [0], vramTotal: 24 }],
    homogeneous: true,
    backend: 'cuda',
    unifiedMemory: false,
    detectedAt: 1_700_000_000_000,
  };
}

/** Move one discrete step and fire `input`, matching a real drag tick. */
function nudgeRange(range: HTMLInputElement): void {
  const max = Number(range.max);
  const min = Number(range.min);
  const current = Number(range.value);
  const next = current < max ? current + 1 : Math.max(min, current - 1);
  range.value = String(next);
  // happy-dom rejects Node's Event; use the window that owns the input.
  const EventCtor = range.ownerDocument.defaultView?.Event ?? Event;
  range.dispatchEvent(new EventCtor('input', { bubbles: true }));
}

describe('models inspector launch sliders', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };

    document.body.innerHTML = `
      <main id="modelsView" class="models-page is-workbench">
        <aside id="modelsInspector"></aside>
      </main>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('unified KV refreshes the meter and shares the selected context across parallel slots', async () => {
    const { initInspector, showModelInInspector, settingsFor } = await import('../../src/ui/models/inspector.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');
    const model = ggufModel({ id: 'gguf:test/unified-cache:weights/model-Q4_K_M.gguf' });
    getModelsState().library = [model];
    getModelsState().hardware = cudaHardware();
    initInspector();
    showModelInInspector(model.id, 'load');
    const findInput = (text: string) => {
      const label = Array.from(document.querySelectorAll('label')).find((node) => node.textContent?.includes(text));
      const input = label?.querySelector('input');
      assert.ok(input, text);
      return input;
    };
    const change = (input: HTMLInputElement) => {
      const EventCtor = input.ownerDocument.defaultView!.Event;
      input.dispatchEvent(new EventCtor('change', { bubbles: true }));
    };
    const slots = findInput('Parallel slots');
    slots.value = '3';
    change(slots);
    const context = document.querySelector<HTMLInputElement>('.models-field__range')!;
    context.value = '98304';
    const EventCtor = context.ownerDocument.defaultView!.Event;
    context.dispatchEvent(new EventCtor('input', { bubbles: true }));
    assert.equal(settingsFor(model).ctx, 98304 * 3);
    const vram = () => Number(document.querySelector('[data-kind="vram"] [role="meter"]')?.getAttribute('aria-valuenow'));
    const separateVram = vram();
    const unified = findInput('Unified KV cache');
    unified.checked = true;
    change(unified);
    assert.equal(settingsFor(model).ctx, 98304);
    assert.equal(settingsFor(model).kv_unified, true);
    assert.ok(vram() < separateVram);
    assert.match(document.querySelector('.models-field__context-total')!.textContent!, /98,304 tokens shared across 3 slots/);
    const newSlots = findInput('Parallel slots');
    newSlots.value = '5';
    change(newSlots);
    assert.equal(settingsFor(model).ctx, 98304);
    const sharedVram = vram();
    const off = findInput('Unified KV cache');
    off.checked = false;
    change(off);
    assert.equal(settingsFor(model).kv_unified, false);
    assert.equal(settingsFor(model).ctx, 98304 * 5);
    assert.ok(vram() > sharedVram);
  });

  test('keeps context and GPU range nodes mounted across input ticks', async () => {
    const { initInspector, showModelInInspector } = await import('../../src/ui/models/inspector.ts');
    const { getModelsState } = await import('../../src/ui/models/store.ts');

    const model = ggufModel();
    getModelsState().library = [model];
    initInspector();
    showModelInInspector(model.id, 'load');

    const ranges = document.querySelectorAll<HTMLInputElement>('.models-field__range');
    assert.equal(ranges.length, 2, 'Load tab should show context and GPU layer sliders');
    const [contextRange, gpuRange] = ranges;

    // Token-valued 1k steps, not the 13-rung auto-planning ladder (max=12).
    assert.equal(contextRange.min, '4096');
    assert.equal(contextRange.step, '1024');
    assert.ok(Number(contextRange.max) > 12);

    // Range inside <label> is the Chromium trap that snaps after one tick.
    assert.equal(contextRange.parentElement?.tagName, 'DIV');
    assert.equal(gpuRange.parentElement?.tagName, 'DIV');

    nudgeRange(contextRange);
    nudgeRange(contextRange);
    const afterContext = document.querySelectorAll<HTMLInputElement>('.models-field__range');
    assert.equal(afterContext[0], contextRange);
    assert.equal(afterContext[1], gpuRange);

    nudgeRange(gpuRange);
    nudgeRange(gpuRange);
    const afterGpu = document.querySelectorAll<HTMLInputElement>('.models-field__range');
    assert.equal(afterGpu[0], contextRange);
    assert.equal(afterGpu[1], gpuRange);
    assert.equal(gpuRange.parentElement?.querySelector('.models-field__auto-hint'), null);
    assert.ok(
      gpuRange.parentElement?.querySelector('.models-field__auto'),
      'leaving Auto should reveal a restore control without remounting',
    );
    assert.ok(
      document.querySelector('.models-launch-memory.models-launch-memory-hint'),
      'occupancy meter should still be present after slider ticks',
    );
  });

  test('GPU Auto restore returns the slider to Auto and brings the hint back', async () => {
    const { initInspector, showModelInInspector, settingsFor } = await import(
      '../../src/ui/models/inspector.ts'
    );
    const { getModelsState } = await import('../../src/ui/models/store.ts');

    const model = ggufModel({ id: 'gguf:test/slider-auto:weights/model-Q4_K_M.gguf' });
    getModelsState().library = [model];
    getModelsState().hardware = cudaHardware();
    initInspector();
    showModelInInspector(model.id, 'load');

    const gpuRange = document.querySelectorAll<HTMLInputElement>('.models-field__range')[1];
    assert.ok(gpuRange);
    assert.equal(gpuRange.parentElement?.querySelector('.models-field__auto'), null);
    assert.ok(gpuRange.parentElement?.querySelector('.models-field__auto-hint'));

    nudgeRange(gpuRange);
    const autoBtn = gpuRange.parentElement?.querySelector<HTMLButtonElement>('.models-field__auto');
    assert.ok(autoBtn);
    autoBtn.click();

    const afterRange = document.querySelectorAll<HTMLInputElement>('.models-field__range')[1];
    assert.equal(afterRange.parentElement?.querySelector('.models-field__range-value')?.textContent, 'Auto');
    assert.ok(afterRange.parentElement?.querySelector('.models-field__auto-hint'));
    assert.equal(afterRange.parentElement?.querySelector('.models-field__auto'), null);
    assert.equal(settingsFor(model).n_gpu_layers, undefined);
    assert.equal(settingsFor(model).fit_mode, undefined);
  });

  test('does not remount launch sliders while a range still has focus', async () => {
    const { initInspector, render, showModelInInspector } = await import(
      '../../src/ui/models/inspector.ts'
    );
    const { getModelsState } = await import('../../src/ui/models/store.ts');

    const model = ggufModel({ id: 'gguf:test/slider-focus:weights/model-Q4_K_M.gguf' });
    getModelsState().library = [model];
    initInspector();
    showModelInInspector(model.id, 'load');

    const gpuRange = document.querySelectorAll<HTMLInputElement>('.models-field__range')[1];
    assert.ok(gpuRange);
    gpuRange.focus();
    assert.equal(document.activeElement, gpuRange);

    // Store-style redraw while the thumb is still grabbed.
    render();

    const after = document.querySelectorAll<HTMLInputElement>('.models-field__range')[1];
    assert.equal(after, gpuRange);
  });
});
