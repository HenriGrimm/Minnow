import { createHash } from 'node:crypto';
import { ChatContractError, validateModelSelection } from './contracts.js';
import {
  AGENT_LIBRARY_PROVIDER_ID, AGENT_POOL_PROVIDER_ID, createAgentCatalogContext,
  inspectAgentModel, inspectAgentPool, libraryCatalogModels,
} from './model-selection.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const DEFAULT_MODELS_PER_PROVIDER = 8;

function selectionKey(value) { return JSON.stringify([value.providerId, value.modelId]); }
function fail(message) { throw new ChatContractError('invalid_request', message); }
function label(value, fallback) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : fallback; }
function publicSupport(support) {
  return { reasoningEffort: [...support.reasoningEffort], thinkingMode: [...support.thinkingMode], thinkingBudgetTokens: { ...support.thinkingBudgetTokens } };
}

function poolSupport(members) {
  const efforts = new Set();
  const modes = new Set();
  for (const member of members) {
    member.support.reasoningEffort.forEach((value) => efforts.add(value));
    member.support.thinkingMode.forEach((value) => modes.add(value));
  }
  return {
    reasoningEffort: [...efforts], thinkingMode: [...modes],
    thinkingBudgetTokens: { supported: members.some((member) => member.support.thinkingBudgetTokens.supported), enforcement: 'member-dependent' },
    memberFiltering: true,
  };
}

function parseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Capability input must be an object');
  for (const name of Object.keys(input)) if (!['search', 'cursor', 'limit'].includes(name)) fail(`Unknown capability input: ${name}`);
  if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) fail('Search must be a string of at most 200 characters');
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail('Capability limit must be from 1 to 100');
  const search = (input.search ?? '').trim().toLowerCase();
  let cursor;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(input.cursor)) fail('Invalid capability cursor');
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
    catch { fail('Invalid capability cursor'); }
    if (cursor?.version !== 1 || cursor.search !== search || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || typeof cursor.signature !== 'string') fail('Invalid capability cursor');
  }
  return { search, limit, cursor };
}

