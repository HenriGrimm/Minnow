import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modelOptionSupport, resolveAgentModelSelection } from '../../server/chats/model-selection.js';
import { listAgentCapabilities } from '../../server/chats/capabilities.js';

function fixture() {
  const calls = [];
  const providers = [{ id: 'api', label: 'API', enabled: true, apiKind: 'openai-v1', baseUrl: 'https://private.invalid', hasApiKey: true, customHeaders: { Authorization: 'secret' } }, { id: 'cli', label: 'CLI', enabled: true, apiKind: 'agent-cli-v1' }];
  const models = { api: [
    { id: 'small', reasoning: { allowed_options: ['off', 'low', 'high'], default: 'low' } },
    { id: 'large', reasoning: { allowed_options: ['low', 'high', 'max'], default: 'high' } },
    { id: 'unknown' }, { id: 'embed', type: 'embedding' },
  ], cli: [{ id: 'cli-model', reasoning: { allowed_options: ['low', 'high'] } }] };
  const pool = { id: 'pool', name: 'Mixed pool', enabled: true, entries: [
    { id: 'first', providerId: 'api', modelId: 'small', enabled: true },
    { id: 'second', providerId: 'api', modelId: 'large', enabled: true },
  ] };
  const library = [{ repo_id: 'repo/model', gguf_files: [{ name: 'model.gguf', rel_path: 'model.gguf', role: 'model' }, { name: 'mmproj.gguf', rel_path: 'mmproj.gguf', role: 'projector' }] }];
  const adapters = {
    listProviders: async () => { calls.push('providers'); return { providers }; },
    listModels: async (id) => { calls.push(`catalog:${id}`); return { data: models[id] ?? [] }; },
    readCapabilities: async () => ({ models: {} }),
    listPools: async () => ({ routers: [pool], revision: 7 }),
    resolvePoolId: async (id) => id === 'old-pool' ? 'pool' : id,
    poolAvailability: async () => ({ first: { available: true }, second: { available: true } }),
    listLibraryModels: async () => ({ models: library }),
    resolveLibraryTarget: async () => ({ runtime: 'llama-cpp' }),
    listServes: async () => [],
    listAgentTypes: async () => ({ types: { explore: { label: 'Explore', enabled: true }, retired: { enabled: false } } }),
    modelAvailability: async () => ({ available: true }),
  };
  return { calls, providers, models, pool, library, adapters, context: { adapters } };
}

