import { estimateServeMemory } from './serve-memory-estimate';
import type { HardwareSnapshot } from './types';

export interface DiscoverFit {
  label: string;
  detail: string;
  memoryGb: number | null;
  fits: boolean;
  tone: 'good' | 'warning' | 'unknown';
}

/** Use the serving estimator with real artifact bytes; never silently lower context to claim a fit. */
export function discoverFit(input: {
  name: string;
  sizeBytes: number | null;
  params: number | null;
  arch?: string;
  context: number;
  maxContext?: number;
  hardware: HardwareSnapshot | null;
}): DiscoverFit {
  const hw = input.hardware;
  const unknown = {
    label: 'Fit unknown',
    detail:
      'Choose a file to check memory. Estimates need file size, model metadata, and detected hardware.',
    memoryGb: null,
    fits: false,
    tone: 'unknown' as const,
  };
  if (!hw || !input.sizeBytes || !input.params) return unknown;
  if (input.maxContext && input.context > input.maxContext) {
    return {
      ...unknown,
      label: 'Context too long',
      detail: `This model supports ${input.maxContext.toLocaleString()} tokens. Lower the target context.`,
      tone: 'warning',
    };
  }
  const gpu = hw.hasGpu && (hw.gpuVramGb ?? 0) > 0;
  const memory = estimateServeMemory({
    weightsGb: input.sizeBytes / 1024 ** 3,
    paramsB: input.params,
    name: input.name,
    arch: input.arch,
    ctx: input.context,
    backend: hw.backend,
    nGpuLayers: gpu ? 999 : 0,
  });
  const memoryGb = memory.totalGb * 1.1;
  const singleGpu = hw.gpus?.length
    ? Math.max(...hw.gpus.map((device) => device.vramGb))
    : (hw.gpuVramGb ?? 0) / Math.max(1, hw.gpuCount || 1);
  const gpuBudget = hw.unifiedMemory ? Math.min(hw.gpuVramGb ?? 0, hw.availableRamGb) : singleGpu;
  const fitsGpu = gpu && memoryGb <= gpuBudget * 0.9;
  const fitsRam = memoryGb <= hw.availableRamGb * 0.85;
  const label = fitsGpu
    ? hw.unifiedMemory
      ? 'Fits unified memory'
      : 'Fits GPU memory'
    : fitsRam
      ? 'Fits in RAM'
      : 'Exceeds memory budget';
  return {
    label,
    memoryGb,
    fits: fitsGpu || fitsRam,
    tone: fitsGpu || (!gpu && fitsRam) ? 'good' : 'warning',
    detail: `Estimated ${memoryGb.toFixed(1)} GiB at ${input.context.toLocaleString()} tokens, including runtime overhead and headroom.${fitsRam && !fitsGpu ? ' CPU execution will be slower.' : ''} ${memory.geometrySource === 'heuristic' ? 'Approximate model geometry.' : 'Based on model-family geometry.'} Other apps and runtime settings affect actual fit.`,
  };
}
