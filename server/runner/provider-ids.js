export const LLAMA_CPP_LOCAL_PROVIDER_ID = 'llama-cpp-local';
export const MLX_LM_LOCAL_PROVIDER_ID = 'mlx-lm-local';
export const CLAUDE_CODE_CLI_PROVIDER_ID = 'claude-code-cli';
export const CODEX_CLI_PROVIDER_ID = 'codex-cli';
export const CURSOR_AGENT_CLI_PROVIDER_ID = 'cursor-agent-cli';

const AGENT_CLI_PROVIDER_IDS = new Set([
  CLAUDE_CODE_CLI_PROVIDER_ID,
  CODEX_CLI_PROVIDER_ID,
  CURSOR_AGENT_CLI_PROVIDER_ID,
]);

/** @param {unknown} id */
export function isAgentCliProviderId(id) {
  return typeof id === 'string' && AGENT_CLI_PROVIDER_IDS.has(id);
}
