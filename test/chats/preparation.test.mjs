import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { buildChatPreparation } from '../../scripts/build-headless-runner.mjs';
import { createChatPolicy, assertChatToolAllowed } from '../../server/chats/policy.js';
import { captureChatProfile, prepareChatExecution, resolveChatPolicyInput } from '../../server/chats/preparation.js';

let directory;
let composer;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-chat-preparation-'));
  const { outfile } = await buildChatPreparation({ outfile: path.join(directory, 'composer.mjs'), logLevel: 'error' });
  composer = await import(pathToFileURL(outfile).href);
  await fs.writeFile(path.join(directory, 'AGENTS.md'), 'Workspace instructions only.');
});
after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

const raw = (kind, id, body) => `---\nid: ${id}\nkind: ${kind}\nlabel: ${id}\nversion: 1\n---\n${body}`;
const definition = name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });

function fixture(overrides = {}) {
  const names = ['read_file', 'save_file', 'git_branch', 'git_commit', 'execute_command', 'spawn_sub_agent',
    'issue_search', 'ask_question', 'browser_snapshot', 'mcp__docs__read', 'plugin__editor__write'];
  const chat = { id: 'chat', modeId: 'build', workspacePath: directory, providerId: 'api', modelId: 'model', ...overrides.chat };
  const scope = { projectId: 'project', workspaceId: 'main', canonicalKey: directory };
  const agents = ['builder', 'planner'].map(id => ({ id, label: id, kind: 'work-agent', version: '1',
    defaultForModes: [id === 'builder' ? 'build' : 'plan'], allowedTools: null }));
  const settings = { meta: { features: { memoryInjection: false, contextDocumentsInjectionDefault: true },
      sampler: { temperature: 0.4, topP: 0.8, maxTokens: 9000 }, thinking: { defaultMode: 'off', thinkingBudgetTokens: null } },
    tools: { enabled: {}, permissions: { default: Object.fromEntries(names.map(name => [name, 'full'])) } },
    rules: { version: 2, enabled: true, groups: [{ id: 'g', name: 'Standing rules' }],
      rules: [{ id: 'r', groupId: 'g', title: 'Rule', text: 'Use the configured rule.', enabled: true }] },
  };
  const sources = { builtinRaw: {
    'base/default.full.md': raw('base', 'default', 'SHARED BASE {{mode}} {{cwd}}'),
    'work-agents/builder/agent.full.md': raw('work-agent', 'builder', 'BUILDER BODY'),
    'work-agents/planner/agent.full.md': raw('work-agent', 'planner', 'PLANNER BODY'),
    'info/general-assistant.full.md': raw('info', 'general-assistant', 'CURRENT INFO {{date}}'),
  }, userRaw: {} };
  let transcript = { messages: [{ role: 'user', content: 'Task', commandId: 'command' }], meta: {} };
  let capturedProfile = null;
  const profiles = new Map();
  const subAgents = { enabled: true, defaultContextEnforcementPolicy: 'compact', types: {} };
  const adapters = {
    loadComposer: async () => composer, readSettings: async () => settings,
    listTools: async () => names.map(definition), loadWorkAgents: async () => ({ agents, overrides: {} }),
    loadSubAgentTypes: async () => subAgents,
    loadPromptSources: async () => sources, loadCustomPrompt: async () => null,
    loadTypePrompt: async () => 'ACTUAL TYPE ROLE',
    readTranscript: async () => transcript,
    readProfile: async reference => profiles.get(`${reference.profileId}:${reference.profileVersion}`) ?? null,
    retrieveMemory: async () => 'Retrieved notes.', retrieveCodeMap: async () => 'Retrieved map.',
    isServerToolAvailable: async name => !name.startsWith('browser_'),
    resolveModelContextLimit: async () => 32000,
  };
  const provider = { id: 'api', enabled: true, apiKind: overrides.cli ? 'agent-cli-v1' : 'openai-v1' };
  const caps = { models: { model: { vision: true } } };
  const modelAdapters = {
    listProviders: async () => [provider], listModels: async () => [{ id: 'model', reasoning: { allowed_options: ['off', 'high'] } }],
    readCapabilities: async () => caps, modelAvailability: async () => ({ available: true }),
  };
  const command = { version: 1, commandId: 'command', chatId: 'chat', kind: 'send', message: 'Task', mode: 'auto', requestedAt: 1,
    provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } };
  const execution = { executionId: 'execution', chatId: 'chat', captured: { modelSelection: { providerId: 'api', modelId: 'model', options: { reasoningEffort: 'high' } } } };
  const fence = { executionId: 'execution', epoch: 1, ownerId: 'owner' };
  const options = { adapters, modelAdapters,
    async resolveTarget() {
      const currentPolicy = createChatPolicy(await resolveChatPolicyInput(chat, scope, { adapters }));
      return { chat, scope, currentPolicy, policy: currentPolicy, profile: capturedProfile };
    },
  };
  return { names, chat, scope, agents, settings, sources, subAgents, provider, caps, adapters, options, command, execution, fence,
    prepare: () => prepareChatExecution({ command, execution, fence }, options),
    setProfile(snapshot, { version = 1, capture = true } = {}) {
      const reference = { profileId: 'profile', profileVersion: version };
      capturedProfile = { ...reference, chatId: chat.id, snapshot: structuredClone(snapshot) };
      profiles.set(`${reference.profileId}:${reference.profileVersion}`, capturedProfile);
      if (capture) { command.profileReference = reference; execution.captured.profileReference = reference; }
      return capturedProfile;
    },
    setTranscript: value => { transcript = value; },
  };
}

