/** Stable provider id for in-process llama.cpp serves. */
export const LLAMA_CPP_LOCAL_ID: 'llama-cpp-local';

/** Stable provider id for in-process mlx-lm serves. */
export const MLX_LM_LOCAL_ID: 'mlx-lm-local';

export const CLAUDE_CODE_CLI_ID: 'claude-code-cli';
export const CODEX_CLI_ID: 'codex-cli';
export const CURSOR_AGENT_CLI_ID: 'cursor-agent-cli';
export const AGENT_CLI_PROVIDER_IDS: readonly [
  'claude-code-cli',
  'codex-cli',
  'cursor-agent-cli',
];
export function isAgentCliProviderId(id: unknown): boolean;
