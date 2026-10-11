/** Stable provider id for in-process llama.cpp serves. */
export { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID, MTPLX_LOCAL_ID } from './engine-ids.mjs';

/** Stable provider id for in-process mlx-lm serves. */

export const CLAUDE_CODE_CLI_ID: 'claude-code-cli';
export const CODEX_CLI_ID: 'codex-cli';
export const CURSOR_AGENT_CLI_ID: 'cursor-agent-cli';
export const AGENT_CLI_PROVIDER_IDS: readonly [
  'claude-code-cli',
  'codex-cli',
  'cursor-agent-cli',
];
export function isAgentCliProviderId(id: unknown): boolean;
