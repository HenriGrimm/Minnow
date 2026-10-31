/** Plain-Node entry for the same prompt composer and mode matrix used by Code. */
import { composeSystemPrompt } from '../chat/prompts/prompt-composer';
import { registerPromptFilesFromRaw, resetPromptRegistry, captureResolvedPromptSources } from '../chat/prompts/prompt-loader';
import { registerWorkAgentsFromServerSnapshot, resetWorkAgentRegistry, setUserWorkAgentOverrides } from '../agents/work-agent-registry';
import { resolveSamplerPreset } from '../agents/resolve-sampler';
import { resolveThinkingMode, resolveThinkingBudgetTokens } from '../agents/resolve-thinking';
import { parseSamplerGlobalBlock } from '../config/sampler-meta';
import { clampThinkingBudgetTokens, normalizeThinkingGlobalDefault } from '../agents/thinking-types';
import { resolveActiveWorkAgent } from '../agents/resolve-work-agent';
import { normalizeModeId } from '../chat/modes/types';
import { isToolAllowedForMode } from '../chat/modes/tool-policy';
import { TOOL_GROUP_IDS } from '../chat/modes/tool-groups';
import { getUserRulesPayloadForSend } from '../config/user-rules-compose';
import { resolveInjectionReplay, shouldReplayStoredInjection } from '../chat/context/injection-replay';
import type { ComposeContext } from '../chat/prompts/types';
import type { WorkAgentDefinition } from '../agents/work-agent-types';
import type { WorkAgentUserOverride } from '../agents/work-agent-types';
import type { SubAgentTypeConfig } from '../agents/types';
import type { UserRulesSettings } from '../config/user-rules';
import type { Chat } from '../types';
export { resolveContextDocumentsBlock } from '../chat/context-documents/resolve-block';
export { defaultEnabledPresetIds } from '../chat/context-documents/catalog';
export { extractCodeMapFocusHints } from '../brain/code-map-focus';
export { validateAskQuestionArgs, stringifyAskQuestionResult } from '../tools/ask-question-types';

interface RegistryInput {
  chat: Chat;
  workAgents: WorkAgentDefinition[];
  workAgentOverrides?: Record<string, WorkAgentUserOverride>;
}

function active(input: RegistryInput) {
  resetWorkAgentRegistry();
  registerWorkAgentsFromServerSnapshot(input.workAgents);
  setUserWorkAgentOverrides(input.workAgentOverrides ?? {});
  return resolveActiveWorkAgent(input.chat);
}

export function resolveChatRunSettings(input: RegistryInput & { meta: Record<string, any>; typeId?: string; typeConfig?: SubAgentTypeConfig }) {
  const agent = active(input);
  const { maxTokens, ...preset } = parseSamplerGlobalBlock(input.meta.sampler);
  const kind = input.typeId ? 'sub-agent' : 'work-agent';
  const agentKey = input.typeId ?? agent?.id ?? null;
  const common = { kind, agentKey, subAgentType: input.typeConfig } as const;
  const sampler = resolveSamplerPreset({ ...common, global: { maxTokens: maxTokens!, preset } });
  const raw = input.meta.thinking ?? {};
  const global = {
    defaultMode: normalizeThinkingGlobalDefault(raw.defaultMode, 'on'),
    thinkingBudgetTokens: raw.thinkingBudgetTokens == null ? null : clampThinkingBudgetTokens(raw.thinkingBudgetTokens),
  };
  const thinking = resolveThinkingMode({ ...common, global, chatThinkingMode: input.chat.thinkingMode });
  const budget = resolveThinkingBudgetTokens({ ...common, global });
  return { sampler, thinking: { mode: thinking.mode, budgetTokens: budget.budgetTokens } };
}

/** Synchronous registry setup and use prevents concurrent preparations mixing snapshots. */
export function resolveChatModeTools(input: RegistryInput & { toolNames: string[] }) {
  const modeId = normalizeModeId(input.chat.modeId);
  const workAgent = active(input);
  const allow = workAgent?.allowedTools?.length ? new Set(workAgent.allowedTools) : null;
  return {
    modeId,
    workAgent,
    allowedToolNames: input.toolNames.filter(name =>
      isToolAllowedForMode(modeId, name) && (!allow || allow.has(name))),
  };
}

