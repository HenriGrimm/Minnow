import { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID } from '../../src/models/runtime-ids.mjs';
import { providerSupportsChatTemplateKwargs } from './provider-host.js';

/**
 * @param {string} modelId
 */
function modelUsesMaxCompletionTokens(modelId) {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  if (/^o\d/.test(id)) return true;
  return id.includes('gpt-5');
}

/**
 * @param {unknown} thinking
 */
function isThinkingExplicitlyDisabled(thinking) {
  if (!thinking || typeof thinking !== 'object') return false;
  return /** @type {{ type?: string }} */ (thinking).type === 'disabled';
}

/**
 * @param {string} modelId
 */
function isGlm53ModelId(modelId) {
  if (!modelId) return false;
  return /(?:^|[^a-z0-9])glm[-_.]?5[._-]?3(?:[^0-9]|$)/i.test(modelId);
}

/**
 * @param {Record<string, unknown>} next
 * @param {string} modelId
 */
function rewriteGlm53ThinkingBody(next, modelId) {
  if (!isGlm53ModelId(modelId)) return;
  const rawEffort = typeof next.reasoning_effort === 'string' ? next.reasoning_effort : undefined;
  let wire = 'low';
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
    const nextKwargs = { ...kwargs };
    if (nextKwargs.enable_thinking === false) nextKwargs.enable_thinking = true;
    nextKwargs.reasoning_effort = wire;
    next.chat_template_kwargs = nextKwargs;
  }
}

/**
 * @param {string} modelId
 */
function modelRejectsTemperature(modelId) {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  if (/^o\d/.test(id)) return true;
  return id.includes('gpt-5');
}

function stripInternalApiMessageFields(body) {
  if (!Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: body.messages.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const msg = { ...raw };
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
 * @param {Record<string, unknown>} next
 * @param {string} providerId
 */
function mapLocalReasoningReplay(next, providerId) {
  if (providerId !== LLAMA_CPP_LOCAL_ID && providerId !== MLX_LM_LOCAL_ID) return;
  if (!Array.isArray(next.messages)) return;
  next.messages = next.messages.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    if (raw.role !== 'assistant' || typeof raw.reasoning !== 'string') return raw;
    const msg = { ...raw };
    if (typeof msg.reasoning_content !== 'string' || !msg.reasoning_content) {
      msg.reasoning_content = msg.reasoning;
    }
    delete msg.reasoning;
    return msg;
  });
}

/**
 * @param {{ id?: string, supportsExtendedSamplers?: boolean }} provider
 */
function providerKeepsExtendedSamplers(provider) {
  if (provider?.supportsExtendedSamplers === true) return true;
  const id = typeof provider?.id === 'string' ? provider.id : '';
  return id === LLAMA_CPP_LOCAL_ID || id === MLX_LM_LOCAL_ID;
}

/**
 * @param {Record<string, unknown>} body
 * @param {{ apiKind?: string, id?: string, supportsExtendedSamplers?: boolean, baseUrl?: string }} provider
 * @param {{ reasoning?: boolean, reasoningAllowedOptions?: string[] } | null | undefined} [modelCapabilities]
 * @returns {Record<string, unknown>}
 */
export function sanitizeCompletionBodyForProvider(body, provider, modelCapabilities) {
  const providerId = typeof provider.id === 'string' ? provider.id : '';
  if (provider.apiKind !== 'openai-v1') {
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

  if (/kimi/i.test(modelId) && typeof next.temperature === 'number' && next.temperature !== 1) {
    next.temperature = 1;
  }

  if (/kimi|moonshot/i.test(modelId) && Array.isArray(next.messages)) {
    next.messages = next.messages.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const msg = { ...raw };
      delete msg.reasoning;
      delete msg.reasoning_content;
      delete msg.reasoning_signature;
      return msg;
    });
  } else {
    mapLocalReasoningReplay(next, providerId);
  }

  if (modelRejectsTemperature(modelId)) {
    delete next.temperature;
    delete next.top_p;
  }

  if (providerId !== LLAMA_CPP_LOCAL_ID) {
    delete next.thinking_budget_tokens;
  }

  if (!templateKwargsReachModel) {
    delete next.chat_template_kwargs;
    delete next.preserve_thinking;
  }

  return next;
}
