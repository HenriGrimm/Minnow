/**
 * Provider registry types (public API — no secrets on the wire).
 */

import type { ProviderPricing } from '../usage/types';

export type ApiKind = 'lm-studio-v0' | 'openai-v1' | 'anthropic-v1' | 'agent-cli-v1';
export type AgentCliKind = 'claude' | 'codex' | 'cursor';
export type AgentCliAuthStatus = 'signed-in' | 'token' | 'unknown' | 'signed-out';

export interface AgentCliSettings {
  kind: AgentCliKind;
  binPath?: string;
  allowUtilityRoles: boolean;
  maxConcurrent: number;
  maxBudgetUsd?: number;
  sessionMode: 'replay';
}
export type AuthStyle = 'bearer' | 'api-key' | 'x-api-key';
export type ProviderId = string;

/** Same strings as server/providers/store.js — sourced from runtime-ids.mjs. */
export {
  LLAMA_CPP_LOCAL_ID as LLAMA_CPP_LOCAL_PROVIDER_ID,
  MLX_LM_LOCAL_ID as MLX_LM_LOCAL_PROVIDER_ID,
} from '../models/runtime-ids.mjs';

/** Provider metadata returned by GET /api/providers (secrets redacted). */
export interface ProviderPublic {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKind: ApiKind;
  enabled: boolean;
  authStyle?: AuthStyle;
  modelsPath?: string;
  chatCompletionsPath?: string;
  /** Anthropic Messages path for anthropic-v1 or autoApi gateways. Default `/v1/messages`. */
  messagesPath?: string;
  /** When true on openai-v1 providers, route Claude models to messagesPath automatically. */
  autoApi?: boolean;
  /** Explicit per-model API overrides (highest priority). */
  modelApiOverrides?: Record<string, ApiKind>;
  /** LM Studio v1 load/unload; default true for lm-studio-v0. */
  supportsModelLoadUnload?: boolean;
  /**
   * Local llama.cpp / mlx-lm keep `top_k` / `min_p` / `repetition_penalty` /
   * `enable_thinking`. Hosted OpenAI-compatible APIs reject those fields.
   */
  supportsExtendedSamplers?: boolean;
  modelsLoadPath?: string;
  modelsUnloadPath?: string;
  customHeaders?: Record<string, string>;
  /** Per-provider override for constrained tool calls; undefined uses global default. */
  constrainedToolCalls?: boolean;
  createdAt?: string;
  updatedAt?: string;
  hasApiKey: boolean;
  hasBearer: boolean;
  hasCliToken?: boolean;
  agentCli?: AgentCliSettings;
  /** Optional per-model API pricing for usage cost estimates. */
  pricing?: ProviderPricing;
}

export interface ProviderListResponse {
  providers: ProviderPublic[];
  activeProviderId: string;
}

/** Resolved URLs for models (and load/unload) via Minnow server proxy. */
export interface ProviderEndpoints {
  provider: ProviderPublic;
  modelsUrl: string;
  modelsLoadUrl?: string;
  modelsUnloadUrl?: string;
}
