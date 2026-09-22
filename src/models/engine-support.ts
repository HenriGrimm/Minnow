import type { EngineId } from './engine-ids.mjs';
import type { LibraryModel } from './library';

export function enginesForModel(m: LibraryModel): EngineId[] {
  if (m.incomplete) return [];
  if (m.source === 'ollama') return ['ollama'];
  if (m.source === 'mtplx-cache') return m.mtplxValidated ? ['mtplx', 'mlx-lm'] : [];
  if (!m.servable) return [];
  if (m.format === 'GGUF') return ['llama-cpp'];
  if (m.format === 'MLX') return ['mlx-lm'];
  return [];
}

export function defaultEngineFor(m: LibraryModel): EngineId | null {
  return enginesForModel(m)[0] ?? null;
}
