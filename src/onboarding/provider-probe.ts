/**
 * Provider port probing for onboarding S2 — silent detect on common local backends.
 */

import { getDefaultPaths } from '../providers/paths';

export interface ProviderProbeResult {
  id: string;
  label: string;
  baseUrl: string;
  apiKind: 'lm-studio-v0' | 'openai-v1';
  reachable: boolean;
}

const PROBE_TARGETS: Omit<ProviderProbeResult, 'reachable'>[] = [
  {
    id: 'lm-studio-local',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234',
    apiKind: 'lm-studio-v0',
  },
  {
    id: 'ollama-local',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434',
    apiKind: 'openai-v1',
  },
  {
    id: 'llama-cpp-local',
    label: 'llama.cpp',
    baseUrl: 'http://127.0.0.1:8085',
    apiKind: 'openai-v1',
  },
];

async function probeUrl(url: string, timeoutMs = 1800): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe LM Studio, Ollama, and llama.cpp default ports in parallel. */
export async function probeLocalProviders(): Promise<ProviderProbeResult[]> {
  const results = await Promise.all(
    PROBE_TARGETS.map(async (target) => {
      const { modelsPath } = getDefaultPaths(target.apiKind);
      const reachable = await probeUrl(`${target.baseUrl}${modelsPath}`);
      return { ...target, reachable };
    }),
  );
  return results;
}

export function firstReachableProbe(results: ProviderProbeResult[]): ProviderProbeResult | null {
  return results.find((r) => r.reachable) ?? null;
}
