import { ChatContractError, resolveModelSelection, validateModelOptions, validateModelSelection } from './contracts.js';
import { ensureGlm53ReasoningAllowedOptions, ensureQwen38ReasoningAllowedOptions, normalizeReasoningAllowedOptions } from '../runner/reasoning-effort.js';

export const AGENT_POOL_PROVIDER_ID = 'minnow-router';
export const AGENT_LIBRARY_PROVIDER_ID = 'minnow-library';

function parsed(result) {
  if (!result.ok) throw new ChatContractError(result.error.code, result.error.message, { path: result.error.path });
  return result.value;
}

function abort(context) { context.signal?.throwIfAborted(); }
function unavailable(message) { throw new ChatContractError('model_unavailable', message); }
function unsupported(message) { throw new ChatContractError('options_unsupported', message); }
function text(value, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : fallback; }
function samePair(a, b) { return a?.providerId === b?.providerId && a?.modelId === b?.modelId; }

/** Production reads are lazy; callers can replace them without touching a live profile. */
export function createAgentModelAdapters(overrides = {}) {
  return {
    listProviders: async () => (await import('../providers/store.js')).listProviders(),
    listModels: async (id) => (await import('../providers/proxy.js')).proxyModels(id),
    readCapabilities: async (id) => (await import('../providers/capabilities-store.js')).readCapabilities(id),
    listPools: async () => {
      const store = await (await import('../model-routers/store.js')).getRouterWorkspace();
      return { routers: store.routers, revision: store.revision };
    },
    resolvePoolId: async (id, workspacePath) => (await import('../model-routers/store.js')).resolveRouterId(id, workspacePath),
    poolAvailability: async (pool, request) => (await import('../model-routers/availability.js')).routerAvailability(pool, request),
    listLibraryModels: async () => (await import('../models/cached.js')).listCachedModels(),
    resolveLibraryTarget: async (id) => (await import('../models/library-binding.js')).resolveLibraryCachedTarget(id),
    listServes: async () => (await import('../models/serve.js')).listServes(),
    listAgentTypes: async () => (await import('../sub-agents/config.js')).loadSubAgentFile(),
    modelAvailability: async (selection) => {
      const { getAllowanceTracker, allowanceContext } = await import('../generations/allowance.js');
      return (await getAllowanceTracker()).availability(await allowanceContext(selection.providerId, selection.modelId));
    },
    ...overrides,
  };
}

/** No model-name guessing beyond the reasoning catalog normalization shared by the runner. */
export function modelOptionSupport(model, providerCapabilities = {}, provider = {}) {
  const modelId = model?.id ?? '';
  const probed = providerCapabilities.models?.[modelId] ?? {};
  const rowCaps = model?.capabilities ?? {};
  const reasoning = probed.reasoning === false ? false : probed.reasoning === true || rowCaps.reasoning === true || model?.reasoning === true || typeof model?.reasoning === 'object';
  const raw = model?.reasoning?.allowed_options ?? rowCaps.reasoningAllowedOptions ?? [];
  const allowed = probed.reasoning === false ? [] : ensureGlm53ReasoningAllowedOptions(modelId,
    ensureQwen38ReasoningAllowedOptions(modelId, normalizeReasoningAllowedOptions(Array.isArray(raw) ? raw : [], modelId)));
  const knownReasoning = reasoning || allowed.length > 0;
  const alwaysOn = allowed.length > 0 && !allowed.includes('off') && allowed.some((value) => value !== 'on');
  const thinkingModes = ['inherit'];
  if (knownReasoning) thinkingModes.push('on');
  if (probed.reasoning === false || model?.reasoning === false || (knownReasoning && !alwaysOn)) thinkingModes.push('off');
  const nativeBudget = providerCapabilities.supportsThinkingBudget === true || rowCaps.supportsThinkingBudget === true;
  const budget = nativeBudget ? 'native' : knownReasoning && provider.apiKind !== 'agent-cli-v1' ? 'runner' : null;
  return Object.freeze({
    reasoningEffort: Object.freeze([...allowed]),
    thinkingMode: Object.freeze(thinkingModes),
    thinkingBudgetTokens: Object.freeze({ supported: budget !== null, enforcement: budget }),
    sendCapabilities: Object.freeze({
      reasoning: knownReasoning && probed.reasoning !== false,
      reasoningAllowedOptions: Object.freeze([...allowed]),
      ...(text(model?.reasoning?.default ?? rowCaps.reasoningDefault) ? { reasoningDefault: text(model?.reasoning?.default ?? rowCaps.reasoningDefault) } : {}),
    }),
  });
}

