import { getProviderRuntime } from './store.js';
import { proxyModels } from './proxy.js';
import {
  capabilitiesFileExists,
  mergeCapabilities,
  readCapabilities,
  writeCapabilities,
} from './capabilities-store.js';
import { validateProviderId } from './validate.js';
import { generateText, streamText } from 'ai';
import { buildAnthropicProvider } from '../generations/anthropic/provider-runtime.js';
import { resolveModelApi } from '../generations/resolve-model-api.js';
import { agentCliCapabilityPatchesWithConfig } from '../models/agent-cli-catalog.js';
import { detectAgentCli } from '../models/agent-cli-detect.js';
import { openAiMessagesToCoreMessages } from '../generations/anthropic/openai-to-core-messages.js';
import { mapOpenAiToolChoice, mapOpenAiTools } from '../generations/anthropic/openai-tools.js';
import { resolveOpenCodeZenUpstreamUrl } from './opencode-zen.js';
import {
  mergeOpenCodeIdentityHeaders,
  OPENCODE_SESSION_PROBE,
} from './opencode-identity.js';
import { sanitizeCompletionBodyForProvider } from './sanitize-completion-body.js';
import { isLocalProviderBaseUrl } from './provider-host.js';
import {
  LLAMA_CPP_LOCAL_PROVIDER_ID,
  MLX_LM_LOCAL_PROVIDER_ID,
} from '../runner/provider-ids.js';
import { shouldUseOpenAiResponses } from '../../src/lib/openai-responses-route.mjs';
import { resolveCompatibleCompletionUrl } from '../generations/openai-responses/url.js';
import {
  chatCompletionBodyToResponses,
  responsesJsonToOpenAiCompletion,
} from '../generations/openai-responses/chat-to-responses.js';

const MAX_MODELS_PER_PROBE = 8;
const MODEL_PROBE_TIMEOUT_MS = 25_000;
const STRUCTURED_PROBE_TIMEOUT_MS = 30_000;

export const NO_LOADED_MODEL_MATRIX_PROBE_MSG =
  'No loaded model found. Load a model in LM Studio, then run the probe again.';

export const ANTHROPIC_STRUCTURED_PROBE_MSG =
  'Structured output probe is not supported for Anthropic Messages API (v1 bridge).';

const PROBE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
  },
  required: ['ok'],
  additionalProperties: false,
};

const PROBE_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAH0lEQVR42mP4jwQYkAAucYZBqGGQO48oDaPxMCg0AADZV36QzYI8swAAAABJRU5ErkJggg==';

const PROBE_INVALID_IMAGE_DATA_URL =
  'data:image/png;base64,bm90LWFuLWltYWdlLW1pbm5vdy1jYXBhYmlsaXR5LXByb2Jl';

/**
 * llama.cpp mtmd / CUDA signatures from a vision probe. A probed `vision: false`
 * would beat the id heuristic, so these must not stamp sources.vision = 'probe'.
 */
const VISION_PROBE_CRASH_RE =
  /\bmtmd\b|ffprobe|cuda error|cuda_error|ggml-cuda|failed to decode buffer as either image/i;

const DUMMY_TOOL = {
  type: 'function',
  function: {
    name: 'ping',
    description: 'Capability probe',
    parameters: { type: 'object', properties: {} },
  },
};

/**
 * @param {{ profile: { baseUrl: string }, paths: { chatCompletionsPath: string } }} runtime
 */
function resolveProbeChatCompletionsUrl(runtime) {
  return resolveOpenCodeZenUpstreamUrl(
    runtime.profile.baseUrl,
    runtime.paths.chatCompletionsPath,
  );
}

/**
 * Probe POST URL — Responses for OpenCode Go Muse/Luna/Grok 4.6 so we do not 500.
 *
 * @param {object} runtime
 * @param {string} modelId
 */
function resolveProbeCompletionUrl(runtime, modelId) {
  return resolveCompatibleCompletionUrl(
    runtime.profile.baseUrl,
    runtime.paths.chatCompletionsPath,
    modelId,
  );
}

