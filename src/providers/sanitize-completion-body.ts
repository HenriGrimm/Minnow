/**
 * Strip provider-incompatible completion fields before upstream POST.
 */

import { anthropicThinkingTypeFromProviderOptions } from '../lib/anthropic-thinking-style';
import { isGlm53ModelId } from '../lib/reasoning-effort';
import type { ProviderPublic, ApiKind } from './types';
import { LLAMA_CPP_LOCAL_PROVIDER_ID, MLX_LM_LOCAL_PROVIDER_ID } from './types';
import { providerSupportsChatTemplateKwargs } from './provider-host';
import { resolvedApiForModel } from './resolve-model-api';
import type { ModelCapabilities } from '../types';

/** True when OpenAI o-series / gpt-5 models expect max_completion_tokens. */
function modelUsesMaxCompletionTokens(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  if (/^o\d/.test(id)) return true;
  return id.includes('gpt-5');
}

function anthropicThinkingEnabled(body: Record<string, unknown>): boolean {
  const providerOptions = body.providerOptions;
  if (providerOptions && typeof providerOptions === 'object') {
    const type = anthropicThinkingTypeFromProviderOptions(
      typeof body.model === 'string' ? body.model : '',
      providerOptions as Record<string, Record<string, unknown>>,
    );
    if (type === 'enabled' || type === 'adaptive') {
      return true;
    }
    if (type === 'disabled') {
      return false;
    }
  }
  const thinking = body.thinking;
  if (!thinking || typeof thinking !== 'object') {
    return false;
  }
  const thinkingType = (thinking as { type?: string }).type;
  return thinkingType === 'enabled' || thinkingType === 'adaptive';
}

/** True when the body explicitly disables thinking (must survive sanitization). */
function isThinkingExplicitlyDisabled(thinking: unknown): boolean {
  if (!thinking || typeof thinking !== 'object') return false;
  return (thinking as { type?: string }).type === 'disabled';
}

/**
 * GLM-5.3 last-line defense: thinking is always on; effort is low | high | max.
 * Rewrites disabled / none / off / medium / xhigh so Z.ai does not 400.
 */
function rewriteGlm53ThinkingBody(
  next: Record<string, unknown>,
  modelId: string,
): void {
  if (!isGlm53ModelId(modelId)) return;
  const rawEffort =
    typeof next.reasoning_effort === 'string' ? next.reasoning_effort : undefined;
  let wire: 'low' | 'high' | 'max' = 'low';
  if (rawEffort === 'high') wire = 'high';
  else if (
    rawEffort === 'max' ||
    rawEffort === 'xhigh' ||
    rawEffort === 'extra_high' ||
    rawEffort === 'extra high'
  ) {
    wire = 'max';
  } else if (rawEffort === 'low') {
    wire = 'low';
  }
  next.thinking = { type: 'enabled' };
  next.reasoning_effort = wire;
  next.reasoning = { effort: wire };
  if (next.enable_thinking === false) next.enable_thinking = true;
  const kwargs = next.chat_template_kwargs;
  if (kwargs && typeof kwargs === 'object') {
    const nextKwargs = { ...(kwargs as Record<string, unknown>) };
    if (nextKwargs.enable_thinking === false) nextKwargs.enable_thinking = true;
    nextKwargs.reasoning_effort = wire;
    next.chat_template_kwargs = nextKwargs;
  }
}

/** GPT-5 / o-series on Responses API reject custom temperature. */
function modelRejectsTemperature(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  if (/^o\d/.test(id)) return true;
  return id.includes('gpt-5');
}

/** Drop Minnow-only message fields that providers reject as unknown. */
function stripInternalApiMessageFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: body.messages.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const msg = { ...(raw as Record<string, unknown>) };
      delete msg.toolImageFollowUp;
      return msg;
    }),
  };
}

/**
 * llama.cpp's chat templates only render replayed thinking from
 * `reasoning_content`; `reasoning` is silently dropped, which loses the model's
 * own thinking between tool rounds and breaks the KV-cache prefix. Only message
 * objects are touched — the top-level `reasoning` effort field is unrelated.
 */