test('live policy uses actual mode, exact work-agent restrictions and dynamic off', async () => {
  const f = fixture({ chat: { modeId: 'plan' } });
  f.agents[1].allowedTools = ['read_file', 'save_file', 'git_branch', 'issue_search', 'execute_command', 'mcp__docs__read'];
  f.settings.tools.permissions.default.mcp__docs__read = 'off';
  const input = await resolveChatPolicyInput(f.chat, f.scope, { adapters: f.adapters, workspaceIds: ['main', 'tree'] });
  assert.deepEqual(input.workspaceIds, ['main', 'tree']);
  assert.equal(input.fileWriteScope, 'plans');
  assert.equal(input.toolPermissions.read_file, 'full');
  assert.equal(input.toolPermissions.save_file, 'full');
  assert.equal(input.toolPermissions.git_commit, 'off');
  assert.equal(input.toolPermissions.issue_search, 'full');
  assert.equal(input.toolPermissions.execute_command, 'full');
  assert.equal(input.toolPermissions.mcp__docs__read, 'off');
  assert.equal(input.toolPermissions.plugin__editor__write, 'off');
  const policy = createChatPolicy(input);
  assert.doesNotThrow(() => assertChatToolAllowed(policy, 'git_branch', {}, { currentPolicy: policy }));
});

test('production preparation composes shared prompts, current input first-turn docs, rules and real model options', async () => {
  const f = fixture();
  const prepared = await f.prepare();
  assert.match(prepared.systemPrompt, /SHARED BASE build/);
  assert.match(prepared.systemPrompt, /BUILDER BODY/);
  assert.match(prepared.systemPrompt, /Workspace instructions only/);
  assert.match(prepared.systemPrompt, /Use the configured rule/);
  assert.match(prepared.contextBodies['context-documents'], /Workspace instructions only/);
  assert.deepEqual(prepared.model.options, { reasoningEffort: 'high' });
  assert.equal(prepared.model.vision, true);
  assert.equal(prepared.model.sampler.maxTokens, 9000);
  assert.equal(prepared.model.thinking.mode, 'off');
  assert.equal(prepared.limits.modelContextLimit, 32000);
  assert.deepEqual(prepared.hostToolNames, ['browser_snapshot']);
  assert.equal(prepared.providerCapabilities, f.caps);
  assert.deepEqual(prepared.sendCapabilities.reasoningAllowedOptions, ['off', 'high']);
});

test('captured Plan stays Plan in both composed instructions and tool policy after chat changes to Build', async () => {
  const f = fixture();
  f.execution.captured.policy = createChatPolicy(await resolveChatPolicyInput({ ...f.chat, modeId: 'plan' }, f.scope, { adapters: f.adapters }));
  const prepared = await f.prepare();
  assert.equal(prepared.policy.modeId, 'plan');
  assert.equal(prepared.toolContext.modeId, 'plan');
  assert.match(prepared.systemPrompt, /SHARED BASE plan/);
  assert.match(prepared.systemPrompt, /PLANNER BODY/);
  assert.ok(!prepared.tools.some(row => row.function.name === 'git_commit'));
  assert.throws(() => assertChatToolAllowed(prepared.policy, 'save_file', { path: 'src/main.ts', content: 'x' },
    { currentPolicy: prepared.policy }), error => error.code === 'policy_denied');
});