/** Effects come from the shipped group matrix; dynamic schemas cannot self-grant reads. */
export function classifyChatBuiltinTools(names: string[]): Record<string, string> {
  const groups = TOOL_GROUP_IDS as Record<string, readonly string[]>;
  const result: Record<string, string> = {};
  const reads = new Set(['util-basic', 'wait', 'web', 'files-read', 'git-read', 'code-intel', 'lsp', 'minnow-docs', 'diagnostics']);
  for (const name of names) {
    const group = Object.keys(groups).find(key => groups[key].includes(name));
    result[name] = group === 'files-write' ? 'file-write' : group === 'git-write' ? 'git-write'
      : group === 'code-exec' ? 'shell' : group && reads.has(group) ? 'read'
      : group ? 'external-write' : 'unknown';
  }
  // These tools share a group with side effects but only inspect existing state.
  for (const name of ['read_command_log', 'list_running_commands', 'issue_get_state', 'issue_search',
    'agent_capabilities', 'chat_list', 'chat_read', 'chat_wait',
    'list_sub_agents', 'get_sub_agent_status', 'get_settings', 'search_settings', 'get_appearance',
    'brain_search', 'brain_read_page', 'brain_list', 'read_clipboard']) {
    if (names.includes(name)) result[name] = 'read';
  }
  if (names.includes('write_clipboard')) result.write_clipboard = 'external-write';
  return result;
}

export function replayChatContext(chat: Chat) {
  const bodies = resolveInjectionReplay(chat.history ?? [], chat.injectedContext);
  return {
    memoryBlock: shouldReplayStoredInjection(chat.brainNotesInjection) ? bodies['brain-notes'] ?? null : null,
    codeMapBlock: shouldReplayStoredInjection(chat.codeMapInjection) ? bodies['code-map'] ?? null : null,
    contextDocumentsBlock: shouldReplayStoredInjection(chat.contextDocumentsInjection) ? bodies['context-documents'] ?? null : null,
  };
}

export function composeChatPrompt(input: RegistryInput & {
  builtinRaw: Record<string, string>;
  userRaw?: Record<string, string>;
  context: ComposeContext;
  rules: UserRulesSettings;
  separateCliContext?: boolean;
  legacySystemPrompt?: string;
}) {
  resetPromptRegistry();
  registerPromptFilesFromRaw(input.builtinRaw, 'builtin');
  registerPromptFilesFromRaw(input.userRaw ?? {}, 'user');
  const workAgent = active(input);
  const context = { ...input.context,
    modeId: normalizeModeId(input.chat.modeId),
    workAgentId: workAgent?.id ?? null, workAgentLabel: workAgent?.label ?? null };
  const turnContext: string[] = [];
  const composed = composeSystemPrompt(context,
    input.separateCliContext ? { turnContext } : undefined).trim();
  const prompt = composed || input.legacySystemPrompt?.trim();
  if (!prompt) throw new Error('No composed chat system prompt is available');
  const rules = getUserRulesPayloadForSend(input.rules);
  return {
    systemPrompt: rules ? `${prompt}\n\n---\n\n${rules}` : prompt,
    ...(input.separateCliContext ? { cliTurnContext: turnContext.join('\n\n---\n\n') } : {}),
    modeId: context.modeId,
    workAgent,
  };
}

/** Resolve sources through the composer itself instead of maintaining a fragment list. */
export function captureChatPromptSources(input: Parameters<typeof composeChatPrompt>[0]) {
  const { prompts } = captureResolvedPromptSources(() => composeChatPrompt(input));
  const userRaw: Record<string, string> = {};
  for (const prompt of prompts) {
    const bodies = prompt as typeof prompt & { _fullBody?: string; _liteBody?: string };
    for (const variant of ['full', 'lite'] as const) {
      const body = variant === 'lite' ? bodies._liteBody ?? bodies._fullBody ?? prompt.body : bodies._fullBody ?? prompt.body;
      userRaw[`capture/${prompt.kind}/${prompt.id}.${variant}.md`] =
        `---\nid: ${prompt.id}\nkind: ${prompt.kind}\nlabel: ${JSON.stringify(prompt.label)}\nversion: ${prompt.version}\npart: ${prompt.part}\n---\n${body}`;
    }
  }
  return { builtinRaw: {}, userRaw };
}