export function assertSupportedModelOptions(options, support) {
  const value = parsed(validateModelOptions(options ?? {}));
  if (value.thinkingBudgetTokens === 0 && value.thinkingMode === undefined) value.thinkingMode = 'off';
  if (value.reasoningEffort !== undefined && !support.reasoningEffort.includes(value.reasoningEffort)) unsupported(`Reasoning effort ${value.reasoningEffort} is not advertised by the selected model`);
  if (value.thinkingMode !== undefined && !support.thinkingMode.includes(value.thinkingMode)) unsupported(`Thinking ${value.thinkingMode} is not supported or verified for the selected model`);
  if (value.thinkingBudgetTokens > 0 && !support.thinkingBudgetTokens.supported) unsupported('A thinking budget is not supported or verified for the selected model');
  if (value.thinkingMode === 'off' && value.reasoningEffort !== undefined && value.reasoningEffort !== 'off') unsupported('Thinking off conflicts with the selected reasoning effort');
  if (value.thinkingMode === 'on' && value.reasoningEffort === 'off') unsupported('Thinking on conflicts with reasoning off');
  return value;
}

function configuredPair(row, field, required = false) {
  if (!row || !text(row.modelId)) return null;
  if (!text(row.providerId)) {
    if (required) throw new ChatContractError('invalid_request', `Choose a complete provider/model pair for ${field}`);
    return null;
  }
  return parsed(validateModelSelection({ providerId: row.providerId, modelId: row.modelId, ...(Object.hasOwn(row, 'options') ? { options: row.options } : {}) }));
}

function typeOptions(type) {
  const options = { ...(type?.options ?? {}) };
  for (const key of ['reasoningEffort', 'thinkingMode', 'thinkingBudgetTokens']) {
    if (type?.[key] !== undefined && type[key] !== '' && !Object.hasOwn(options, key)) options[key] = type[key];
  }
  return parsed(validateModelOptions(options));
}

function overlayOptions(base, overrides = {}) {
  const result = { ...base };
  if (overrides.reasoningEffort !== undefined && !Object.hasOwn(overrides, 'thinkingMode')) delete result.thinkingMode;
  if (overrides.thinkingMode === 'off') {
    if (!Object.hasOwn(overrides, 'reasoningEffort')) delete result.reasoningEffort;
    if (!Object.hasOwn(overrides, 'thinkingBudgetTokens')) delete result.thinkingBudgetTokens;
  }
  if (overrides.thinkingBudgetTokens === 0 && !Object.hasOwn(overrides, 'thinkingMode')) {
    result.thinkingMode = 'off';
    if (!Object.hasOwn(overrides, 'reasoningEffort')) delete result.reasoningEffort;
  }
  return { ...result, ...overrides };
}

/** One read snapshot/cache per selection or discovery call, without session startup/model loading. */
export function createAgentCatalogContext(context = {}) {
  const adapters = createAgentModelAdapters(context.adapters);
  const catalogs = new Map();
  const capabilities = new Map();
  let providers;
  let library;
  let serves;
  let pools;
  const load = (map, id, read) => {
    if (!map.has(id)) map.set(id, Promise.resolve().then(() => { abort(context); return read(id); }));
    return map.get(id);
  };
  return {
    ...context,
    adapters,
    providers: () => providers ??= Promise.resolve().then(() => { abort(context); return adapters.listProviders(); }).then((result) => Array.isArray(result) ? result : result?.providers ?? []),
    catalog: (id) => load(catalogs, id, adapters.listModels),
    capabilities: (id) => load(capabilities, id, adapters.readCapabilities).catch(() => ({ models: {} })),
    library: () => library ??= Promise.resolve().then(() => { abort(context); return adapters.listLibraryModels(); }).then((value) => Array.isArray(value) ? value : value?.models ?? []),
    serves: () => serves ??= Promise.resolve().then(() => adapters.listServes()).catch(() => []),
    pools: () => pools ??= Promise.resolve().then(() => { abort(context); return adapters.listPools(); }),
  };
}