test('follow-ups replay exact stored context, including CLI stable/current separation', async () => {
  const f = fixture({ cli: true });
  f.setTranscript({ messages: [{ role: 'user', commandId: 'previous' }, { role: 'user', commandId: 'command' }],
    meta: { injectedContext: { 'context-documents': 'STORED CONTEXT', 'brain-notes': 'STORED NOTES' } } });
  f.adapters.retrieveMemory = async () => { throw new Error('Must replay'); };
  const prepared = await f.prepare();
  assert.equal(prepared.contextBodies['context-documents'], 'STORED CONTEXT');
  assert.match(prepared.cliTurnContext, /STORED CONTEXT/);
  assert.match(prepared.cliTurnContext, /STORED NOTES/);
  assert.ok(!prepared.systemPrompt.includes('STORED CONTEXT'));
  assert.match(prepared.systemPrompt, /Use the configured rule/);
});

test('live type revocations narrow tools and disabling type preserves read/stop only', async () => {
  const f = fixture({ chat: { agentTypeId: 'explore' } });
  f.subAgents.types.explore = { enabled: true, allowedTools: ['read_file', 'execute_command'], deniedTools: ['execute_command'] };
  const input = await resolveChatPolicyInput(f.chat, f.scope, { adapters: f.adapters });
  assert.equal(input.toolPermissions.read_file, 'full');
  assert.equal(input.toolPermissions.execute_command, 'off');
  assert.equal(input.toolPermissions.save_file, 'off');
  f.subAgents.types.explore.enabled = false;
  const revoked = await resolveChatPolicyInput(f.chat, f.scope, { adapters: f.adapters });
  assert.deepEqual(revoked.capabilities, ['chat.read', 'chat.stop']);
  await assert.rejects(f.prepare, error => error.code === 'capability_unavailable');
});

test('current catalog support is mandatory and probe vision false wins over catalog', async () => {
  const f = fixture();
  f.caps.models.model.vision = false;
  assert.equal((await f.prepare()).model.vision, false);
  f.execution.captured.modelSelection.options.reasoningEffort = 'max';
  await assert.rejects(f.prepare, error => error.code === 'options_unsupported');
});

test('custom prompt disappearance fails explicitly and per-call registries never leak', async () => {
  const f = fixture();
  f.settings.meta.activePromptProfile = 'custom';
  f.settings.meta.activePromptConfigId = 'missing';
  await assert.rejects(f.prepare, error => error.code === 'capability_unavailable');
  f.settings.meta.activePromptProfile = 'full';
  f.sources.userRaw['base/default.full.md'] = raw('base', 'default', 'CUSTOM FIRST');
  assert.match((await f.prepare()).systemPrompt, /CUSTOM FIRST/);
  assert.ok(!(await fixture().prepare()).systemPrompt.includes('CUSTOM FIRST'));
});

test('context document traversal does not escape the workspace', async () => {
  const f = fixture();
  f.settings.meta.contextDocuments = { enabledPresets: [], customPaths: ['../outside.md'], maxTotalChars: 500 };
  // Use a sibling unique name so a fixture cannot overwrite another test's file.
  const unique = `${path.basename(directory)}-outside.md`;
  const full = path.join(path.dirname(directory), unique);
  await fs.writeFile(full, 'OUTSIDE SECRET');
  f.settings.meta.contextDocuments.customPaths = [`../${unique}`];
  try { assert.ok(!(await f.prepare()).systemPrompt.includes('OUTSIDE SECRET')); }
  finally { await fs.rm(full, { force: true }); }
});