/**
 * Map a chat-shaped probe body to Responses when the model requires it.
 *
 * @param {object} runtime
 * @param {string} modelId
 * @param {Record<string, unknown>} body
 */
function probeRequestBody(runtime, modelId, body) {
  if (!shouldUseOpenAiResponses(runtime.profile.baseUrl, modelId)) return body;
  return chatCompletionBodyToResponses(body);
}

/**
 * Unwrap Responses JSON so streaming/tools probes still read `choices`.
 *
 * @param {object} runtime
 * @param {string} modelId
 * @param {{ ok: boolean, json: unknown, [key: string]: unknown }} result
 */
function unwrapProbeResult(runtime, modelId, result) {
  if (!result.json || typeof result.json !== 'object') return result;
  if (Array.isArray(/** @type {{ choices?: unknown }} */ (result.json).choices)) {
    return result;
  }
  if (!shouldUseOpenAiResponses(runtime.profile.baseUrl, modelId)) return result;
  try {
    return {
      ...result,
      json: responsesJsonToOpenAiCompletion(result.json, modelId),
    };
  } catch {
    return result;
  }
}

/**
 * @param {object} runtime
 * @param {Array<{ id: string }>} catalog
 * @param {{ selectedModelId?: string }} [options]
 */
function findOpenAiModelForStructuredProbe(runtime, catalog, options = {}) {
  const catalogById = new Map(catalog.map((m) => [m.id, m]));

  const explicitId =
    typeof options.modelId === 'string' && options.modelId.trim()
      ? options.modelId.trim()
      : undefined;
  if (explicitId) {
    const row = catalogById.get(explicitId) || { id: explicitId };
    if (shouldUseOpenAiResponses(runtime.profile?.baseUrl, row.id)) {
      return null;
    }
    if (resolveModelApi(runtime, row.id, row) === 'openai-v1') {
      return row.id;
    }
  }

  const prioritized = prioritizeModelIds(
    catalog.map((m) => m.id),
    options.selectedModelId,
    catalog,
  );
  for (const id of prioritized) {
    const row = catalogById.get(id) || { id };
    if (shouldUseOpenAiResponses(runtime.profile?.baseUrl, row.id)) {
      continue;
    }
    if (resolveModelApi(runtime, row.id, row) === 'openai-v1') {
      return id;
    }
  }
  return null;
}

/**
 * @param {object} runtime
 * @param {string} probeModelId
 * @param {object} responseFormat
 * @param {{ stream?: boolean, tools?: unknown[], tool_choice?: string }} [extra]
 */
function buildStructuredProbeBody(runtime, probeModelId, responseFormat, extra = {}) {
  const base = sanitizeCompletionBodyForProvider(
    {
      model: probeModelId,
      messages: [{ role: 'user', content: 'Reply with JSON: {"ok":true}' }],
      max_tokens: 64,
      stream: extra.stream === true,
      response_format: responseFormat,
      ...(extra.tools ? { tools: extra.tools, tool_choice: extra.tool_choice ?? 'auto' } : {}),
    },
    runtime.profile,
    null,
  );
  return base;
}

/**
 * @param {object} runtime
 * @param {string} probeModelId
 */
async function runStructuredOutputHttpProbe(runtime, probeModelId) {
  const url = resolveProbeChatCompletionsUrl(runtime);
  const jsonSchemaFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'probe_ok',
      strict: false,
      schema: PROBE_SCHEMA,
    },
  };
  const jsonObjectFormat = { type: 'json_object' };

  const structuredOnlySchema = await postStructuredProbeCompletion({
    url,
    headers: runtime.headers,
    body: buildStructuredProbeBody(runtime, probeModelId, jsonSchemaFormat),
  });

  let structuredOnly = structuredOnlySchema;
  let usedJsonObjectFallback = false;
  if (!structuredOnly.ok) {
    structuredOnly = await postStructuredProbeCompletion({
      url,
      headers: runtime.headers,
      body: buildStructuredProbeBody(runtime, probeModelId, jsonObjectFormat),
    });
    usedJsonObjectFallback = structuredOnly.ok;
  }

  const withTools = await postStructuredProbeCompletion({
    url,
    headers: runtime.headers,
    body: buildStructuredProbeBody(runtime, probeModelId, jsonSchemaFormat, {
      tools: [DUMMY_TOOL],
      tool_choice: 'auto',
    }),
  });

  const streaming = await postStructuredProbeCompletion({
    url,
    headers: runtime.headers,
    body: buildStructuredProbeBody(runtime, probeModelId, jsonSchemaFormat, {
      stream: true,
      tools: [DUMMY_TOOL],
      tool_choice: 'auto',
    }),
  });

  const probeError =
    !structuredOnly.ok && !withTools.ok
      ? structuredOnly.error || withTools.error || `HTTP ${structuredOnly.status}`
      : null;

  return {
    structuredOnly,
    withTools,
    streaming,
    probeError,
    usedJsonObjectFallback,
  };
}