export function libraryCatalogModels(rows) {
  const models = [];
  for (const row of rows) {
    if (!row?.repo_id || row.is_diffusion || row.has_incomplete) continue;
    for (const file of row.gguf_files ?? []) {
      if (!file?.rel_path || file.role === 'projector' || /mmproj/i.test(file.name ?? '') || !/\.gguf$/i.test(file.rel_path) || (file.parts > 1 && file.part > 1)) continue;
      models.push({ id: `gguf:${row.repo_id}:${file.rel_path}`, name: `${row.repo_id} · ${file.quant ?? file.name ?? file.rel_path}`, catalogVision: (row.gguf_files ?? []).some((candidate) => candidate.role === 'projector' || /mmproj/i.test(candidate.name ?? '')), ...('reasoning' in row ? { reasoning: row.reasoning } : {}) });
    }
    if (row.mtplx_validated) models.push({ id: `mtplx:${row.repo_id}`, name: row.repo_id, ...('reasoning' in row ? { reasoning: row.reasoning } : {}) });
    else if (row.mlx_root) models.push({ id: `mlx:${row.repo_id}`, name: row.repo_id, ...('reasoning' in row ? { reasoning: row.reasoning } : {}) });
  }
  return [...new Map(models.map((row) => [row.id, row])).values()];
}

function checkRequestCapabilities(model, caps, request = {}) {
  const row = caps.models?.[model.id] ?? {};
  if (request.tools?.length && row.tools === false) unavailable('Tool calling is unsupported by the selected model');
  if (request.stream !== false && row.streaming === false) unavailable('Streaming is unsupported by the selected model');
  const images = request.messages?.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'));
  if (images && !verifiedVision(model, caps)) unavailable('Image input is unsupported or unverified for the selected model');
}

function verifiedVision(model, caps) {
  const probed = caps.models?.[model.id]?.vision;
  if (typeof probed === 'boolean') return probed;
  if (typeof model.capabilities?.vision === 'boolean') return model.capabilities.vision;
  return model.catalogVision === true || model.type === 'vlm';
}

export async function inspectAgentModel(selection, context = {}) {
  const snapshot = typeof context.catalog === 'function' ? context : createAgentCatalogContext(context);
  abort(snapshot);
  const selected = parsed(validateModelSelection(selection));
  if (selected.providerId === AGENT_LIBRARY_PROVIDER_ID) {
    const model = libraryCatalogModels(await snapshot.library()).find((row) => row.id === selected.modelId);
    if (!model || !await snapshot.adapters.resolveLibraryTarget(selected.modelId)) unavailable('The selected My Models artifact is missing or cannot be served');
    const [caps, serves] = await Promise.all([snapshot.capabilities(AGENT_LIBRARY_PROVIDER_ID), snapshot.serves()]);
    abort(snapshot);
    checkRequestCapabilities(model, caps, snapshot.request);
    const serve = serves.find((row) => row.libraryId === selected.modelId && ['running', 'starting', 'unhealthy'].includes(row.status));
    const availability = { state: serve?.status === 'running' ? 'available' : serve ? 'loading_model' : 'loadable', reason: serve?.status === 'running' ? 'Available' : serve ? 'Loading model' : 'Available to load' };
    return { model, provider: { id: AGENT_LIBRARY_PROVIDER_ID, label: 'My Models' }, capabilities: caps, support: modelOptionSupport(model, caps), availability, vision: verifiedVision(model, caps) };
  }
  const provider = (await snapshot.providers()).find((row) => row.id === selected.providerId);
  if (!provider || provider.enabled === false) unavailable('The selected provider is missing or disabled');
  let catalog;
  try { catalog = await snapshot.catalog(provider.id); }
  catch (error) { abort(snapshot); if (error?.name === 'AbortError') throw error; unavailable('The selected provider catalog is unavailable'); }
  abort(snapshot);
  if (catalog?.error || catalog?.unreachable) unavailable('The selected provider is unavailable or not authenticated');
  const model = (Array.isArray(catalog) ? catalog : catalog?.data ?? []).find((row) => row.id === selected.modelId);
  if (!model || model.enabled === false || ['embedding', 'embeddings', 'image', 'imagegen'].includes(model.type)) unavailable('The selected model is not advertised for chat by its provider');
  const caps = await snapshot.capabilities(provider.id);
  abort(snapshot);
  if (caps.models?.[model.id]?.denyReason) unavailable('The selected model is disabled by its current capabilities');
  checkRequestCapabilities(model, caps, snapshot.request);
  const health = await snapshot.adapters.modelAvailability(selected);
  abort(snapshot);
  const availability = health?.available === false
    ? { state: 'unavailable', reason: health.kind === 'quota' ? 'Provider usage limit reached' : 'The selected provider is temporarily unavailable' }
    : { state: 'available', reason: 'Available' };
  return { model, provider, capabilities: caps, support: modelOptionSupport(model, caps, provider), availability, vision: verifiedVision(model, caps) };
}

