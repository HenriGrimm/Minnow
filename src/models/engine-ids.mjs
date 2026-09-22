/** Engine identity shared by the browser and tool server. */
export const ENGINE_IDS = Object.freeze(['llama-cpp', 'mlx-lm', 'mtplx', 'ollama', 'lm-studio']);
export const LLAMA_CPP_LOCAL_ID = 'llama-cpp-local';
export const MLX_LM_LOCAL_ID = 'mlx-lm-local';
export const MTPLX_LOCAL_ID = 'mtplx-local';
export const PROVIDER_ID_BY_ENGINE = Object.freeze({
  'llama-cpp': LLAMA_CPP_LOCAL_ID,
  'mlx-lm': MLX_LM_LOCAL_ID,
  mtplx: MTPLX_LOCAL_ID,
});
export const ENGINE_LABELS = Object.freeze({
  'llama-cpp': 'llama.cpp', 'mlx-lm': 'MLX', mtplx: 'MTPLX',
  ollama: 'Ollama', 'lm-studio': 'LM Studio',
});
export const LOCAL_SERVE_PROVIDER_IDS = Object.freeze(Object.values(PROVIDER_ID_BY_ENGINE));
export function isLocalServeProviderId(id) {
  return LOCAL_SERVE_PROVIDER_IDS.includes(id);
}