/**
 * @param {string[]} modelIds
 * @param {string | undefined} selectedModelId
 * @param {Array<{ id: string, state?: string }>} catalog
 */
export function prioritizeModelIds(modelIds, selectedModelId, catalog = []) {
  const unique = [...new Set(modelIds.filter((id) => typeof id === 'string' && id.trim()))];
  const loaded = new Set(
    catalog.filter((m) => m.state === 'loaded').map((m) => m.id),
  );

  const score = (id) => {
    if (selectedModelId && id === selectedModelId) return 0;
    if (loaded.has(id)) return 1;
    return 2;
  };

  return unique
    .sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa - sb;
      return a.localeCompare(b);
    })
    .slice(0, MAX_MODELS_PER_PROBE);
}

/**
 * @param {object} row
 */
function catalogRowHasVision(row) {
  return row.type === 'vlm' || row.catalogVision === true;
}

function ingestFromCatalog(row) {
  const vision = catalogRowHasVision(row);
  const contextLength =
    typeof row.loaded_context_length === 'number' && row.loaded_context_length > 0
      ? row.loaded_context_length
      : typeof row.max_context_length === 'number' && row.max_context_length > 0
        ? row.max_context_length
        : null;

  const loadState =
    typeof row.state === 'string' && row.state.trim() ? row.state.trim() : 'unknown';

  return {
    vision,
    tools: null,
    streaming: null,
    grammar: null,
    reasoning: null,
    contextLength,
    loadState,
    sources: {
      vision: 'catalog',
      contextLength: contextLength !== null ? 'catalog' : undefined,
      loadState: 'catalog',
    },
    probeErrors: {},
  };
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {object} body
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal
 */
async function postChatCompletion(url, headers, body, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const linked = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', linked, { once: true });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: mergeOpenCodeIdentityHeaders(
        {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers,
        },
        { baseUrl: url, sessionId: OPENCODE_SESSION_PROBE },
      ),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', linked);
  }
}

/**
 * Vision POST that treats a dropped connection as a runtime crash, not a throw
 * that would wipe tools/streaming results already recorded on this model.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {object} body
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal
 */
async function postVisionProbeCompletion(url, headers, body, timeoutMs, signal) {
  try {
    return await postChatCompletion(url, headers, body, timeoutMs, signal);
  } catch (err) {
    // Parent abort (user cancelled / drain aborted) must still unwind the probe.
    if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) {
      throw err;
    }
    return {
      ok: false,
      status: 0,
      json: null,
      text: err instanceof Error ? err.message : String(err),
      networkError: true,
    };
  }
}

/**
 * @param {{ url: string, headers: Record<string, string>, body: object }} params
 */
async function postStructuredProbeCompletion({ url, headers, body }) {
  const result = await postChatCompletion(
    url,
    headers,
    body,
    STRUCTURED_PROBE_TIMEOUT_MS,
    undefined,
  );
  if (result.ok) {
    return { ok: true, status: result.status };
  }
  return {
    ok: false,
    status: result.status,
    error: result.text?.slice(0, 300) || `HTTP ${result.status}`,
  };
}

/**
 * @param {unknown} json
 */