export async function inspectAgentPool(selection, context = {}) {
  const snapshot = typeof context.catalog === 'function' ? context : createAgentCatalogContext(context);
  const selected = parsed(validateModelSelection(selection));
  const id = await snapshot.adapters.resolvePoolId(selected.modelId, snapshot.workspacePath);
  const store = await snapshot.pools();
  const pool = (store?.routers ?? []).find((row) => row.id === id);
  if (!pool || pool.enabled === false) unavailable('The selected model pool is missing or disabled');
  const availability = await snapshot.adapters.poolAvailability(pool, snapshot.request ?? {});
  const enabled = pool.entries.filter((entry) => entry.enabled !== false);
  const members = [];
  for (const entry of enabled) {
    abort(snapshot);
    try {
      const inspected = await inspectAgentModel({ providerId: entry.providerId, modelId: entry.modelId }, snapshot);
      assertSupportedModelOptions(selected.options, inspected.support);
      members.push({ entry, ...inspected, available: availability[entry.id]?.available === true && inspected.availability.state !== 'unavailable' });
    } catch (error) {
      if (!(error instanceof ChatContractError)) throw error;
      if (error.code !== 'model_unavailable' && error.code !== 'options_unsupported') throw error;
    }
  }
  if (!members.length) {
    if (selected.options && Object.keys(selected.options).length) unsupported('No enabled pool member supports the requested model options');
    unavailable('The selected model pool has no available chat models');
  }
  const eligible = members.filter((member) => member.available);
  if (!eligible.length) unavailable('Every compatible model pool member is currently unavailable');
  return { pool, revision: store.revision ?? 0, members, eligible, selection: { ...selected, modelId: id } };
}

/** Capture a provider/model pair and validated options; this never starts generation. */
export async function resolveAgentModelSelection(input = {}, context = {}) {
  abort(context);
  if (input.typeConfig?.enabled === false) throw new ChatContractError('capability_unavailable', 'The selected agent type is disabled');
  const explicit = input.target === undefined ? null : parsed(validateModelSelection(input.target));
  const type = configuredPair(input.typeConfig, 'the agent type', !explicit);
  const routing = configuredPair(input.defaultModel, 'subagent routing', !explicit && !type);
  const parent = configuredPair(input.parentSelection, 'the parent chat', !explicit && !type && !routing);
  const selected = explicit ?? type ?? routing ?? parent;
  if (!selected) throw new ChatContractError('model_unavailable', 'No parent or subagent model is configured');
  const source = explicit ? 'explicit' : type ? 'type' : routing ? 'routing' : 'parent';
  const clears = explicit?.options && Object.keys(explicit.options).length === 0;
  let defaults = clears ? {} : overlayOptions(
    overlayOptions(samePair(selected, parent) ? parent.options : {}, samePair(selected, routing) ? routing.options : {}),
    typeOptions(input.typeConfig),
  );
  if (explicit?.options) defaults = overlayOptions(defaults, explicit.options);
  const selection = parsed(resolveModelSelection({
    providerId: selected.providerId, modelId: selected.modelId,
    ...(clears ? { options: {} } : {}),
  }, { defaults }));
  const snapshot = typeof context.catalog === 'function' ? context : createAgentCatalogContext(context);
  if (selection.providerId === AGENT_POOL_PROVIDER_ID) {
    const inspected = await inspectAgentPool(selection, snapshot);
    return {
      selection: inspected.selection, source, exactModel: false,
      availability: { state: 'available', reason: 'Compatible pool members available' },
      vision: inspected.eligible.every(member => member.vision === true),
      pool: { id: inspected.pool.id, revision: inspected.revision, eligibleEntryIds: inspected.eligible.map((member) => member.entry.id) },
    };
  }
  const inspected = await inspectAgentModel(selection, snapshot);
  if (inspected.availability.state === 'unavailable') unavailable(inspected.availability.reason);
  assertSupportedModelOptions(selection.options, inspected.support);
  return { selection, source, exactModel: source === 'explicit', availability: inspected.availability, sendCapabilities: inspected.support.sendCapabilities, vision: inspected.vision };
}
