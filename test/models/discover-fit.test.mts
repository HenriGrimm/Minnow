import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverFit } from '../../src/models/discover-fit.ts';
import type { HardwareSnapshot } from '../../src/models/types.ts';

const hardware = {
  hasGpu: true,
  gpuVramGb: 12,
  availableRamGb: 32,
  backend: 'cuda',
  unifiedMemory: false,
} as HardwareSnapshot;
const input = {
  name: 'Qwen3-4B',
  sizeBytes: 2.5 * 1024 ** 3,
  params: 4,
  context: 4096,
  maxContext: 40960,
  hardware,
};

test('unknown data is never presented as a fit', () => {
  assert.equal(discoverFit({ ...input, sizeBytes: null }).label, 'Fit unknown');
  assert.equal(discoverFit({ ...input, hardware: null }).fits, false);
});

test('context is never silently shortened to make a model fit', () => {
  const fit = discoverFit({ ...input, context: 65536 });
  assert.equal(fit.label, 'Context too long');
  assert.equal(fit.fits, false);
});

test('actual selected bytes affect memory and RAM fallback is explicit', () => {
  const small = discoverFit(input);
  const large = discoverFit({ ...input, sizeBytes: 14 * 1024 ** 3 });
  assert.equal(small.label, 'Fits GPU memory');
  assert.equal(large.label, 'Fits in RAM');
  assert.ok(large.memoryGb! > small.memoryGb!);
  assert.match(large.detail, /CPU execution/);
});

test('unified memory cannot exceed currently available system memory', () => {
  const fit = discoverFit({
    ...input,
    hardware: { ...hardware, unifiedMemory: true, gpuVramGb: 64, availableRamGb: 1 },
  });
  assert.equal(fit.fits, false);
});
