import { IMAGE_OPTION_KEYS, mergeImageGenerationConfig } from '../../server/image-generation/contracts.js';
import type { ImageGenerationConfig } from '../../server/image-generation/contracts.js';
export type { ImageGenerationConfig };

export async function loadImageGenerationConfig(): Promise<ImageGenerationConfig> {
  const response = await fetch('/api/config/meta', { cache: 'no-store' });
  if (!response.ok) throw new Error('Image settings unavailable');
  const meta = await response.json();
  return mergeImageGenerationConfig(null, meta.imageGeneration ?? {});
}

export async function saveImageGenerationConfig(config: ImageGenerationConfig): Promise<void> {
  const imageGeneration = mergeImageGenerationConfig(null, config);
  // The config API merges defaults, so explicitly remove options cleared by the form.
  const defaults = { ...Object.fromEntries(IMAGE_OPTION_KEYS.map(key => [key, null])), ...imageGeneration.defaults };
  const response = await fetch('/api/config/meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageGeneration: { ...imageGeneration, defaults } }) });
  if (!response.ok) throw new Error('Image settings were not saved. Retry.');
}
