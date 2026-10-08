import { createHash } from 'node:crypto';
import { readConfigJson } from '../config/store.js';
import { getProviderRuntime } from '../providers/store.js';
import { mergeImageGenerationConfig } from './contracts.js';
import { getImageAdapter } from './adapter-registry.js';

export async function loadImageGenerationConfig() {
  const meta = await readConfigJson('config.json');
  return mergeImageGenerationConfig(null, meta?.imageGeneration ?? {});
}

export async function resolveImageBinding(config, resolveProvider = getProviderRuntime, resolveAdapter = getImageAdapter) {
  const binding = mergeImageGenerationConfig(null, config);
  if (!binding.enabled || !binding.providerId || !binding.adapterId || !binding.modelId) throw new Error('Configure Image generation in Models → Routing');
  const adapter = resolveAdapter(binding.adapterId);
  let runtime;
  try { runtime = await resolveProvider(binding.providerId); } catch { throw new Error('Image provider unavailable'); }
  if (!runtime?.profile?.enabled || runtime.profile.apiKind === 'agent-cli-v1') throw new Error('Image provider unavailable');
  const fingerprint = createHash('sha256').update(JSON.stringify({ binding, profile: runtime.profile })).digest('hex');
  return { binding, adapter, runtime, fingerprint };
}