function responseHasToolCalls(json) {
  if (!json || typeof json !== 'object') return false;
  const choices = /** @type {{ choices?: unknown[] }} */ (json).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = choices[0];
  if (!first || typeof first !== 'object') return false;
  const message = /** @type {{ message?: { tool_calls?: unknown[] } }} */ (first).message;
  if (message?.tool_calls && message.tool_calls.length > 0) return true;
  const finish = /** @type {{ finish_reason?: string }} */ (first).finish_reason;
  return finish === 'tool_calls';
}

/**
 * @param {object} cap
 * @param {{ ok: boolean, json: unknown }} result
 */
function applyStreamingProbe(cap, result) {
  if (result.ok) {
    cap.streaming = true;
    cap.sources = { ...cap.sources, streaming: 'probe' };
  } else {
    cap.streaming = false;
    cap.sources = { ...cap.sources, streaming: 'probe' };
    cap.probeErrors = { ...cap.probeErrors, streaming: 'chat probe failed' };
  }
}

/**
 * @param {object} cap
 * @param {{ ok: boolean, json: unknown }} result
 */
function applyToolsProbe(cap, result) {
  const hasTools = result.ok && responseHasToolCalls(result.json);
  cap.tools = hasTools;
  cap.sources = { ...cap.sources, tools: 'probe' };
  if (!result.ok) {
    cap.probeErrors = { ...cap.probeErrors, tools: 'tool probe failed' };
  }
}

/**
 * True when this provider decodes image_url locally (llama.cpp mtmd, mlx-lm).
 * Cloud passthrough gateways are the opposite: they 200 any content part.
 *
 * @param {{ id?: string, baseUrl?: string }} [profile]
 */
export function providerDecodesVisionLocally(profile) {
  const id = typeof profile?.id === 'string' ? profile.id.trim() : '';
  if (id === LLAMA_CPP_LOCAL_PROVIDER_ID || id === MLX_LM_LOCAL_PROVIDER_ID) {
    return true;
  }
  return isLocalProviderBaseUrl(profile?.baseUrl);
}

/**
 * Corrupt-image control is for remote openai-v1 gateways. Loopback llama.cpp
 * decodes the buffer, so the garbage PNG logs ffprobe and can CUDA-fault --mmproj.
 *
 * @param {{ id?: string, baseUrl?: string }} [profile]
 */
export function shouldSendCorruptImageVisionControl(profile) {
  return !providerDecodesVisionLocally(profile);
}

/**
 * First-load auto-probe skips image_url on loopback openai-v1 (MIN-839).
 * LM Studio keeps auto vision: its catalog names VLMs and a rejected PNG is a clean 4xx.
 *
 * @param {{ id?: string, baseUrl?: string, apiKind?: string }} [profile]
 */
export function shouldSkipAutoVisionCapabilityProbe(profile) {
  if (profile?.apiKind === 'lm-studio-v0') return false;
  return providerDecodesVisionLocally(profile);
}

/**
 * @param {{ ok?: boolean, status?: number, text?: string, networkError?: boolean }} [result]
 */
export function isVisionProbeRuntimeCrash(result) {
  if (!result) return false;
  const text = typeof result.text === 'string' ? result.text : '';
  if (VISION_PROBE_CRASH_RE.test(text)) return true;
  // Text ping already succeeded; a dropped connection on image_url is a runtime
  // crash (projector / CUDA), not a clean "this model has no vision" 4xx.
  return result.networkError === true;
}

/**
 * @param {object} cap
 * @param {{ ok: boolean, status: number, text?: string, networkError?: boolean }} result
 * @param {{ ok: boolean, status: number, text?: string }} [control]
 */
export function applyVisionProbe(cap, result, control) {
  if (cap.vision === true) return;

  if (isVisionProbeRuntimeCrash(result)) {
    cap.probeErrors = {
      ...cap.probeErrors,
      vision:
        result.text?.trim().slice(0, 200) ||
        'image probe crashed the local runtime — vision left unset',
    };
    return;
  }

  if (!result.ok) {
    cap.vision = false;
    cap.sources = { ...cap.sources, vision: 'probe' };
    cap.probeErrors = {
      ...cap.probeErrors,
      vision: result.text?.trim().slice(0, 200) || `image probe rejected (HTTP ${result.status})`,
    };
    return;
  }

  if (control?.ok) {
    cap.probeErrors = {
      ...cap.probeErrors,
      vision:
        'endpoint also accepted a corrupt image — image input is passed through, not decoded',
    };
    return;
  }

  cap.vision = true;
  cap.sources = { ...cap.sources, vision: 'probe' };
}