describe('agent model selection preflight', () => {
  it('captures explicit/type/routing/parent pairs without global writes or model loading', async () => {
    const { context, calls } = fixture();
    const input = { parentSelection: { providerId: 'api', modelId: 'small' }, defaultModel: { providerId: 'cli', modelId: 'cli-model' }, typeConfig: { providerId: 'api', modelId: 'large' } };
    for (const [value, source, modelId] of [
      [{ ...input, target: { providerId: 'api', modelId: 'small' } }, 'explicit', 'small'],
      [input, 'type', 'large'],
      [{ ...input, typeConfig: undefined }, 'routing', 'cli-model'],
      [{ ...input, typeConfig: undefined, defaultModel: undefined }, 'parent', 'small'],
    ]) {
      const resolved = await resolveAgentModelSelection(value, context);
      assert.equal(resolved.source, source);
      assert.equal(resolved.selection.modelId, modelId);
      assert.equal(resolved.exactModel, source === 'explicit');
    }
    assert.ok(calls.every((value) => value === 'providers' || value.startsWith('catalog:')));
  });

  it('inherits same-pair options, resets different pairs, and honors an explicit empty clear', async () => {
    const { context } = fixture();
    const parentSelection = { providerId: 'api', modelId: 'small', options: { reasoningEffort: 'high' } };
    assert.equal((await resolveAgentModelSelection({ parentSelection }, context)).selection.options.reasoningEffort, 'high');
    assert.equal((await resolveAgentModelSelection({ parentSelection, target: { providerId: 'api', modelId: 'large' } }, context)).selection.options, undefined);
    const cleared = await resolveAgentModelSelection({ parentSelection, typeConfig: { thinkingMode: 'off' }, target: { providerId: 'api', modelId: 'small', options: {} } }, context);
    assert.deepEqual(cleared.selection.options, {});
  });

  it('lets explicit effort replace a conflicting inherited type thinking default', async () => {
    const { context } = fixture();
    const resolved = await resolveAgentModelSelection({ typeConfig: { thinkingMode: 'off' }, target: { providerId: 'api', modelId: 'small', options: { reasoningEffort: 'high' } } }, context);
    assert.deepEqual(resolved.selection.options, { reasoningEffort: 'high' });
    const inherited = await resolveAgentModelSelection({ parentSelection: { providerId: 'api', modelId: 'small', options: { reasoningEffort: 'high' } }, typeConfig: { thinkingMode: 'off' } }, context);
    assert.deepEqual(inherited.selection.options, { thinkingMode: 'off' });
  });

  it('rejects partial selected pairs and unavailable/unsupported targets without fallback', async () => {
    const { context, providers } = fixture();
    const fails = (input, code) => assert.rejects(resolveAgentModelSelection(input, context), (error) => error.code === code);
    await fails({ typeConfig: { modelId: 'large' }, parentSelection: { providerId: 'api', modelId: 'small' } }, 'invalid_request');
    await fails({ target: { providerId: 'api', modelId: 'missing' } }, 'model_unavailable');
    await fails({ target: { providerId: 'api', modelId: 'embed' } }, 'model_unavailable');
    await fails({ target: { providerId: 'api', modelId: 'small', options: { reasoningEffort: 'max' } } }, 'options_unsupported');
    await fails({ target: { providerId: 'api', modelId: 'unknown', options: { thinkingMode: 'on' } } }, 'options_unsupported');
    providers[0].enabled = false;
    await fails({ target: { providerId: 'api', modelId: 'small' }, defaultModel: { providerId: 'cli', modelId: 'cli-model' } }, 'model_unavailable');
  });

  it('does not block an explicit complete target on an unrelated incomplete legacy binding', async () => {
    const { context } = fixture();
    const result = await resolveAgentModelSelection({ target: { providerId: 'api', modelId: 'small' }, typeConfig: { modelId: 'missing-provider' }, parentSelection: { modelId: 'missing-provider' } }, context);
    assert.equal(result.selection.modelId, 'small');
  });

  it('captures a pool identity/revision while filtering exact requested options', async () => {
    const { context, pool } = fixture();
    const input = { target: { providerId: 'minnow-router', modelId: 'old-pool', options: { reasoningEffort: 'max' } } };
    const selected = await resolveAgentModelSelection(input, context);
    assert.equal(selected.selection.modelId, 'pool');
    assert.deepEqual(selected.pool, { id: 'pool', revision: 7, eligibleEntryIds: ['second'] });
    pool.entries[1].enabled = false;
    await assert.rejects(resolveAgentModelSelection(input, context), (error) => error.code === 'options_unsupported');
  });

  it('retains unloaded library identity and excludes projector artifacts', async () => {
    const { context } = fixture();
    const result = await resolveAgentModelSelection({ target: { providerId: 'minnow-library', modelId: 'gguf:repo/model:model.gguf' } }, context);
    assert.equal(result.selection.providerId, 'minnow-library');
    assert.equal(result.availability.state, 'loadable');
    await assert.rejects(resolveAgentModelSelection({ target: { providerId: 'minnow-library', modelId: 'gguf:repo/model:mmproj.gguf' } }, context), (error) => error.code === 'model_unavailable');
  });

  it('honors negative probes and never advertises a synthetic CLI thinking budget', () => {
    const row = { id: 'model', reasoning: { allowed_options: ['low', 'high'] } };
    assert.deepEqual(modelOptionSupport(row, { models: { model: { reasoning: false } } }).reasoningEffort, []);
    assert.equal(modelOptionSupport(row, {}, { apiKind: 'agent-cli-v1' }).thinkingBudgetTokens.supported, false);
    assert.equal(modelOptionSupport(row, {}, { apiKind: 'openai-v1' }).thinkingBudgetTokens.enforcement, 'runner');
  });

  it('treats a zero thinking budget as off and will not silently disable an always-on model', async () => {
    const { context } = fixture();
    const selected = await resolveAgentModelSelection({ target: { providerId: 'api', modelId: 'small', options: { thinkingBudgetTokens: 0 } } }, context);
    assert.deepEqual(selected.selection.options, { thinkingMode: 'off', thinkingBudgetTokens: 0 });
    await assert.rejects(resolveAgentModelSelection({ target: { providerId: 'api', modelId: 'large', options: { thinkingBudgetTokens: 0 } } }, context), (error) => error.code === 'options_unsupported');
  });

  it('does no adapter work after cancellation', async () => {
    const { context, calls } = fixture();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resolveAgentModelSelection({ target: { providerId: 'api', modelId: 'small' } }, { ...context, signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(calls, []);
  });

  it('rejects known request incompatibility and current provider allowance before creating work', async () => {
    const { context, adapters } = fixture();
    adapters.readCapabilities = async () => ({ models: { small: { tools: false } } });
    await assert.rejects(resolveAgentModelSelection({ target: { providerId: 'api', modelId: 'small' } }, { ...context, request: { tools: [{ type: 'function' }] } }), (error) => error.code === 'model_unavailable');
    adapters.modelAvailability = async () => ({ available: false, kind: 'quota', reason: 'private-secret' });
    await assert.rejects(resolveAgentModelSelection({ target: { providerId: 'api', modelId: 'small' } }, context), (error) => error.code === 'model_unavailable' && !error.message.includes('private-secret'));
    const capabilities = await listAgentCapabilities({ search: 'small' }, context);
    assert.equal(capabilities.targets[0].availability.state, 'unavailable');
    assert.equal(capabilities.targets[0].availability.reason, 'Provider usage limit reached');
  });
});

describe('bounded agent capability discovery', () => {
  it('returns only public metadata, inherited identity and enabled types', async () => {
    const { context } = fixture();
    const result = await listAgentCapabilities({}, { ...context, inherited: { providerId: 'api', modelId: 'small' } });
    assert.deepEqual(result.types, [{ id: 'explore', label: 'Explore' }]);
    assert.equal(result.targets[0].modelId, 'small');
    const serialized = JSON.stringify(result);
    for (const secret of ['private.invalid', 'Authorization', 'secret', 'baseUrl', 'hasApiKey']) assert.equal(serialized.includes(secret), false, secret);
    assert.equal(result.targets.find((row) => row.kind === 'library').availability.state, 'loadable');
    assert.equal(result.targets.some((row) => row.modelId === 'embed'), false);
  });

  it('limits large catalogs while keeping current/favorite models and searchable omitted entries', async () => {
    const { context, models } = fixture();
    models.api = Array.from({ length: 200 }, (_, index) => ({ id: `model-${String(index).padStart(3, '0')}` }));
    const favorite = { providerId: 'api', modelId: 'model-199' };
    const result = await listAgentCapabilities({}, { ...context, favorites: [favorite] });
    assert.equal(result.targets.filter((row) => row.providerId === 'api').length, 9);
    assert.equal(result.targets[0].modelId, favorite.modelId);
    assert.ok(result.omittedModels >= 191);
    const found = await listAgentCapabilities({ search: 'model-199' }, context);
    assert.deepEqual(found.targets.map((row) => row.modelId), ['model-199']);
  });

  it('paginates a search and rejects changed-catalog or mismatched cursors', async () => {
    const { context, models } = fixture();
    const first = await listAgentCapabilities({ search: 'api', limit: 1 }, context);
    const second = await listAgentCapabilities({ search: 'api', limit: 1, cursor: first.nextCursor }, context);
    assert.notEqual(first.targets[0].modelId, second.targets[0].modelId);
    await assert.rejects(listAgentCapabilities({ search: 'cli', cursor: first.nextCursor }, context), (error) => error.code === 'invalid_request');
    models.api.push({ id: 'new-model' });
    await assert.rejects(listAgentCapabilities({ search: 'api', cursor: first.nextCursor }, context), (error) => error.code === 'stale_revision');
    await assert.rejects(listAgentCapabilities({ limit: 101 }, context), (error) => error.code === 'invalid_request');
  });
});
