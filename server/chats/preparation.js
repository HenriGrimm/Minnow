import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAT_PREPARATION_BUNDLE } from '../constants/headless-runner.js';
import { ChatContractError, validateAgentProfileReference, validateModelSelection } from './contracts.js';
import { projectAgentConversationTools } from './tool-catalog.js';
import { getAgentConversationsFeature } from './feature.js';
import { createChatPolicy, intersectChatPolicies } from './policy.js';
import { normalizePermissionLevel, normalizeTurnClamp } from '../../src/lib/permissions.mjs';
import { createAgentCatalogContext, resolveAgentModelSelection, inspectAgentModel, AGENT_POOL_PROVIDER_ID, AGENT_LIBRARY_PROVIDER_ID } from './model-selection.js';
import { clampShellSandboxModeForPlatform, normalizeShellSandboxMode } from '../terminal/sandbox/mode.js';
import { agentContextBudgetFromWorkAgent, withCompactionDefaults, normalizeContextEnforcementPolicy } from '../runner/context-budget.js';
import { projectUserContent } from '../runner/user-content.js';
import { runWithDeadline } from '../../src/lib/async-deadline.mjs';
import { readChatCheckoutIdentity } from './context.js';
import { rebindChatWorkspacePolicy } from './workspace-preparation.js';
import { validateChatSendIntent } from './contracts.js';
import { wrapUntrusted } from '../../src/lib/untrusted.mjs';
import { isLanProviderBaseUrl } from '../../src/lib/lan-provider-host.mjs';
import { SUB_AGENT_COMPLETION_GUIDANCE, withSubAgentReportTool } from '../sub-agents/reporting.js';

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
    async loadSkill(id) {
      const { readConfigJson } = await import('../config/store.js');
      const { getSkillById } = await import('../skills/scan.js');
      const config = await readConfigJson('skills.json');
      if (config?.enabled?.[id] === false) throw new ChatContractError('capability_unavailable', `Skill "${id}" is disabled in Settings`);
      const skill = await getSkillById(appRoot, id);
      if (!skill?.body?.trim()) throw new ChatContractError('capability_unavailable', `Unknown or unavailable skill: ${id}`);
      return skill;
    },
    async composeImpeccable(body, userText, composer) {
      const { getInstalledImpeccableDir } = await import('../impeccable/skill-install.js');
      const { readImpeccableUpstreamBody } = await import('../impeccable/upstream-handler.js');
      const { readImpeccableReference } = await import('../impeccable/reference-handler.js');
      const root = getInstalledImpeccableDir();
      const upstream = readImpeccableUpstreamBody(root);
      const parts = [body, upstream?.content ?? ''].filter(Boolean);
      const { command } = composer.parseImpeccableSubcommand(userText);
      if (command) for (const id of composer.commandsForImpeccableAugment(command)) {
        const reference = readImpeccableReference(root, id);
        if (!reference?.content) throw new ChatContractError('capability_unavailable', `Required Impeccable workflow is unavailable: ${id}`);
        parts.push(`## ${id === command ? 'Active Impeccable command' : 'Prerequisite workflow'}: ${id}\nFollow this workflow in chat; do not run it with run_impeccable.\n${reference.content}`);
      }
      else if (!userText.trim()) parts.push(composer.formatImpeccableCommandMenu());
      return parts.join('\n\n---\n\n');
    },
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
    async retrieveMemory({ chat, cwd, query, profile, signal }) {
      const { loadBrainConfig } = await import('../brain/store.js');
      const { retrieveBrainBlockHybrid } = await import('../brain/retrieve.js');
      const { brainWorkspaceKeyFromPath } = await import('../brain/paths.js');
      const brain = await loadBrainConfig();
      if (brain.enabled === false) return '';
      const result = await retrieveBrainBlockHybrid({ query, profile, limit: 12, signal,
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

/** Resolve only installed skill identities. Client context never becomes trusted instructions. */
export async function captureChatTurnIntent(intent, chat, message, options = {}) {
  const parsed = validateChatSendIntent(intent);
  if (!parsed.ok) throw new ChatContractError(parsed.error.code, parsed.error.message, parsed.error);
  const adapters = createChatPreparationAdapters(options.adapters);
  try { return await runWithDeadline(async signal => {
    const value = parsed.value;
    let skillBody = null, uiDesigner = null, turnClamp = null;
    if (value.skill) {
      const userText = value.skill.input ?? message;
      const composer = await adapters.loadComposer();
      const skill = await adapters.loadSkill(value.skill.id);
      skillBody = skill.body;
      turnClamp = normalizeTurnClamp(skill.access);
      if (composer.shouldComposeImpeccableBody(value.skill.id, userText)) skillBody = await adapters.composeImpeccable(skillBody, userText, composer);
      if (value.skill.id === 'caveman') skillBody = composer.augmentCavemanSkillBody(skillBody, { userText, pinnedIntensity: value.skill.intensity });
      if (value.skill.id === 'partymode') skillBody = composer.augmentPartyModeSkillBody(skillBody);
      uiDesigner = composer.prepareUiDesignerTurn({ ...chat }, { skillId: value.skill.id, userText, workAgentId: chat.workAgentId });
      if (uiDesigner.active) skillBody = composer.augmentSkillBodyForUiDesigner(skillBody, uiDesigner);
    }
    if (!uiDesigner && chat.workAgentId === 'ui-designer') {
      const composer = await adapters.loadComposer();
      uiDesigner = composer.prepareUiDesignerTurn({ ...chat }, { skillId: null, userText: message, workAgentId: chat.workAgentId });
    }
    signal.throwIfAborted();
    if (skillBody && Buffer.byteLength(skillBody) > 256 * 1024) throw new ChatContractError('capability_unavailable', 'The selected skill exceeds 256 KiB');
    return { intent: value, skillBody, uiDesigner, ...(turnClamp ? { turnClamp } : {}) };
  }, { timeoutMs: options.timeoutMs ?? 10000 }); }
  catch (error) {
    if (error?.name === 'TimeoutError') throw new ChatContractError('capability_unavailable', 'Required skill preparation exceeded its deadline. Retry after checking the selected skill.');
    throw error;
  }
}

function standingChatLinks(links) {
  if (!Array.isArray(links)) return null;
  const values = links.slice(0, 40).flatMap(link => {
    const value = link?.kind === 'file' ? link.path : link?.kind === 'url' ? link.url : null;
    return typeof value === 'string' && value.trim() && value.length <= 2048 ? [{ kind: link.kind, value }] : [];
  });
  return values.length ? 'The user pinned these links as standing context. Read files or open URLs when relevant:\n' +
    wrapUntrusted(JSON.stringify(values), { source: 'chat-links' }) : null;
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
  // One agent: tools are no longer gated by mode or agent type. A tool is
  // available unless it is turned off in Settings → Tools; the permission
  // level decides per call whether the user is asked.
  const effects = composer.classifyChatBuiltinTools([...byName.keys()].filter(name => !/^(?:mcp__|plugin__)/.test(name)));
  const permissions = {};
  for (const name of byName.keys()) {
    const configured = settings.tools?.permissions?.default?.[name];
    const builtinOff = !/^(?:mcp__|plugin__)/.test(name) && configured !== 'ask' && configured !== 'full' &&
      settings.tools?.enabled?.[name] !== true;
    const off = !typeAvailable || configured === 'off' || settings.tools?.enabled?.[name] === false || builtinOff;
    permissions[name] = off ? 'off' : 'ask';
    effects[name] ??= 'unknown';
    if (mode.modeId === 'plan' && effects[name] === 'unknown' && /^(?:mcp__|plugin__)/.test(name)) permissions[name] = 'off';
  }
  const toolSecurity = settings.meta?.toolSecurity ?? {};
  const permissionLevel = normalizePermissionLevel(toolSecurity.permissionLevel);
  const filesystemAccess = permissionLevel === 'full' ||
    (toolSecurity.permissionLevel === undefined && toolSecurity.filesystemAccess === 'full') ? 'full' : 'workspace';
  const policyInput = {
    modeId: mode.modeId, permissionLevel, toolPermissions: permissions, toolEffects: effects,
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
  // One agent: a delegated child composes the same prompt as its parent. Only a
  // user-authored legacy type prompt (systemPromptPath) still adds a role part.
  if (live.typeId && live.type?.systemPromptPath) {
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

/** Five-line delegation envelope appended to a child's (otherwise identical) prompt. */
export const SUB_AGENT_ENVELOPE = [
  '## Delegated task',
  'Another agent delegated this task to you. Do it yourself; you cannot spawn agents.',
  'You are not alone in the workspace: others may edit files at the same time. Never revert changes you did not make.',
  'Do not ask the user questions unless you are blocked; state assumptions instead.',
  'Finish with a self-contained report (final response or report_outcome if offered): what you did, evidence, and anything unverified. Completion delivers it to the delegator.',
].join('\n');

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
    localModelGuidance: ['on', 'off'].includes(meta.localModelGuidance) ? meta.localModelGuidance : 'auto',
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
      flaticonIconGuidanceEnabled: capturedMeta.flaticonIconGuidanceEnabled,
      localModelGuidance: capturedMeta.localModelGuidance, permissionLevel: policy.permissionLevel },
    rules: live.settings.rules, legacySystemPrompt: live.settings.legacySystemPrompt ?? '',
  });
  const overrideIds = new Set(['default', role.workAgent?.id, live.type?.workAgentId].filter(Boolean));
  const workAgentOverrides = Object.fromEntries([...overrideIds].filter(id => live.workAgentOverrides[id]).map(id =>
    [id, pick(live.workAgentOverrides[id], ['sampler', 'thinkingMode', 'thinkingBudgetTokens', 'maxInputTokens', 'contextEnforcementPolicy', 'minRecentTurns', 'summaryReserveTokens'])]));
  const runSettings = live.composer.resolveChatRunSettings({ chat: live.effectiveChat, workAgents: live.agents,
    workAgentOverrides: live.workAgentOverrides, meta,
    ...(live.typeId ? { typeId: live.typeId, typeConfig: live.type } : {}) });
  const chatSettings = pick(chat, ['thinkingMode', 'brainNotesInjection', 'codeMapInjection', 'contextDocumentsInjection', 'memoryEnabled']);
  const prompt = { sources, workAgent: role.workAgent, meta: capturedMeta, customConfig,
    chatLinksBlock: standingChatLinks(chat.links),
    workAgentOverrides, rules: structuredClone(live.settings.rules),
    legacySystemPrompt: live.settings.legacySystemPrompt ?? '' };
  if (Buffer.byteLength(JSON.stringify(prompt)) > 512 * 1024) throw new ChatContractError('capability_unavailable', 'The captured chat prompt exceeds 512 KiB');
  return { policy, exactModel: options.exactModel === true, ...(selected.ok ? { modelSelection: selected.value } : {}),
    ...(live.typeId ? { typeId: live.typeId, typeConfig: pick(live.type, ['label', 'workAgentId', 'sampler', 'thinkingMode', 'thinkingBudgetTokens',
      'maxInputTokens', 'contextEnforcementPolicy', 'minRecentTurns', 'summaryReserveTokens', 'summarySchema']) } : {}),
    prompt, runSettings, chatSettings,
  };
}

const LOCAL_PROVIDER_IDS = new Set(['lm-studio-local', 'vite-fallback', 'llama-cpp-local', 'mlx-lm-local', AGENT_LIBRARY_PROVIDER_ID]);
/** True when inference runs on this machine or the LAN (local-model appendix `auto`). */
function providerRunsLocally(providerId, provider) {
  if (provider?.apiKind === 'agent-cli-v1') return false;
  if (LOCAL_PROVIDER_IDS.has(providerId)) return true;
  const baseUrl = typeof provider?.baseUrl === 'string' ? provider.baseUrl : '';
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  } catch { return false; }
  return isLanProviderBaseUrl(baseUrl);
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

async function contextDocuments(composer, meta, cwd, filesystemAccess, signal) {
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
      signal?.throwIfAborted();
      const full = await safePath(relative);
      if (!full) return null;
      try { return await fs.readFile(full, { encoding: 'utf8', signal }); }
      catch (error) { signal?.throwIfAborted(); return null; }
    },
    async listFiles(relative) {
      signal?.throwIfAborted();
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
  const [profileSnapshot, live, transcript] = await Promise.all([
    executionProfile(command, execution, adapters),
    policySnapshot(chat, scope, { adapters: options.adapters, workspaceIds: target.currentPolicy.workspaceIds }),
    adapters.readTranscript(chat.id),
  ]);
  const snapshot = execution.captured?.turnSettings ?? profileSnapshot?.snapshot ?? {};
  const turn = execution.captured?.turnIntent;
  if (command.intent?.skill && !turn?.skillBody?.trim()) throw new ChatContractError('capability_unavailable', 'The accepted skill snapshot is missing. This input cannot execute without its selected instructions.');
  const checkoutIdentity = target.checkoutIdentity ?? await readChatCheckoutIdentity(scope.canonicalKey);
  let policy = intersectChatPolicies(target.policy, createChatPolicy(live.policyInput));
  const snapshotPolicy = snapshot.policy && (execution.captured?.workspacePolicyBinding
    ? rebindChatWorkspacePolicy(snapshot.policy, execution.captured.workspacePolicyBinding) : createChatPolicy(snapshot.policy));
  if (snapshotPolicy) policy = intersectChatPolicies(policy, snapshotPolicy);
  if (execution.captured?.policy) policy = intersectChatPolicies(policy, createChatPolicy(execution.captured.policy));
  if (!policy.capabilities.includes('execution.host')) throw new ChatContractError('capability_unavailable', 'This agent configuration is disabled or unavailable');
  // A skill with `access:` front matter (/ask, /plan) narrows this turn only.
  const skillClamp = normalizeTurnClamp(turn?.turnClamp);
  if (skillClamp) policy = intersectChatPolicies(policy, createChatPolicy({ ...policy, turnClamp: skillClamp }));
  let tools = live.definitions.filter(definition => policy.toolPermissions[definition.function.name] && policy.toolPermissions[definition.function.name] !== 'off')
    .map(definition => structuredClone(definition));
  if (turn?.uiDesigner?.active) {
    tools = live.composer.applyUiDesignerToolFilter(tools, turn.uiDesigner)
      .filter(tool => !live.composer.assertUiDesignerToolAllowed(tool.function.name, turn.uiDesigner.mode));
    const allowed = new Set(tools.map(tool => tool.function.name));
    policy = createChatPolicy({ ...policy, toolPermissions: Object.fromEntries(Object.entries(policy.toolPermissions)
      .map(([name, permission]) => [name, allowed.has(name) ? permission : 'off'])) });
  }
  const selected = execution.captured?.modelSelection ?? command.modelSelection ?? snapshot.modelSelection ??
    { providerId: chat.providerId, modelId: chat.modelId };
  const parsed = validateModelSelection(selected);
  if (!parsed.ok) throw new ChatContractError(parsed.error.code, parsed.error.message, parsed.error);
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
  const acceptedChat = { ...chat, ...(snapshot.chatSettings ?? {}) };
  const contextChat = { ...acceptedChat, history, injectedContext: transcript?.meta?.injectedContext ?? chat.injectedContext ?? snapshot.contextBodies };
  const replay = live.composer.replayChatContext(contextChat);
  const firstTurn = !history.some(row => row.role === 'user' && row.commandId !== command.commandId);
  const meta = { ...live.settings.meta, ...(snapshot.prompt?.meta ?? {}) };
  const profile = ['lite', 'custom'].includes(meta.activePromptProfile) ? meta.activePromptProfile : 'full';
  const effectiveChat = { ...live.effectiveChat, modeId: policy.modeId };
  const runSettings = snapshot.runSettings ?? live.composer.resolveChatRunSettings({ chat: effectiveChat, workAgents: live.agents,
    workAgentOverrides: snapshot.prompt?.workAgentOverrides ?? live.workAgentOverrides, meta,
    ...(live.typeId ? { typeId: live.typeId, typeConfig: snapshot.typeConfig ?? live.type } : {}) });
  model.sampler = runSettings.sampler;
  model.thinking = runSettings.thinking;
  const shellSandboxMode = policy.shellSandboxMode;
  let customConfig = snapshot.prompt?.customConfig ?? null;
  if (profile === 'custom' && !customConfig && meta.activePromptConfigId) customConfig = await live.adapters.loadCustomPrompt(meta.activePromptConfigId);
  if (profile === 'custom' && !customConfig) throw new ChatContractError('capability_unavailable', 'The selected custom prompt configuration is unavailable');
  const query = command.message ?? '';
  const memoryEnabled = firstTurn ? enabled(acceptedChat.brainNotesInjection, meta.features?.memoryInjection !== false) &&
    (acceptedChat.memoryEnabled ?? meta.memory?.enabled ?? true) && !(chat.kind === 'expert' && chat.expertRuntime?.memoryEnabled === false) : Boolean(replay.memoryBlock);
  const codeMapEnabled = firstTurn ? enabled(acceptedChat.codeMapInjection, meta.features?.codeMapInjectionDefault === true) : Boolean(replay.codeMapBlock);
  const documentsEnabled = firstTurn ? enabled(acceptedChat.contextDocumentsInjection, meta.features?.contextDocumentsInjectionDefault !== false) : Boolean(replay.contextDocumentsBlock);
  const enrichmentOmissions = [];
  const timeoutMs = options.enrichmentTimeoutMs ?? meta.memory?.embeddings?.queryTimeoutMs ?? 3000;
  const optional = async (kind, work) => {
    try { return await runWithDeadline(work, { timeoutMs, signal }); }
    catch (error) {
      signal?.throwIfAborted();
      enrichmentOmissions.push({ kind, reason: error?.name === 'TimeoutError' ? 'deadline' : 'unavailable' });
      return null;
    }
  };
  const requiredDocuments = async () => {
    try {
      return await runWithDeadline(documentSignal => contextDocuments(live.composer, meta, cwd, policy.filesystemAccess, documentSignal), { timeoutMs, signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'TimeoutError') throw new ChatContractError('capability_unavailable', 'Context document preparation exceeded its deadline. Check Context documents settings and the project files before retrying.');
      throw error;
    }
  };
  const [memoryBlock, codeMapBlock, contextDocumentsBlock, role] = await Promise.all([
    memoryEnabled ? firstTurn ? optional('memory', enrichmentSignal => live.adapters.retrieveMemory({ chat, cwd, query, profile, signal: enrichmentSignal })) : replay.memoryBlock : null,
    codeMapEnabled ? firstTurn ? optional('code-map', enrichmentSignal => live.adapters.retrieveCodeMap({ cwd, query, composer: live.composer, signal: enrichmentSignal })) : replay.codeMapBlock : null,
    documentsEnabled ? firstTurn ? requiredDocuments() : replay.contextDocumentsBlock : null,
    snapshot.prompt?.sources ? { sources: snapshot.prompt.sources, workAgent: snapshot.prompt.workAgent ?? null }
      : rolePromptSnapshot(live, effectiveChat),
  ]);
  enrichmentOmissions.sort((a, b) => a.kind.localeCompare(b.kind));
  signal?.throwIfAborted();
  const cli = inspection?.provider?.apiKind === 'agent-cli-v1';
  const promptChat = role.workAgent ? { ...effectiveChat, workAgentAuto: false, workAgentId: role.workAgent.id } : effectiveChat;
  const promptAgents = role.workAgent ? [...live.agents.filter(agent => agent.id !== role.workAgent.id), role.workAgent] : live.agents;
  const composed = live.composer.composeChatPrompt({ chat: promptChat, workAgents: promptAgents,
    workAgentOverrides: snapshot.prompt?.workAgentOverrides ?? live.workAgentOverrides, ...role.sources,
    context: { profile, customConfig, customConfigId: meta.activePromptConfigId ?? null, cwd, modeId: policy.modeId,
      expertId: snapshot.prompt?.expertId ?? null, expertLabel: snapshot.prompt?.expertLabel ?? null,
      workAgentId: null, skillBody: turn?.skillBody ?? snapshot.prompt?.skillBody ?? null,
      memoryBlock: nonempty(memoryBlock), memoryEnabled, codeMapBlock: nonempty(codeMapBlock), codeMapInjectionEnabled: codeMapEnabled,
      contextDocumentsBlock: nonempty(contextDocumentsBlock), contextDocumentsInjectionEnabled: documentsEnabled,
      chatLinksBlock: snapshot.prompt?.chatLinksBlock ?? null, enabledToolIds: tools.map(row => row.function.name),
      infoPresetId: meta.activeInfoPresetId ?? 'general-assistant', planGranularity: meta.planning?.granularity ?? 'medium',
      flaticonIconGuidanceEnabled: meta.flaticonIconGuidanceEnabled !== false, userMessagePreview: query.slice(0, 200),
      localModelGuidance: ['on', 'off'].includes(meta.localModelGuidance) ? meta.localModelGuidance : 'auto',
      providerIsLocal: providerRunsLocally(model.providerId, inspection?.provider),
      permissionLevel: policy.permissionLevel, turnClamp: policy.turnClamp ?? null,
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
  const hostAvailability = new Array(tools.length);
  let nextTool = 0;
  await Promise.all(Array.from({ length: Math.min(8, tools.length) }, async () => {
    while (nextTool < tools.length) {
      const index = nextTool++;
      const name = tools[index].function.name;
      hostAvailability[index] = native.has(name) || await live.adapters.isServerToolAvailable(name);
    }
  }));
  const hostToolNames = tools.filter((_, index) => !hostAvailability[index]).map(row => row.function.name);
  const delegated = execution?.captured?.completionPolicy?.kind === 'wake_delegator';
  const taskGuidance = delegated ? '\n\n' + SUB_AGENT_ENVELOPE + '\n' + SUB_AGENT_COMPLETION_GUIDANCE : '';
  if (delegated) tools = withSubAgentReportTool(tools);
  const enrichmentNotice = enrichmentOmissions.length
    ? `\n\nOptional enrichment unavailable: ${enrichmentOmissions.map(row => `${row.kind} (${row.reason})`).join(', ')}. Use tools if this context is needed.` : '';
  const intent = turn?.intent ?? command.intent;
  const surfaceData = intent && Object.fromEntries(['context', 'issue', 'codeMap'].filter(key => intent[key] !== undefined).map(key => [key, intent[key]]));
  const surfaceContext = surfaceData && Object.keys(surfaceData).length
    ? '\n\n' + wrapUntrusted(JSON.stringify(surfaceData), { source: 'send-context' }) : '';
  const goalContext = intent?.goalDriven ? '\n\nThis is a continuation toward the user\'s active goal. Verify completion before reporting success.' : '';
  const prepared = { systemPrompt: composed.systemPrompt + taskGuidance + (cli ? '' : goalContext + enrichmentNotice + surfaceContext),
    ...(cli ? { cliTurnContext: (composed.cliTurnContext ?? '') + goalContext + enrichmentNotice + surfaceContext } : {}),
    tools, model, cwd, policy, contextBodies, enrichmentOmissions, checkoutIdentity,
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