/**
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal
 */
function createProbeAbortSignal(timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * @param {object} modelRow
 * @param {{ profile: object, headers: Record<string, string>, paths: object, secrets: object }} runtime
 * @param {AbortSignal | undefined} signal
 * @param {{ skipVision?: boolean }} [probeOptions]
 */
async function probeAnthropicModelCapabilities(modelRow, runtime, signal, probeOptions = {}) {
  const cap = ingestFromCatalog(modelRow);
  const modelId = modelRow.id;
  const anthropic = buildAnthropicProvider(runtime);
  const messages = openAiMessagesToCoreMessages([{ role: 'user', content: 'ping' }]);

  const streamProbe = createProbeAbortSignal(MODEL_PROBE_TIMEOUT_MS, signal);
  try {
    const result = streamText({
      model: anthropic(modelId),
      messages,
      maxOutputTokens: 1,
      abortSignal: streamProbe.signal,
    });
    let gotStream = false;
    for await (const _part of result.fullStream) {
      gotStream = true;
      break;
    }
    applyStreamingProbe(cap, { ok: gotStream, json: null });
  } catch {
    applyStreamingProbe(cap, { ok: false, json: null });
  } finally {
    streamProbe.dispose();
  }

  const toolBody = [
    {
      type: 'function',
      function: {
        name: 'probe_noop',
        description: 'Capability probe noop',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
  const tools = mapOpenAiTools(toolBody);
  const toolProbe = createProbeAbortSignal(MODEL_PROBE_TIMEOUT_MS, signal);
  try {
    const result = await generateText({
      model: anthropic(modelId),
      messages,
      tools,
      toolChoice: mapOpenAiToolChoice('auto'),
      maxOutputTokens: 64,
      abortSignal: toolProbe.signal,
    });
    const hasTools = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
    cap.tools = hasTools;
    cap.sources = { ...cap.sources, tools: 'probe' };
    if (!hasTools) {
      cap.probeErrors = { ...cap.probeErrors, tools: 'tool probe returned no tool calls' };
    }
  } catch {
    cap.tools = false;
    cap.sources = { ...cap.sources, tools: 'probe' };
    cap.probeErrors = { ...cap.probeErrors, tools: 'tool probe failed' };
  } finally {
    toolProbe.dispose();
  }

  if (!probeOptions.skipVision && cap.streaming === true && cap.vision !== true) {
    /** @param {string} dataUrl */
    const runImageProbe = async (dataUrl) => {
      const probe = createProbeAbortSignal(MODEL_PROBE_TIMEOUT_MS, signal);
      try {
        await generateText({
          model: anthropic(modelId),
          messages: openAiMessagesToCoreMessages([
            {
              role: 'user',
              content: [
                { type: 'text', text: 'ping' },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ]),
          maxOutputTokens: 1,
          abortSignal: probe.signal,
        });
        return { ok: true, status: 200 };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) {
          throw err;
        }
        const text = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          status: 0,
          text,
          // SDK throws on 4xx as well as transport failure; only mark a crash
          // when the message looks like mtmd/CUDA or a dropped connection.
          networkError: /fetch failed|econnreset|socket hang up|network/i.test(text),
        };
      } finally {
        probe.dispose();
      }
    };

    const visionResult = await runImageProbe(PROBE_IMAGE_DATA_URL);
    const sendControl =
      visionResult.ok &&
      !isVisionProbeRuntimeCrash(visionResult) &&
      shouldSendCorruptImageVisionControl(runtime.profile);
    const controlResult = sendControl
      ? await runImageProbe(PROBE_INVALID_IMAGE_DATA_URL)
      : undefined;
    applyVisionProbe(cap, visionResult, controlResult);
  }

  return cap;
}

/**
 * @param {object} modelRow
 * @param {{ profile: object, headers: Record<string, string>, paths: object }} runtime
 * @param {AbortSignal | undefined} signal
 * @param {{ skipVision?: boolean }} [probeOptions]
 */
async function probeModelCapabilities(modelRow, runtime, signal, probeOptions = {}) {
  const cap = ingestFromCatalog(modelRow);
  const resolvedApi = resolveModelApi(runtime, modelRow.id, modelRow);
  cap.api = resolvedApi;
  const isLmStudio = runtime.profile.apiKind === 'lm-studio-v0';
  if (isLmStudio && !isCatalogModelLoaded(modelRow)) {
    return cap;
  }

  if (resolvedApi === 'anthropic-v1') {
    return probeAnthropicModelCapabilities(modelRow, runtime, signal, probeOptions);
  }

  const modelId = modelRow.id;
  const url = resolveProbeCompletionUrl(runtime, modelId);

  const chatBody = probeRequestBody(runtime, modelId, {
    model: modelId,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
  });

  const chatResult = unwrapProbeResult(
    runtime,
    modelId,
    await postChatCompletion(
      url,
      runtime.headers,
      chatBody,
      MODEL_PROBE_TIMEOUT_MS,
      signal,
    ),
  );
  applyStreamingProbe(cap, chatResult);

  const toolBody = probeRequestBody(runtime, modelId, {
    model: modelId,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
    tools: [
      {
        type: 'function',
        function: {
          name: 'probe_noop',
          description: 'Capability probe noop',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    tool_choice: 'auto',
  });

  const toolResult = unwrapProbeResult(
    runtime,
    modelId,
    await postChatCompletion(
      url,
      runtime.headers,
      toolBody,
      MODEL_PROBE_TIMEOUT_MS,
      signal,
    ),
  );
  applyToolsProbe(cap, toolResult);

  if (!probeOptions.skipVision && chatResult.ok && cap.vision !== true) {
    const imageProbeBody = (dataUrl) =>
      probeRequestBody(runtime, modelId, {
        model: modelId,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'ping' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 1,
        stream: false,
      });

    const visionResult = unwrapProbeResult(
      runtime,
      modelId,
      await postVisionProbeCompletion(
        url,
        runtime.headers,
        imageProbeBody(PROBE_IMAGE_DATA_URL),
        MODEL_PROBE_TIMEOUT_MS,
        signal,
      ),
    );
    const sendControl =
      visionResult.ok &&
      !isVisionProbeRuntimeCrash(visionResult) &&
      shouldSendCorruptImageVisionControl(runtime.profile);
    const controlResult = sendControl
      ? unwrapProbeResult(
          runtime,
          modelId,
          await postVisionProbeCompletion(
            url,
            runtime.headers,
            imageProbeBody(PROBE_INVALID_IMAGE_DATA_URL),
            MODEL_PROBE_TIMEOUT_MS,
            signal,
          ),
        )
      : undefined;
    applyVisionProbe(cap, visionResult, controlResult);
  }

  return cap;
}

/**
 * @param {string} providerId
 * @param {{ modelIds?: string[], selectedModelId?: string, signal?: AbortSignal, auto?: boolean, skipVision?: boolean }} [options]
 */
export async function runCapabilityProbe(providerId, options = {}) {
  validateProviderId(providerId);
  const runtime = await getProviderRuntime(providerId);
  if (runtime.profile.enabled === false) {
    throw new Error('Provider is disabled');
  }

  if (runtime.profile.apiKind === 'agent-cli-v1') {
    const cliStatus = await detectAgentCli(runtime.profile.agentCli.kind, {
      binPath: runtime.profile.agentCli?.binPath,
      cliToken: runtime.secrets?.cliToken,
    });
    return mergeCapabilities(providerId, await agentCliCapabilityPatchesWithConfig(providerId, {
      binPath: runtime.profile.agentCli?.binPath,
      cliToken: runtime.secrets?.cliToken,
      cliVersion: cliStatus.version,
    }), {
      probedAt: new Date().toISOString(),
      apiKind: 'agent-cli-v1',
      providerFields: {
        structuredOutput: false,
        structuredOutputWithTools: false,
        structuredOutputStreaming: false,
        supportsThinkingBudget: false,
        probeError: null,
      },
    });
  }

  const modelsResponse = await proxyModels(providerId);
  const catalog = Array.isArray(modelsResponse.data) ? modelsResponse.data : [];
  const isLmStudio = runtime.profile.apiKind === 'lm-studio-v0';

  let allIds;
  if (options.modelIds?.length) {
    allIds = options.modelIds;
  } else if (isLmStudio) {
    allIds = catalog.filter(isCatalogModelLoaded).map((m) => m.id);
    if (allIds.length === 0) {
      throw new Error(NO_LOADED_MODEL_MATRIX_PROBE_MSG);
    }
  } else {
    allIds = catalog.map((m) => m.id);
  }

  const prioritized = prioritizeModelIds(
    allIds,
    options.selectedModelId,
    catalog,
  );

  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const patches = {};
  const probedAt = new Date().toISOString();
  const targeted = Boolean(options.modelIds?.length);
  // First-load (auto) skips image_url on loopback openai-v1 so --mmproj is not
  // hit until the user clicks Probe models. Manual probes still send a valid PNG.
  const skipVision =
    options.skipVision === true ||
    (options.auto === true && shouldSkipAutoVisionCapabilityProbe(runtime.profile));

  for (const modelId of prioritized) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const row = catalogById.get(modelId) || { id: modelId, type: 'llm' };
    try {
      patches[modelId] = await probeModelCapabilities(row, runtime, options.signal, {
        skipVision,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      const base = ingestFromCatalog(row);
      base.probeErrors = {
        ...base.probeErrors,
        probe: err instanceof Error ? err.message : String(err),
      };
      patches[modelId] = base;
    }
  }

  if (!targeted) {
    for (const row of catalog) {
      if (patches[row.id]) continue;
      patches[row.id] = ingestFromCatalog(row);
    }
  }

  return mergeCapabilities(providerId, patches, {
    probedAt,
    apiKind: runtime.profile.apiKind,
  });
}

/**
 * @param {{ state?: string }} row
 */
function isCatalogModelLoaded(row) {
  return typeof row.state === 'string' && row.state.trim().toLowerCase() === 'loaded';
}

/**
 * @param {string} providerId
 * @param {{ modelId?: string, selectedModelId?: string }} [options]
 */
export async function resolveStructuredProbeModelId(providerId, options = {}) {
  const runtime = await getProviderRuntime(providerId);
  const modelsResponse = await proxyModels(providerId);
  const catalog = Array.isArray(modelsResponse.data) ? modelsResponse.data : [];
  const isLmStudio = runtime.profile.apiKind === 'lm-studio-v0';
  const candidateRows = isLmStudio ? catalog.filter(isCatalogModelLoaded) : catalog;
  const candidateIds = candidateRows.map((m) => m.id);

  const explicit =
    typeof options.modelId === 'string' && options.modelId.trim()
      ? options.modelId.trim()
      : undefined;

  if (explicit) {
    if (!candidateIds.includes(explicit)) {
      const msg = isLmStudio
        ? `Model "${explicit}" is not loaded. Load it in your backend, then run the structured-output probe again.`
        : `Model "${explicit}" was not found in the provider catalog. Refresh models, then run the structured-output probe again.`;
      throw new Error(msg);
    }
    return explicit;
  }

  const selected =
    typeof options.selectedModelId === 'string' && options.selectedModelId.trim()
      ? options.selectedModelId.trim()
      : undefined;

  const pick = prioritizeModelIds(candidateIds, selected, catalog)[0];
  if (!pick) {
    const msg = isLmStudio
      ? 'No loaded model found. Load a model in LM Studio (or your backend), then run the structured-output probe again.'
      : 'No models found in provider catalog. Refresh models, then run the structured-output probe again.';
    throw new Error(msg);
  }
  return pick;
}

/**
 * @param {string} id
 */
export async function readProviderCapabilitiesFile(id) {
  if (!(await capabilitiesFileExists(id))) {
    return null;
  }
  const file = await readCapabilities(id);
  if (!file.probedAt?.trim() && !file.structuredOutput && !file.structuredOutputWithTools) {
    return null;
  }
  return file;
}

/**
 * @param {string} id
 * @param {{ modelId?: string, selectedModelId?: string }} [options]
 */
export async function probeProviderCapabilities(id, options = {}) {
  validateProviderId(id);
  const runtime = await getProviderRuntime(id);

  if (runtime.profile.apiKind === 'agent-cli-v1') {
    const cliStatus = await detectAgentCli(runtime.profile.agentCli.kind, {
      binPath: runtime.profile.agentCli?.binPath,
      cliToken: runtime.secrets?.cliToken,
    });
    return mergeCapabilities(id, await agentCliCapabilityPatchesWithConfig(id, {
      binPath: runtime.profile.agentCli?.binPath,
      cliToken: runtime.secrets?.cliToken,
      cliVersion: cliStatus.version,
    }), {
      probedAt: new Date().toISOString(),
      apiKind: 'agent-cli-v1',
      providerFields: {
        structuredOutput: false,
        structuredOutputWithTools: false,
        structuredOutputStreaming: false,
        supportsThinkingBudget: false,
        probeError: null,
      },
    });
  }

  const modelsResponse = await proxyModels(id);
  const catalog = Array.isArray(modelsResponse.data) ? modelsResponse.data : [];
  const prioritized = prioritizeModelIds(
    catalog.map((m) => m.id),
    options.selectedModelId,
    catalog,
  );
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const modelId =
    typeof options.modelId === 'string' && options.modelId.trim()
      ? options.modelId.trim()
      : prioritized[0];
  const modelRow = modelId ? catalogById.get(modelId) || { id: modelId } : null;
  const resolvedApi = modelRow
    ? resolveModelApi(runtime, modelRow.id, modelRow)
    : runtime.profile.apiKind;

  if (resolvedApi === 'anthropic-v1') {
    const existing = await readCapabilities(id);
    const models = { ...existing.models };
    if (modelId) {
      models[modelId] = {
        ...(models[modelId] || {}),
        api: 'anthropic-v1',
        structuredOutput: false,
        denyReason: ANTHROPIC_STRUCTURED_PROBE_MSG,
      };
    }

    const openAiProbeModelId = findOpenAiModelForStructuredProbe(runtime, catalog, options);
    if (openAiProbeModelId) {
      const probeResults = await runStructuredOutputHttpProbe(runtime, openAiProbeModelId);
      models[openAiProbeModelId] = {
        ...(models[openAiProbeModelId] || {}),
        structuredOutput: probeResults.withTools.ok || probeResults.structuredOnly.ok,
        denyReason: null,
      };
      return writeCapabilities(id, {
        ...existing,
        providerId: id,
        probedAt: new Date().toISOString(),
        apiKind: runtime.profile.apiKind,
        structuredOutput: probeResults.structuredOnly.ok,
        structuredOutputWithTools: probeResults.withTools.ok,
        structuredOutputStreaming: probeResults.streaming.ok,
        probeError: probeResults.probeError,
        models,
      });
    }

    return writeCapabilities(id, {
      ...existing,
      providerId: id,
      probedAt: new Date().toISOString(),
      apiKind: runtime.profile.apiKind,
      models,
    });
  }

  const probeModelId = await resolveStructuredProbeModelId(id, options);
  const probeResults = await runStructuredOutputHttpProbe(runtime, probeModelId);

  const existing = await readCapabilities(id);
  const models = { ...existing.models };

  if (probeModelId) {
    models[probeModelId] = {
      ...(models[probeModelId] || {}),
      structuredOutput: probeResults.withTools.ok || probeResults.structuredOnly.ok,
      denyReason: null,
    };
  }

  return writeCapabilities(id, {
    ...existing,
    providerId: id,
    probedAt: new Date().toISOString(),
    apiKind: runtime.profile.apiKind,
    structuredOutput: probeResults.structuredOnly.ok,
    structuredOutputWithTools: probeResults.withTools.ok,
    structuredOutputStreaming: probeResults.streaming.ok,
    probeError: probeResults.probeError,
    models,
  });
}