test('profile capture stores only composed sources/settings and preserves role/sampler after queued edits', async () => {
  const f = fixture({ chat: { agentTypeId: 'explore' } });
  f.subAgents.types.explore = { enabled: true, label: 'Explorer', allowedTools: ['read_file', 'save_file'],
    deniedTools: [], sampler: { temperature: 0.2 }, secret: 'UNRELATED TYPE SENTINEL' };
  f.settings.meta.integrations = { token: 'UNRELATED META SENTINEL' };
  f.settings.meta.sampler.unknown = 'UNRELATED SAMPLER SENTINEL';
  f.sources.userRaw['experts/unused/expert.full.md'] = raw('expert', 'unused', 'UNUSED SOURCE SENTINEL');
  f.adapters.loadTypePrompt = async () => 'ORIGINAL EXPLORER ROLE';
  const captured = await captureChatProfile(f.chat, f.scope, { adapters: f.adapters, exactModel: true });
  const serialized = JSON.stringify(captured);
  assert.ok(!serialized.includes('SENTINEL'));
  assert.ok(serialized.includes('ORIGINAL EXPLORER ROLE'));
  assert.ok(Object.keys(captured.prompt.sources.userRaw).every(key => key.startsWith('capture/')));
  f.setProfile(captured);
  f.execution.captured.policy = captured.policy;
  f.settings.meta.sampler.maxTokens = 100;
  f.subAgents.types.explore.sampler.temperature = 1.9;
  f.subAgents.types.explore.allowedTools = ['read_file'];
  f.adapters.loadTypePrompt = async () => 'CHANGED ROLE';
  const prepared = await f.prepare();
  assert.match(prepared.systemPrompt, /ORIGINAL EXPLORER ROLE/);
  assert.ok(!prepared.systemPrompt.includes('CHANGED ROLE'));
  assert.equal(prepared.model.sampler.maxTokens, 9000);
  assert.equal(prepared.model.sampler.preset.temperature, 0.2);
  assert.equal(prepared.model.exactModel, true);
  assert.deepEqual(prepared.tools.map(row => row.function.name), ['read_file']);
});

test('captured source payload has an explicit size ceiling', async () => {
  const f = fixture();
  f.sources.userRaw['base/default.full.md'] = raw('base', 'default', 'x'.repeat(600_000));
  await assert.rejects(captureChatProfile(f.chat, f.scope, { adapters: f.adapters }),
    error => error.code === 'capability_unavailable' && /512 KiB/.test(error.message));
});

test('queued commands and retries resolve their immutable profile version despite newer configuration', async () => {
  const f = fixture({ chat: { agentTypeId: 'explore' } });
  f.subAgents.types.explore = { enabled: true, allowedTools: ['read_file', 'save_file'], sampler: { temperature: 0.2 } };
  f.adapters.loadTypePrompt = async () => 'ACCEPTED ROLE';
  const original = await captureChatProfile(f.chat, f.scope, { adapters: f.adapters, exactModel: true,
    modelSelection: { providerId: 'api', modelId: 'model', options: { reasoningEffort: 'high' } } });
  f.setProfile(original);
  delete f.execution.captured.modelSelection;
  f.settings.meta.sampler.maxTokens = 111;
  f.adapters.loadTypePrompt = async () => 'LATEST ROLE';
  f.subAgents.types.explore.sampler.temperature = 1.8;
  const latest = await captureChatProfile(f.chat, f.scope, { adapters: f.adapters, exactModel: false,
    modelSelection: { providerId: 'api', modelId: 'new-unavailable-model', options: {} } });
  f.setProfile(latest, { version: 2, capture: false });
  f.subAgents.types.explore.allowedTools = ['read_file'];
  for (const executionId of ['execution', 'retry-execution']) {
    f.execution.executionId = executionId;
    const prepared = await f.prepare();
    assert.match(prepared.systemPrompt, /ACCEPTED ROLE/);
    assert.ok(!prepared.systemPrompt.includes('LATEST ROLE'));
    assert.equal(prepared.model.id, 'model');
    assert.deepEqual(prepared.model.options, { reasoningEffort: 'high' });
    assert.equal(prepared.model.exactModel, true);
    assert.equal(prepared.model.sampler.maxTokens, 9000);
    assert.equal(prepared.model.sampler.preset.temperature, 0.2);
    assert.deepEqual(prepared.tools.map(row => row.function.name), ['read_file']);
  }
  f.caps.models.model.reasoningAllowedOptions = ['off'];
  f.options.modelAdapters.listModels = async () => [{ id: 'model', reasoning: { allowed_options: ['off'] } }];
  await assert.rejects(f.prepare, error => error.code === 'options_unsupported');
});

