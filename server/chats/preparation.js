import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAT_PREPARATION_BUNDLE } from '../constants/headless-runner.js';
import { ChatContractError, validateAgentProfileReference, validateModelSelection } from './contracts.js';
import { projectAgentConversationTools } from './tool-catalog.js';
import { getAgentConversationsFeature } from './feature.js';
import { createChatPolicy, intersectChatPolicies } from './policy.js';
import { createAgentCatalogContext, resolveAgentModelSelection, inspectAgentModel, AGENT_POOL_PROVIDER_ID, AGENT_LIBRARY_PROVIDER_ID } from './model-selection.js';
import { clampShellSandboxModeForPlatform, normalizeShellSandboxMode } from '../terminal/sandbox/mode.js';
import { agentContextBudgetFromWorkAgent, withCompactionDefaults, normalizeContextEnforcementPolicy } from '../runner/context-budget.js';
import { projectUserContent } from '../runner/user-content.js';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
let composerPromise;

export async function loadChatPreparationComposer() {
  composerPromise ??= import(pathToFileURL(path.join(appRoot, CHAT_PREPARATION_BUNDLE)).href).catch(() => {
    composerPromise = undefined;
    throw new ChatContractError('capability_unavailable', 'Chat preparation bundle is unavailable. Run npm run headless:build or restart npm start.');
  });
  return composerPromise;
}

async function rawPrompts(root, required = false) {
  const result = {};
  async function walk(directory, prefix = '') {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (required && !prefix) throw error; return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith('_') || entry.name === 'node_modules') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile() && entry.name.endsWith('.md')) result[relative] = await fs.readFile(full, 'utf8');
    }
  }
  await walk(root);
  return result;
}

