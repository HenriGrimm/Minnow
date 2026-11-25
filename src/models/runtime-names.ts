const RUNTIME_NAMES: Record<string, string> = { 'llama-cpp': 'llama.cpp', 'mlx-lm': 'MLX', mtplx: 'MTPLX', ollama: 'Ollama' };

/** `mtplx` → `MTPLX`, `llama-cpp` → `llama.cpp`; unknown ids pass through. */
export function runtimeDisplayName(runtime: string): string {
  return RUNTIME_NAMES[runtime] ?? runtime;
}
