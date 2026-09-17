/**
 * Known context windows for major API models (fallback when /models omits context metadata).
 * Known model context windows — longest matching key wins substring lookup.
 */

export const KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-5': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4': 200_000,
  'claude-fable-5': 200_000,
  'claude-haiku-3-5': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,

  'gpt-5': 400_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16_385,
  o1: 200_000,
  'o1-mini': 128_000,
  'o1-pro': 200_000,
  o3: 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,

  'deepseek-chat': 64_000,
  'deepseek-coder': 64_000,
  'deepseek-reasoner': 64_000,
  'deepseek-r1': 64_000,
  'deepseek-v4': 1_000_000,
  'deepseek-v3': 64_000,
  'deepseek-v2': 64_000,

  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-1.5-pro': 1_048_576,
  'gemini-1.5-flash': 1_048_576,
  'gemma-4': 262_144,
  'gemma-3': 128_000,
  'gemma-2': 8192,

  'mistral-large': 128_000,
  'mistral-medium': 32_000,
  'mistral-small': 32_000,
  'mistral-nemo': 128_000,
  'mistral-7b': 32_000,
  mixtral: 32_000,
  codestral: 32_000,
  pixtral: 128_000,

  'grok-4': 131_072,
  'grok-3': 131_072,
  'grok-2': 131_072,

  'llama-4': 1_048_576,
  'llama-3.3': 131_072,
  'llama-3.2': 131_072,
  'llama-3.1': 131_072,
  'llama-3': 131_072,

  'qwen3.8': 262_144,
  qwen3_8: 262_144,
  'qwen3.5': 262_144,
  'qwen3.6': 262_144,
  qwen3: 131_072,
  'qwen2.5': 131_072,
  qwen2: 32_768,
  qwq: 32_768,

  'command-r-plus': 128_000,
  'command-r': 128_000,
  'command-a': 256_000,

  'sonar-pro': 200_000,
  sonar: 128_000,

  minimax: 1_000_000,

  moonshot: 128_000,
  kimi: 128_000,

  'phi-4': 16_000,
  'phi-3': 128_000,

  nemotron: 131_072,

  'yi-large': 32_768,
  'yi-1.5': 16_384,
  'yi-lightning': 16_384,

  hermes: 131_072,
  'nous-hermes': 131_072,

  dolphin: 32_768,
  mythomax: 4096,
  wizard: 32_768,
  openchat: 8192,
  solar: 32_768,
};

/** Lookup known context length by model id (longest matching key wins). */
export function lookupKnownContextLength(modelId: string): number | undefined {
  const name = modelId.toLowerCase();
  const basename = name.includes('/') ? name.split('/').pop()! : name;
  const stem = basename.split(':')[0];

  let bestKey: string | undefined;
  let bestCtx: number | undefined;

  for (const [key, ctx] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
    if (stem.includes(key) || name.includes(key)) {
      if (bestKey === undefined || key.length > bestKey.length) {
        bestKey = key;
        bestCtx = ctx;
      }
    }
  }

  return bestCtx;
}