/** Read-only bounded discovery. No model loading, provider conversations or global preference changes. */
export async function listAgentCapabilities(input = {}, context = {}) {
  const { search, limit, cursor } = parseInput(input);
  const snapshot = createAgentCatalogContext(context);
  const pinned = new Set();
  for (const selection of [context.inherited, ...(context.favorites ?? []), ...(context.configuredSelections ?? [])]) {
    if (selection === undefined || selection === null) continue;
    const parsed = validateModelSelection(selection);
    if (!parsed.ok) fail('A configured capability selection is invalid');
    pinned.add(selectionKey(parsed.value));
  }
  let inherited;
  if (context.inherited !== undefined) {
    const parsed = validateModelSelection(context.inherited);
    if (!parsed.ok) fail('The inherited capability selection is invalid');
    inherited = parsed.value;
  }
  const targets = [];
  const unavailableProviders = [];
  let omittedModels = 0;
  const providers = await snapshot.providers();
  const match = (provider, model) => !search || search.split(/\s+/).every((term) => `${provider.id} ${provider.label ?? ''} ${model.id} ${model.name ?? ''}`.toLowerCase().includes(term));
  for (const provider of providers) {
    snapshot.signal?.throwIfAborted();
    if (provider.id === AGENT_LIBRARY_PROVIDER_ID || provider.id === AGENT_POOL_PROVIDER_ID) continue;
    if (provider.enabled === false) {
      unavailableProviders.push({ providerId: provider.id, label: label(provider.label, provider.id), reason: 'Provider disabled' });
      continue;
    }
    let catalog;
    try { catalog = await snapshot.catalog(provider.id); }
    catch {
      unavailableProviders.push({ providerId: provider.id, label: label(provider.label, provider.id), reason: 'Provider catalog unavailable' });
      continue;
    }
    if (catalog?.error || catalog?.unreachable) {
      unavailableProviders.push({ providerId: provider.id, label: label(provider.label, provider.id), reason: 'Provider unavailable or not authenticated' });
      continue;
    }
    const models = (Array.isArray(catalog) ? catalog : catalog?.data ?? []).filter((model) => model.enabled !== false && !['embedding', 'embeddings', 'image', 'imagegen'].includes(model.type) && match(provider, model));
    const selected = search ? models : models.filter((model, index) => index < DEFAULT_MODELS_PER_PROVIDER || pinned.has(selectionKey({ providerId: provider.id, modelId: model.id })));
    omittedModels += models.length - selected.length;
    for (const model of selected) {
      try {
        const inspected = await inspectAgentModel({ providerId: provider.id, modelId: model.id }, snapshot);
        targets.push({ providerId: provider.id, modelId: model.id, providerLabel: label(provider.label, provider.id), label: label(model.name, model.id), kind: 'model', options: publicSupport(inspected.support), availability: inspected.availability });
      } catch (error) {
        if (!(error instanceof ChatContractError) || error.code !== 'model_unavailable') throw error;
      }
    }
  }
  const libraryProvider = { id: AGENT_LIBRARY_PROVIDER_ID, label: 'My Models' };
  const libraryModels = libraryCatalogModels(await snapshot.library()).filter((row) => match(libraryProvider, row));
  const selectedLibrary = search ? libraryModels : libraryModels.filter((row, index) => index < DEFAULT_MODELS_PER_PROVIDER || pinned.has(selectionKey({ providerId: libraryProvider.id, modelId: row.id })));
  omittedModels += libraryModels.length - selectedLibrary.length;
  for (const model of selectedLibrary) {
    try {
      const inspected = await inspectAgentModel({ providerId: libraryProvider.id, modelId: model.id }, snapshot);
      targets.push({ providerId: libraryProvider.id, modelId: model.id, providerLabel: libraryProvider.label, label: label(model.name, model.id), kind: 'library', options: publicSupport(inspected.support), availability: inspected.availability });
    } catch (error) {
      if (!(error instanceof ChatContractError) || error.code !== 'model_unavailable') throw error;
    }
  }
  const poolStore = await snapshot.pools();
  for (const pool of poolStore?.routers ?? []) {
    if (!match({ id: AGENT_POOL_PROVIDER_ID, label: 'Model pools' }, { id: pool.id, name: pool.name })) continue;
    try {
      const inspected = await inspectAgentPool({ providerId: AGENT_POOL_PROVIDER_ID, modelId: pool.id }, snapshot);
      targets.push({ providerId: AGENT_POOL_PROVIDER_ID, modelId: pool.id, providerLabel: 'Model pools', label: label(pool.name, pool.id), kind: 'pool', revision: inspected.revision, options: poolSupport(inspected.members), availability: { state: 'available', reason: 'Compatible pool members available' } });
    } catch (error) {
      if (!(error instanceof ChatContractError) || !['model_unavailable', 'options_unsupported'].includes(error.code)) throw error;
      targets.push({ providerId: AGENT_POOL_PROVIDER_ID, modelId: pool.id, providerLabel: 'Model pools', label: label(pool.name, pool.id), kind: 'pool', revision: poolStore.revision ?? 0, options: { reasoningEffort: [], thinkingMode: ['inherit'], thinkingBudgetTokens: { supported: false, enforcement: null }, memberFiltering: true }, availability: { state: 'unavailable', reason: pool.enabled === false ? 'Pool disabled' : 'No eligible pool member available' } });
    }
  }
  const ordered = [...new Map(targets.map((row) => [selectionKey(row), row])).values()].sort((a, b) => Number(pinned.has(selectionKey(b))) - Number(pinned.has(selectionKey(a))) || a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
  const signature = createHash('sha256').update(JSON.stringify(ordered.map((row) => [row.providerId, row.modelId, row.revision]))).digest('hex');
  if (cursor && cursor.signature !== signature) throw new ChatContractError('stale_revision', 'The model catalog changed; restart capability discovery');
  const offset = cursor?.offset ?? 0;
  const page = ordered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const typeFile = context.types ?? await snapshot.adapters.listAgentTypes();
  const types = Object.entries(typeFile?.types ?? typeFile ?? {}).filter(([, row]) => row?.enabled !== false).slice(0, 50).map(([id, row]) => ({ id, label: label(row.label, id) }));
  snapshot.signal?.throwIfAborted();
  return {
    ...(inherited ? { inherited } : {}), types, targets: page,
    omittedModels: omittedModels + Math.max(0, ordered.length - nextOffset),
    nextCursor: nextOffset < ordered.length ? Buffer.from(JSON.stringify({ version: 1, search, offset: nextOffset, signature })).toString('base64url') : null,
    unavailableProviders: unavailableProviders.slice(0, 8), omittedProviders: Math.max(0, unavailableProviders.length - 8),
  };
}