/** Load normal persisted settings and real schemas; adapters keep tests off the live home. */
export function createChatPreparationAdapters(overrides = {}) {
  return {
    loadComposer: loadChatPreparationComposer,
    async readSettings() {
      const { readResource } = await import('../config/store.js');
      const { normalizeToolConfig, validateUserRulesSettings } = await import('../config/validators.js');
      const [meta, rawTools, rules, legacy] = await Promise.all([
        readResource('meta'), readResource('tools'), readResource('rules'), readResource('system-prompt'),
      ]);
      return { meta, tools: normalizeToolConfig(rawTools), rules: validateUserRulesSettings(rules), legacySystemPrompt: legacy?.text ?? '' };
    },
    async listTools() {
      const { BUILT_IN_TOOLS } = await import('../tools/builtin-catalog.js');
      const { listEnabledMcpTools } = await import('../mcp/registry.js');
      const { getPluginToolDefinitions } = await import('../tools/loader.js');
      const [mcp, plugins] = await Promise.all([listEnabledMcpTools(), getPluginToolDefinitions()]);
      return projectAgentConversationTools([...BUILT_IN_TOOLS.map(row => row.definition), ...mcp, ...plugins], {
        creationEnabled: getAgentConversationsFeature().creationEnabled, includeRecoveryTools: true,
      });
    },
    async loadWorkAgents() {
      const { loadWorkAgentRegistry } = await import('../work-agents/registry.js');
      return loadWorkAgentRegistry(appRoot);
    },
    async loadSubAgentTypes() {
      const { readConfigJson } = await import('../config/store.js');
      const { mergeSubAgentFile } = await import('../sub-agents/config.js');
      const shipped = JSON.parse(await fs.readFile(path.join(appRoot, 'src/agents/defaults/sub-agents.json'), 'utf8'));
      return mergeSubAgentFile(shipped, await readConfigJson('sub-agents.json'));
    },
    async isServerToolAvailable(name) {
      const { isServerToolAvailable } = await import('../runtime/tools-middleware.js');
      return isServerToolAvailable(name);
    },
    async resolveModelContextLimit(model) {
      const { resolveServerModelContextLimit } = await import('../models/context-window.js');
      return resolveServerModelContextLimit(model);
    },
    async bindLibraryModel(model, options) {
      const { resolveLibraryAttemptBinding } = await import('../models/library-binding.js');
      return resolveLibraryAttemptBinding(model, {}, options);
    },
    async loadPromptSources(agents) {
      const { getMinnowHome } = await import('../config/home.js');
      const { readWorkAgentPrompt } = await import('../work-agents/registry.js');
      const [builtinRaw, userRaw] = await Promise.all([
        rawPrompts(path.join(appRoot, 'src/chat/prompts'), true), rawPrompts(path.join(getMinnowHome(), 'prompts')),
      ]);
      // Work-agent overrides and pack prompts may be body-only. Feed their actual
      // resolved bodies through the normal loader, preserving both profiles.
      for (const agent of agents) {
        for (const profile of ['full', 'lite']) {
          let body;
          try { body = await readWorkAgentPrompt(appRoot, agent.id, profile); }
          catch (error) {
            if (profile !== 'lite' || error.code !== 'ENOENT') throw error;
            body = await readWorkAgentPrompt(appRoot, agent.id, 'full');
          }
          userRaw[`work-agents/${agent.id}/agent.${profile}.md`] =
            `---\nid: ${agent.id}\nkind: work-agent\nlabel: ${JSON.stringify(agent.label)}\nversion: 1\n---\n${body.content}`;
        }
      }
      return { builtinRaw, userRaw };
    },
    async loadTypePrompt(typeId, type, profile) {
      const { resolveSubAgentBasePrompt } = await import('../sub-agents/prompts.js');
      // The legacy override API permits lowercase ids only. The shipped
      // generalPurpose id predates that API; read its exact safe file identity.
      if (!type.systemPromptPath && !type.workAgentId && /^[a-z][A-Za-z0-9-]{0,63}$/.test(typeId) && /[A-Z]/.test(typeId)) {
        const { getMinnowHome } = await import('../config/home.js');
        const { parsePromptMarkdown } = await import('../prompts/parse.js');
        for (const full of [path.join(getMinnowHome(), 'prompts/sub-agents', `${typeId}.${profile}.md`),
          path.join(appRoot, 'src/agents/prompts/sub-agents', `${typeId}.${profile}.md`)]) {
          try {
            const text = await fs.readFile(full, 'utf8');
            try { return parsePromptMarkdown(text, full).body.trim(); } catch { return text.trim(); }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      return resolveSubAgentBasePrompt(typeId, type, profile);
    },
    async loadCustomPrompt(id) {
      const { loadPromptConfigFile } = await import('../prompt-configs/handlers.js');
      return loadPromptConfigFile(id);
    },
    async readTranscript(chatId) {
      const { createChatRepository } = await import('./repository.js');
      return createChatRepository().readTranscript(chatId);
    },
    async readProfile(reference) {
      const { createChatRepository } = await import('./repository.js');
      return createChatRepository().getProfile(reference.profileId, reference.profileVersion);
    },
    async retrieveMemory({ chat, cwd, query, profile }) {
      const { loadBrainConfig } = await import('../brain/store.js');
      const { retrieveBrainBlockHybrid } = await import('../brain/retrieve.js');
      const { brainWorkspaceKeyFromPath } = await import('../brain/paths.js');
      const brain = await loadBrainConfig();
      if (brain.enabled === false) return '';
      const result = await retrieveBrainBlockHybrid({ query, profile, limit: 12,
        autoInject: chat.kind !== 'expert', workspaceKey: brainWorkspaceKeyFromPath(cwd),
        maxChars: profile === 'lite' ? brain.maxInjectCharsLite ?? 800 : brain.maxInjectCharsFull ?? 8000,
        ...(chat.kind === 'expert' && chat.expertId ? { scope: { expertId: chat.expertId } } : {}),
      }, brain);
      return result.block ?? '';
    },
    async retrieveCodeMap({ cwd, query, composer, signal }) {
      const { loadBrainCodeConfig, repoMap } = await import('../brain/code/query.js');
      const { getCodeDb } = await import('../brain/code/schema.js');
      const { brainWorkspaceKeyFromPath } = await import('../brain/paths.js');
      const { pathAccessStore } = await import('../runtime/path-access.js');
      const { wrapUntrusted } = await import('../../src/lib/untrusted.mjs');
      const code = await loadBrainCodeConfig();
      if (!code.enabled) return '';
      const repo = brainWorkspaceKeyFromPath(cwd);
      // repoMap's legacy empty-repo fallback is intentionally avoided here.
      if (!getCodeDb(repo).prepare('SELECT COUNT(*) AS n FROM symbols WHERE repo=?').get(repo)?.n) return '';
      const focus = composer.extractCodeMapFocusHints(query).focus;
      const map = await pathAccessStore.run({ workspaceRootOverride: cwd, abortSignal: signal }, () =>
        repoMap({ repo, focus: focus.length ? focus : undefined, profile: 'injection',
          tokenBudget: code.repoMapInjectionTokenBudget, skipStalenessCheck: true }));
      return map?.text?.trim() ? wrapUntrusted(map.text.trim(), { source: 'code-map' }) : '';
    },
    ...overrides,
  };
}

async function policySnapshot(chat, scope, options = {}) {
  const adapters = createChatPreparationAdapters(options.adapters);
  const [composer, settings, definitions, registry, subAgents] = await Promise.all([
    adapters.loadComposer(), adapters.readSettings(), adapters.listTools(), adapters.loadWorkAgents(),
    adapters.loadSubAgentTypes(),
  ]);
  const agents = registry.agents ?? registry;
  const typeId = typeof chat.agentTypeId === 'string' ? chat.agentTypeId : null;
  const type = typeId ? subAgents.types?.[typeId] : null;
  const effectiveChat = { ...chat, modeId: createChatPolicy({ modeId: chat.modeId ?? 'build' }).modeId,
    ...(type?.workAgentId ? { workAgentId: type.workAgentId } : {}) };
  const pinnedId = effectiveChat.workAgentId && effectiveChat.workAgentId !== 'default' ? effectiveChat.workAgentId : null;
  const pinnedAvailable = !pinnedId || agents.some(agent => agent.id === pinnedId && !agent.disabled);
  const typeAvailable = pinnedAvailable && (!typeId || (subAgents.enabled !== false && type && type.enabled !== false));
  const byName = new Map();
  for (const definition of definitions) {
    const name = definition?.function?.name;
    if (!name || byName.has(name)) throw new ChatContractError('capability_unavailable', 'The current tool catalog has missing or duplicate identities');
    byName.set(name, definition);
  }
  const mode = composer.resolveChatModeTools({ chat: effectiveChat, workAgents: agents,
    workAgentOverrides: registry.overrides, toolNames: [...byName.keys()] });
  const allowed = new Set(mode.allowedToolNames);
  const typeAllow = type?.allowedTools?.length ? new Set(type.allowedTools) : null;
  const typeDeny = new Set(type?.deniedTools ?? []);
  const effects = composer.classifyChatBuiltinTools([...byName.keys()].filter(name => !/^(?:mcp__|plugin__)/.test(name)));
  const permissions = {};
  for (const name of byName.keys()) {
    const configured = settings.tools?.permissions?.default?.[name];
    const permission = ['full', 'ask', 'off'].includes(configured) ? configured
      : name.startsWith('mcp__') ? 'full' : name.startsWith('plugin__') ? 'ask' : 'off';
    // In particular, MCP does not bypass an explicit off or work-agent allowlist.
    permissions[name] = typeAvailable && allowed.has(name) && (!typeAllow || typeAllow.has(name)) &&
      !typeDeny.has(name) && settings.tools?.enabled?.[name] !== false ? permission : 'off';
    effects[name] ??= 'unknown';
    if (mode.modeId === 'plan' && effects[name] === 'unknown' && /^(?:mcp__|plugin__)/.test(name)) permissions[name] = 'off';
  }
  const filesystemAccess = settings.meta?.toolSecurity?.filesystemAccess === 'full' ? 'full' : 'workspace';
  const policyInput = {
    modeId: mode.modeId, toolPermissions: permissions, toolEffects: effects,
    shellSandboxMode: clampShellSandboxModeForPlatform(normalizeShellSandboxMode(settings.meta?.toolSecurity?.shellSandbox)),
    workspaceIds: options.workspaceIds ?? [scope.workspaceId], filesystemAccess,
    fileWriteScope: mode.modeId === 'plan' ? 'plans' : filesystemAccess,
    capabilities: ['chat.read', 'chat.stop', ...(typeAvailable ? ['chat.send', 'request.respond', 'execution.host'] : []),
      ...(permissions.spawn_sub_agent && permissions.spawn_sub_agent !== 'off' ? ['agent.spawn'] : [])],
  };
  return { adapters, composer, settings, definitions, agents, workAgentOverrides: registry.overrides ?? {}, mode, policyInput,
    subAgents, type, typeId, effectiveChat };
}

export async function resolveChatPolicyInput(chat, scope, options = {}) {
  return (await policySnapshot(chat, scope, options)).policyInput;
}

async function rolePromptSnapshot(live, effectiveChat) {
  let selected = live.composer.resolveChatModeTools({ chat: effectiveChat, workAgents: live.agents,
    workAgentOverrides: live.workAgentOverrides, toolNames: [] }).workAgent;
  const sources = await live.adapters.loadPromptSources(selected ? [selected] : []);
  if (live.typeId && (!live.type?.workAgentId || live.type.systemPromptPath)) {
    selected = { id: `subagent-${live.typeId}`, label: live.type.label ?? live.typeId, kind: 'work-agent',
      version: '1', providerId: null, modelId: null, allowedTools: null };
    sources.userRaw ??= {};
    for (const variant of ['full', 'lite']) {
      const body = await live.adapters.loadTypePrompt(live.typeId, live.type, variant);
      sources.userRaw[`work-agents/${selected.id}/agent.${variant}.md`] =
        `---\nid: ${selected.id}\nkind: work-agent\nlabel: ${JSON.stringify(selected.label)}\nversion: 1\n---\n${body}`;
    }
  }
  return { sources, workAgent: selected ? structuredClone(selected) : null };
}

/** Immutable initial prompt/config capture. Current grants are rechecked separately. */
export async function captureChatProfile(chat, scope, options = {}) {
  const live = await policySnapshot(chat, scope, options);
  const policy = createChatPolicy(live.policyInput);
  if (!policy.capabilities.includes('execution.host')) throw new ChatContractError('capability_unavailable', 'This agent configuration is disabled or unavailable');
  const role = await rolePromptSnapshot(live, live.effectiveChat);
  const meta = live.settings.meta;
  const customConfig = meta.activePromptProfile === 'custom' && meta.activePromptConfigId
    ? await live.adapters.loadCustomPrompt(meta.activePromptConfigId) : null;
  if (meta.activePromptProfile === 'custom' && !customConfig) throw new ChatContractError('capability_unavailable', 'The selected custom prompt configuration is unavailable');
  const selected = validateModelSelection(options.modelSelection ?? { providerId: chat.providerId, modelId: chat.modelId });
  if (options.modelSelection && !selected.ok) throw new ChatContractError(selected.error.code, selected.error.message, selected.error);
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));
  const capturedMeta = {
    activePromptProfile: meta.activePromptProfile ?? 'full', activePromptConfigId: meta.activePromptConfigId ?? null,
    activeInfoPresetId: meta.activeInfoPresetId ?? 'general-assistant',
    flaticonIconGuidanceEnabled: meta.flaticonIconGuidanceEnabled !== false,
    planning: { granularity: meta.planning?.granularity ?? 'medium' },
    sampler: pick(meta.sampler, ['temperature', 'topP', 'topK', 'minP', 'repetitionPenalty', 'presencePenalty', 'maxTokens', 'stop']),
    thinking: pick(meta.thinking, ['defaultMode', 'thinkingBudgetTokens']),
    memory: { enabled: meta.memory?.enabled !== false }, contextDocuments: pick(meta.contextDocuments, ['enabledPresets', 'customPaths', 'maxTotalChars']),
    features: { memoryInjection: meta.features?.memoryInjection !== false, codeMapInjectionDefault: meta.features?.codeMapInjectionDefault === true,
      contextDocumentsInjectionDefault: meta.features?.contextDocumentsInjectionDefault !== false },
    toolSecurity: { shellSandbox: policy.shellSandboxMode },
  };
  const promptChat = role.workAgent ? { ...live.effectiveChat, workAgentAuto: false, workAgentId: role.workAgent.id } : live.effectiveChat;
  const promptAgents = role.workAgent ? [...live.agents.filter(agent => agent.id !== role.workAgent.id), role.workAgent] : live.agents;
  const sources = live.composer.captureChatPromptSources({ chat: promptChat, workAgents: promptAgents,
    workAgentOverrides: live.workAgentOverrides, ...role.sources,
    context: { profile: capturedMeta.activePromptProfile, customConfig, cwd: scope.canonicalKey, modeId: policy.modeId,
      expertId: null, workAgentId: null, skillBody: null, memoryBlock: '{{memory}}', memoryEnabled: true,
      codeMapBlock: '{{code_map}}', codeMapInjectionEnabled: true,
      contextDocumentsBlock: '{{context_documents}}', contextDocumentsInjectionEnabled: true,
      enabledToolIds: Object.keys(policy.toolPermissions).filter(name => policy.toolPermissions[name] !== 'off'),
      infoPresetId: capturedMeta.activeInfoPresetId, shellSandboxMode: policy.shellSandboxMode,
      flaticonIconGuidanceEnabled: capturedMeta.flaticonIconGuidanceEnabled },
    rules: live.settings.rules, legacySystemPrompt: live.settings.legacySystemPrompt ?? '',
  });
  const overrideIds = new Set(['default', role.workAgent?.id, live.type?.workAgentId].filter(Boolean));
  const workAgentOverrides = Object.fromEntries([...overrideIds].filter(id => live.workAgentOverrides[id]).map(id =>
    [id, pick(live.workAgentOverrides[id], ['sampler', 'thinkingMode', 'thinkingBudgetTokens', 'maxInputTokens', 'contextEnforcementPolicy', 'minRecentTurns', 'summaryReserveTokens'])]));
  const prompt = { sources, workAgent: role.workAgent, meta: capturedMeta, customConfig,
    workAgentOverrides, rules: structuredClone(live.settings.rules),
    legacySystemPrompt: live.settings.legacySystemPrompt ?? '' };
  if (Buffer.byteLength(JSON.stringify(prompt)) > 512 * 1024) throw new ChatContractError('capability_unavailable', 'The captured chat prompt exceeds 512 KiB');
  return { policy, exactModel: options.exactModel === true, ...(selected.ok ? { modelSelection: selected.value } : {}),
    ...(live.typeId ? { typeId: live.typeId, typeConfig: pick(live.type, ['label', 'workAgentId', 'sampler', 'thinkingMode', 'thinkingBudgetTokens',
      'maxInputTokens', 'contextEnforcementPolicy', 'minRecentTurns', 'summaryReserveTokens', 'summarySchema']) } : {}),
    prompt,
  };
}

function enabled(tri, fallback) { return tri === 'on' || (tri !== 'off' && fallback); }
function nonempty(value) { return typeof value === 'string' && value.trim() ? value : null; }

async function executionProfile(command, execution, adapters) {
  const references = [execution.captured?.profileReference, command.profileReference].filter(value => value !== undefined);
  let reference;
  for (const value of references) {
    const parsed = validateAgentProfileReference(value);
    if (!parsed.ok) throw new ChatContractError(parsed.error.code, parsed.error.message, parsed.error);
    if (reference && (reference.profileId !== parsed.value.profileId || reference.profileVersion !== parsed.value.profileVersion)) {
      throw new ChatContractError('idempotency_conflict', 'The execution profile does not match its accepted command');
    }
    reference = parsed.value;
  }
  const captured = execution.captured?.profile;
  if (!reference && !captured) return null;
  const profile = captured ?? await adapters.readProfile(reference);
  const parsed = validateAgentProfileReference({ profileId: profile?.profileId, profileVersion: profile?.profileVersion });
  if (!profile || !parsed.ok || profile.chatId !== execution.chatId ||
      (reference && (profile.profileId !== reference.profileId || profile.profileVersion !== reference.profileVersion)) ||
      !profile.snapshot || typeof profile.snapshot !== 'object' || Array.isArray(profile.snapshot)) {
    throw new ChatContractError('capability_unavailable', 'The accepted execution profile is unavailable or does not match this conversation');
  }
  return profile;
}

async function contextDocuments(composer, meta, cwd, filesystemAccess) {
  const raw = meta.contextDocuments ?? {};
  const documents = {
    enabledPresets: Array.isArray(raw.enabledPresets) ? raw.enabledPresets.filter(value => typeof value === 'string') : composer.defaultEnabledPresetIds(),
    customPaths: Array.isArray(raw.customPaths) ? raw.customPaths.filter(value => typeof value === 'string') : [],
    maxTotalChars: Number.isFinite(raw.maxTotalChars) && raw.maxTotalChars > 0 ? Math.floor(raw.maxTotalChars) : 48_000,
  };
  const root = await fs.realpath(cwd);
  async function safePath(relative) {
    if (relative.includes('\0')) return null;
    try {
      const resolved = await fs.realpath(path.resolve(root, relative));
      const rel = path.relative(root, resolved);
      return filesystemAccess === 'full' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) ? resolved : null;
    } catch { return null; }
  }
  return composer.resolveContextDocumentsBlock(documents, {
    async readText(relative) {
      const full = await safePath(relative);
      if (!full) return null;
      try { return await fs.readFile(full, 'utf8'); } catch { return null; }
    },
    async listFiles(relative) {
      const full = await safePath(relative);
      if (!full) return [];
      try { return (await fs.readdir(full, { withFileTypes: true })).filter(row => row.isFile()).map(row => row.name); }
      catch { return []; }
    },
  });
}