test('embedded accepted profile is authoritative and invalid references never fall back to latest', async () => {
  const f = fixture();
  const snapshot = await captureChatProfile(f.chat, f.scope, { adapters: f.adapters });
  f.execution.captured.profile = f.setProfile(snapshot);
  f.adapters.readProfile = async () => { throw new Error('Captured profile must not need a latest lookup'); };
  assert.match((await f.prepare()).systemPrompt, /BUILDER BODY/);
  f.command.profileReference = { profileId: 'profile', profileVersion: 2 };
  await assert.rejects(f.prepare, error => error.code === 'idempotency_conflict');
  f.command.profileReference = f.execution.captured.profileReference;
  f.execution.captured.profile.chatId = 'another-chat';
  await assert.rejects(f.prepare, error => error.code === 'capability_unavailable');
  delete f.execution.captured.profile;
  f.adapters.readProfile = async () => null;
  await assert.rejects(f.prepare, error => error.code === 'capability_unavailable');
});

test('exact revalidation does not turn inherited direct selections into exact routing', async () => {
  const f = fixture();
  assert.equal((await f.prepare()).model.exactModel, false);
  f.execution.captured.exactModel = true;
  assert.equal((await f.prepare()).model.exactModel, true);
});

test('My Models binding changes only runtime pair while selected identity/options remain captured', async () => {
  const f = fixture();
  f.execution.captured.modelSelection = { providerId: 'minnow-library', modelId: 'gguf:org/repo:model.gguf', options: {} };
  f.options.modelAdapters.listLibraryModels = async () => [{ repo_id: 'org/repo', gguf_files: [{ name: 'model.gguf', rel_path: 'model.gguf' }] }];
  f.options.modelAdapters.resolveLibraryTarget = async () => ({ runtime: 'llama-cpp' });
  f.options.modelAdapters.listServes = async () => [];
  let binding;
  f.adapters.bindLibraryModel = async selected => {
    binding = selected;
    return { providerId: 'llama-cpp-local', id: 'loaded-runtime-alias' };
  };
  f.adapters.resolveModelContextLimit = async model => {
    assert.equal(model.providerId, 'llama-cpp-local'); return 4096;
  };
  const prepared = await f.prepare();
  assert.deepEqual(binding, { providerId: 'minnow-library', id: 'gguf:org/repo:model.gguf' });
  assert.equal(prepared.model.providerId, 'llama-cpp-local');
  assert.equal(prepared.model.id, 'loaded-runtime-alias');
  assert.equal(prepared.model.exactModel, true);
  assert.deepEqual(prepared.selectedModelSelection, f.execution.captured.modelSelection);
  assert.equal(prepared.limits.modelContextLimit, 4096);
});

test('pool image preflight retains bytes and excludes unverified members before the shared runner', async () => {
  const f = fixture();
  f.execution.captured.modelSelection = { providerId: 'minnow-router', modelId: 'pool', options: {} };
  f.execution.captured.exactModel = true;
  f.setTranscript({ messages: [{ role: 'user', commandId: 'command', content: 'Inspect image',
    images: [{ name: 'sample.png', dataUrl: 'data:image/png;base64,aGk=' }] }], meta: {} });
  f.options.modelAdapters.listModels = async () => [{ id: 'text' }, { id: 'image', capabilities: { vision: true } }];
  f.options.modelAdapters.readCapabilities = async () => ({ models: { text: { vision: false } } });
  f.options.modelAdapters.listPools = async () => ({ routers: [{ id: 'pool', enabled: true, entries: [
    { id: 'a', providerId: 'api', modelId: 'text', enabled: true },
    { id: 'b', providerId: 'api', modelId: 'image', enabled: true },
  ] }], revision: 2 });
  f.options.modelAdapters.resolvePoolId = async id => id;
  f.options.modelAdapters.poolAvailability = async (pool, request) => {
    assert.equal(request.messages[0].content[1].type, 'image_url');
    return { a: { available: true }, b: { available: true } };
  };
  const prepared = await f.prepare();
  assert.equal(prepared.model.providerId, 'minnow-router');
  assert.equal(prepared.model.vision, true);
  assert.equal(prepared.model.exactModel, false);
});