function mapLocalReasoningReplay(next: Record<string, unknown>, providerId: string): void {
  if (providerId !== LLAMA_CPP_LOCAL_PROVIDER_ID && providerId !== MLX_LM_LOCAL_PROVIDER_ID) return;
  if (!Array.isArray(next.messages)) return;
  next.messages = next.messages.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const src = raw as Record<string, unknown>;
    if (src.role !== 'assistant' || typeof src.reasoning !== 'string') return raw;
    const msg = { ...src };
    if (typeof msg.reasoning_content !== 'string' || !msg.reasoning_content) {
      msg.reasoning_content = msg.reasoning;
    }
    delete msg.reasoning;
    return msg;
  });
}

/**
 * llama.cpp / mlx-lm accept min_p / top_k / repetition_penalty / enable_thinking.
 * Prefer the persisted flag; fall back to the stable local ids so in-memory
 * tests and generations that only pass `{ id }` still keep those fields.
 */
function providerKeepsExtendedSamplers(provider: ProviderPublic): boolean {
  if (provider.supportsExtendedSamplers === true) return true;
  return (
    provider.id === LLAMA_CPP_LOCAL_PROVIDER_ID || provider.id === MLX_LM_LOCAL_PROVIDER_ID
  );
}

/**
 * Normalize a chat completion body for the target provider.
 * openai-v1: drop LM Studio sampler fields unless the provider is a local
 * llama.cpp / mlx-lm serve (`supportsExtendedSamplers` or those stable ids).
 * anthropic-v1: drop sampler fields when extended thinking is active.
 */
export function sanitizeCompletionBodyForProvider(
  body: Record<string, unknown>,
  provider: ProviderPublic,
  modelCapabilities?: ModelCapabilities | null,
  modelApi?: ApiKind,
): Record<string, unknown> {
  const apiKind = modelApi ?? modelCapabilities?.api ?? resolvedApiForModel(provider);
  if (apiKind === 'anthropic-v1') {
    const next = stripInternalApiMessageFields({ ...body });
    if (anthropicThinkingEnabled(next)) {
      delete next.temperature;
      delete next.top_p;
      delete next.top_k;
    }
    return next;
  }

  if (apiKind !== 'openai-v1') {
    return stripInternalApiMessageFields(body);
  }

  const next = stripInternalApiMessageFields({ ...body });
  const templateKwargsReachModel = providerSupportsChatTemplateKwargs(provider);
  if (!providerKeepsExtendedSamplers(provider)) {
    delete next.top_k;
    delete next.min_p;
    delete next.repetition_penalty;
  }
  if (!templateKwargsReachModel && !providerKeepsExtendedSamplers(provider)) {
    delete next.enable_thinking;
  }

  const reasoningSupported =
    modelCapabilities?.reasoning === true ||
    (modelCapabilities?.reasoningAllowedOptions?.length ?? 0) > 0;
  if (!reasoningSupported) {
    if (!isThinkingExplicitlyDisabled(next.thinking)) {
      delete next.thinking;
    }
    delete next.reasoning;
    delete next.reasoning_effort;
  }

  if (
    reasoningSupported &&
    templateKwargsReachModel &&
    isThinkingExplicitlyDisabled(next.thinking)
  ) {
    next.reasoning_effort = 'none';
  }

  const modelId = typeof next.model === 'string' ? next.model : '';
  rewriteGlm53ThinkingBody(next, modelId);
  if (typeof next.max_tokens === 'number' && modelUsesMaxCompletionTokens(modelId)) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
  }

  if (modelRejectsTemperature(modelId)) {
    delete next.temperature;
    delete next.top_p;
  }

  if (provider.id !== LLAMA_CPP_LOCAL_PROVIDER_ID) {
    delete next.thinking_budget_tokens;
  }

  if (!templateKwargsReachModel) {
    delete next.chat_template_kwargs;
    delete next.preserve_thinking;
  }

  if (/kimi/i.test(modelId) && typeof next.temperature === 'number' && next.temperature !== 1) {
    next.temperature = 1;
  }

  if (/kimi|moonshot/i.test(modelId) && Array.isArray(next.messages)) {
    next.messages = next.messages.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const msg = { ...(raw as Record<string, unknown>) };
      delete msg.reasoning;
      delete msg.reasoning_content;
      delete msg.reasoning_signature;
      return msg;
    });
  } else {
    mapLocalReasoningReplay(next, provider.id);
  }

  return next;
}