/** Preparation only: the execution host owns transcript append, dispatch and runTurn. */
export async function prepareChatExecution({ command, execution, fence, signal }, options = {}) {
  if (typeof options.resolveTarget !== 'function') throw new TypeError('Chat preparation requires a trusted target resolver');
  signal?.throwIfAborted();
  const target = await options.resolveTarget(execution.chatId);
  const { chat, scope } = target;
  const adapters = createChatPreparationAdapters(options.adapters);
  const profileSnapshot = await executionProfile(command, execution, adapters);
  const snapshot = profileSnapshot?.snapshot ?? {};
  const live = await policySnapshot(chat, scope, { adapters: options.adapters,
    workspaceIds: target.currentPolicy.workspaceIds });
  let policy = intersectChatPolicies(target.policy, createChatPolicy(live.policyInput));
  if (snapshot.policy) policy = intersectChatPolicies(policy, createChatPolicy(snapshot.policy));
  if (execution.captured?.policy) policy = intersectChatPolicies(policy, createChatPolicy(execution.captured.policy));
  if (!policy.capabilities.includes('execution.host')) throw new ChatContractError('capability_unavailable', 'This agent configuration is disabled or unavailable');
  const tools = live.definitions.filter(definition => policy.toolPermissions[definition.function.name] && policy.toolPermissions[definition.function.name] !== 'off')
    .map(definition => structuredClone(definition));
  const selected = execution.captured?.modelSelection ?? command.modelSelection ?? snapshot.modelSelection ??
    { providerId: chat.providerId, modelId: chat.modelId };
  const parsed = validateModelSelection(selected);
  if (!parsed.ok) throw new ChatContractError(parsed.error.code, parsed.error.message, parsed.error);
  const transcript = await live.adapters.readTranscript(chat.id);
  const history = transcript?.messages ?? chat.history ?? [];
  const catalog = createAgentCatalogContext({ adapters: options.modelAdapters, signal, workspacePath: scope.canonicalKey,
    request: { tools, stream: true, ...(parsed.value.providerId === AGENT_POOL_PROVIDER_ID
      ? { messages: history.map(row => projectUserContent(row, { vision: true })) } : {}) } });
  const resolved = await resolveAgentModelSelection({ target: parsed.value }, catalog);
  const inspection = resolved.selection.providerId === AGENT_POOL_PROVIDER_ID ? null : await inspectAgentModel(resolved.selection, catalog);
  const model = { providerId: resolved.selection.providerId, id: resolved.selection.modelId,
    ...(resolved.selection.options !== undefined ? { options: resolved.selection.options } : {}),
    exactModel: resolved.selection.providerId === AGENT_POOL_PROVIDER_ID ? false
      : execution.captured?.exactModel ?? snapshot.exactModel ?? false,
    vision: (inspection?.vision ?? resolved.vision) === true };
  if (model.providerId === AGENT_LIBRARY_PROVIDER_ID) {
    const bound = await live.adapters.bindLibraryModel({ providerId: model.providerId, id: model.id }, { signal });
    if (!bound?.providerId || !bound.id || bound.providerId === AGENT_LIBRARY_PROVIDER_ID) throw new ChatContractError('model_unavailable', 'The selected My Models artifact could not be bound to a runtime');
    model.providerId = bound.providerId; model.id = bound.id; model.exactModel = true;
  }
  const cwd = scope.canonicalKey;
  const contextChat = { ...chat, history, injectedContext: transcript?.meta?.injectedContext ?? chat.injectedContext ?? snapshot.contextBodies };
  const replay = live.composer.replayChatContext(contextChat);
  const firstTurn = !history.some(row => row.role === 'user' && row.commandId !== command.commandId);
  const meta = { ...live.settings.meta, ...(snapshot.prompt?.meta ?? {}) };
  const profile = ['lite', 'custom'].includes(meta.activePromptProfile) ? meta.activePromptProfile : 'full';
  const effectiveChat = { ...live.effectiveChat, modeId: policy.modeId };
  const runSettings = live.composer.resolveChatRunSettings({ chat: effectiveChat, workAgents: live.agents,
    workAgentOverrides: snapshot.prompt?.workAgentOverrides ?? live.workAgentOverrides, meta,
    ...(live.typeId ? { typeId: live.typeId, typeConfig: snapshot.typeConfig ?? live.type } : {}) });
  model.sampler = runSettings.sampler;
  model.thinking = runSettings.thinking;
  const shellSandboxMode = policy.shellSandboxMode;
  let customConfig = snapshot.prompt?.customConfig ?? null;
  if (profile === 'custom' && !customConfig && meta.activePromptConfigId) customConfig = await live.adapters.loadCustomPrompt(meta.activePromptConfigId);
  if (profile === 'custom' && !customConfig) throw new ChatContractError('capability_unavailable', 'The selected custom prompt configuration is unavailable');
  const query = command.message ?? '';
  const memoryEnabled = firstTurn ? enabled(chat.brainNotesInjection, meta.features?.memoryInjection !== false) &&
    (chat.memoryEnabled ?? meta.memory?.enabled ?? true) && !(chat.kind === 'expert' && chat.expertRuntime?.memoryEnabled === false) : Boolean(replay.memoryBlock);
  const codeMapEnabled = firstTurn ? enabled(chat.codeMapInjection, meta.features?.codeMapInjectionDefault === true) : Boolean(replay.codeMapBlock);
  const documentsEnabled = firstTurn ? enabled(chat.contextDocumentsInjection, meta.features?.contextDocumentsInjectionDefault !== false) : Boolean(replay.contextDocumentsBlock);
  const [memoryBlock, codeMapBlock, contextDocumentsBlock, role] = await Promise.all([
    memoryEnabled ? firstTurn ? live.adapters.retrieveMemory({ chat, cwd, query, profile, signal }) : replay.memoryBlock : null,
    codeMapEnabled ? firstTurn ? live.adapters.retrieveCodeMap({ cwd, query, composer: live.composer, signal }) : replay.codeMapBlock : null,
    documentsEnabled ? firstTurn ? contextDocuments(live.composer, meta, cwd, policy.filesystemAccess) : replay.contextDocumentsBlock : null,
    snapshot.prompt?.sources ? { sources: snapshot.prompt.sources, workAgent: snapshot.prompt.workAgent ?? null }
      : rolePromptSnapshot(live, effectiveChat),
  ]);
  signal?.throwIfAborted();
  const cli = inspection?.provider?.apiKind === 'agent-cli-v1';
  const promptChat = role.workAgent ? { ...effectiveChat, workAgentAuto: false, workAgentId: role.workAgent.id } : effectiveChat;
  const promptAgents = role.workAgent ? [...live.agents.filter(agent => agent.id !== role.workAgent.id), role.workAgent] : live.agents;
  const composed = live.composer.composeChatPrompt({ chat: promptChat, workAgents: promptAgents,
    workAgentOverrides: snapshot.prompt?.workAgentOverrides ?? live.workAgentOverrides, ...role.sources,
    context: { profile, customConfig, customConfigId: meta.activePromptConfigId ?? null, cwd, modeId: policy.modeId,
      expertId: snapshot.prompt?.expertId ?? null, expertLabel: snapshot.prompt?.expertLabel ?? null,
      workAgentId: null, skillBody: snapshot.prompt?.skillBody ?? null,
      memoryBlock: nonempty(memoryBlock), memoryEnabled, codeMapBlock: nonempty(codeMapBlock), codeMapInjectionEnabled: codeMapEnabled,
      contextDocumentsBlock: nonempty(contextDocumentsBlock), contextDocumentsInjectionEnabled: documentsEnabled,
      chatLinksBlock: snapshot.prompt?.chatLinksBlock ?? null, enabledToolIds: tools.map(row => row.function.name),
      infoPresetId: meta.activeInfoPresetId ?? 'general-assistant', planGranularity: meta.planning?.granularity ?? 'medium',
      flaticonIconGuidanceEnabled: meta.flaticonIconGuidanceEnabled !== false, userMessagePreview: query.slice(0, 200),
      shellSandboxMode, browserActivated: history.some(row => /browser_/.test(row.toolName ?? '')),
    }, rules: snapshot.prompt?.rules ?? live.settings.rules, separateCliContext: cli,
    legacySystemPrompt: snapshot.prompt?.legacySystemPrompt ?? live.settings.legacySystemPrompt,
  });
  const contextBodies = {};
  if (nonempty(memoryBlock)) contextBodies['brain-notes'] = memoryBlock;
  if (nonempty(codeMapBlock)) contextBodies['code-map'] = codeMapBlock;
  if (nonempty(contextDocumentsBlock)) contextBodies['context-documents'] = contextDocumentsBlock;
  const selectedAgent = live.type ?? live.mode.workAgent ?? {};
  const contextPolicy = normalizeContextEnforcementPolicy(live.type?.contextEnforcementPolicy ??
    live.workAgentOverrides[live.mode.workAgent?.id]?.contextEnforcementPolicy) ??
    normalizeContextEnforcementPolicy(live.subAgents.defaultContextEnforcementPolicy) ??
    normalizeContextEnforcementPolicy(selectedAgent.contextEnforcementPolicy) ?? 'compact';
  const contextBudget = withCompactionDefaults(agentContextBudgetFromWorkAgent(selectedAgent, contextPolicy), live.subAgents.defaultContextCompaction);
  const native = new Set(['ask_question', 'recall_history', 'spawn_sub_agent', 'cancel_sub_agent',
    'list_sub_agents', 'get_sub_agent_status', 'agent_capabilities', 'chat_list', 'chat_read', 'chat_send', 'chat_wait', 'chat_stop']);
  const hostToolNames = [];
  for (const definition of tools) {
    const name = definition.function.name;
    if (!native.has(name) && !await live.adapters.isServerToolAvailable(name)) hostToolNames.push(name);
  }
  const prepared = { systemPrompt: composed.systemPrompt, ...(cli ? { cliTurnContext: composed.cliTurnContext } : {}),
    tools, model, cwd, policy, contextBodies,
    selectedModelSelection: resolved.selection,
    sendCapabilities: resolved.sendCapabilities ?? inspection?.support?.sendCapabilities,
    providerCapabilities: inspection?.capabilities,
    hostToolNames, limits: { contextBudget, modelContextLimit: await live.adapters.resolveModelContextLimit(model) },
    toolContext: { modeId: policy.modeId, workspaceRoot: cwd, filesystemAccess: policy.filesystemAccess,
      shellSandboxMode, workAgentId: live.mode.workAgent?.id ?? null },
  };
  if (options.createRunnerDeps) prepared.deps = await options.createRunnerDeps({ ...prepared, command, execution, fence, signal });
  return prepared;
}
