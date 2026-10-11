/**
 * Stable provider ids for in-process llama.cpp / mlx-lm serves.
 *
 * One module so the server store, client types, and sanitizer id-fallbacks cannot
 * drift if a string is renamed. Re-exported from `server/providers/store.js` as
 * `LLAMA_CPP_LOCAL_ID` / `MLX_LM_LOCAL_ID` so existing imports keep working.
 */

export { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID, MTPLX_LOCAL_ID } from './engine-ids.mjs';

export const CLAUDE_CODE_CLI_ID = 'claude-code-cli';
export const CODEX_CLI_ID = 'codex-cli';
export const CURSOR_AGENT_CLI_ID = 'cursor-agent-cli';

export const AGENT_CLI_PROVIDER_IDS = Object.freeze([
  CLAUDE_CODE_CLI_ID,
  CODEX_CLI_ID,
  CURSOR_AGENT_CLI_ID,
]);

const AGENT_CLI_PROVIDER_ID_SET = new Set(AGENT_CLI_PROVIDER_IDS);

/** @param {unknown} id */
export function isAgentCliProviderId(id) {
  return typeof id === 'string' && AGENT_CLI_PROVIDER_ID_SET.has(id);
}
