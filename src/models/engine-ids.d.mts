export type EngineId = 'llama-cpp' | 'mlx-lm' | 'mtplx' | 'ollama' | 'lm-studio';
export const ENGINE_IDS: readonly EngineId[];
export const LLAMA_CPP_LOCAL_ID: 'llama-cpp-local';
export const MLX_LM_LOCAL_ID: 'mlx-lm-local';
export const MTPLX_LOCAL_ID: 'mtplx-local';
export const PROVIDER_ID_BY_ENGINE: Readonly<Record<'llama-cpp' | 'mlx-lm' | 'mtplx', string>>;
export const ENGINE_LABELS: Readonly<Record<EngineId, string>>;
export const LOCAL_SERVE_PROVIDER_IDS: readonly string[];
export function isLocalServeProviderId(id: unknown): boolean;
