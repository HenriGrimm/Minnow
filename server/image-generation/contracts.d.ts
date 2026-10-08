export interface ImageGenerationConfig {
  enabled: boolean;
  providerId: string;
  adapterId: string;
  modelId: string;
  defaults: Partial<Record<'aspect_ratio' | 'size' | 'quality' | 'format' | 'background', string>>;
  maxConcurrentJobs: number;
  timeoutSeconds: number;
}
export type ImageRequest = ImageGenerationConfig['defaults'] & {
  prompt: string;
  operation?: 'generate' | 'edit';
  reference_paths?: string[];
  output_path?: string;
}
export interface ImageCapabilities {
  operations: ('generate' | 'edit')[];
  options: ImageGenerationConfig['defaults'] extends infer T ? Partial<Record<keyof T, string[]>> : never;
}
export const DEFAULT_IMAGE_GENERATION_CONFIG: Readonly<ImageGenerationConfig>;
export const IMAGE_OPTION_KEYS: readonly string[];
export const MAX_IMAGE_BYTES: number;
export const MAX_IMAGE_PIXELS: number;
export function mergeImageGenerationConfig(existing: Partial<ImageGenerationConfig> | null, patch: unknown): ImageGenerationConfig;
export function normalizeImageRequest(raw: unknown, defaults?: ImageGenerationConfig['defaults']): ImageRequest;
export function validateImageCapabilities(request: ImageRequest, capabilities: ImageCapabilities): void;
