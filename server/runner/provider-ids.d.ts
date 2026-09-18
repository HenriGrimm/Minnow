/** Stable local-serve provider ids — keep in lockstep with `src/models/runtime-ids.mjs`. */
export const LLAMA_CPP_LOCAL_PROVIDER_ID: 'llama-cpp-local';
export const MLX_LM_LOCAL_PROVIDER_ID: 'mlx-lm-local';
export const CLAUDE_CODE_CLI_PROVIDER_ID: 'claude-code-cli';
export const CODEX_CLI_PROVIDER_ID: 'codex-cli';
export const CURSOR_AGENT_CLI_PROVIDER_ID: 'cursor-agent-cli';
export function isAgentCliProviderId(id: unknown): boolean;

export type { ApiKind, ProviderPublic } from '../../src/providers/types';
