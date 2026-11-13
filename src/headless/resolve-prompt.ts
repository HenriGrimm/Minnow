import { resolveActiveWorkAgent } from '../agents/resolve-work-agent';
import { composeSystemPrompt } from '../chat/prompts/prompt-composer';
import { setUserPromptRegistry } from '../chat/prompts/prompt-loader';
import type { ParsedPrompt } from '../chat/prompts/types';
import { defaultUserRulesSettings } from '../config/defaults';
import { loadPromptMetaSettings } from '../config/prompt-meta';
import { getToolSecurityMetaCached } from '../config/tool-security-meta';
import { getUserRulesPayloadForSend, loadUserRules } from '../config/user-rules';
import { isLocalProvider } from '../providers/provider-host';
import { resolveProvider } from '../providers/store';
import type { Chat } from '../types';
import { headlessApiUrl } from './server-context';

/** Compose with the same prompt files and workspace settings used by Code. */
export async function resolveHeadlessOutboundSystemMessages(
  chat: Chat,
  enabledToolIds: string[],
  cwd: string,
): Promise<{ composed: string; userRules: string | null }> {
  const workAgent = resolveActiveWorkAgent(chat);
  const [registry, role, meta, rules, provider] = await Promise.all([
    fetch(headlessApiUrl('/api/prompts/registry'), { cache: 'no-store' }),
    workAgent && workAgent.id !== 'default'
      ? fetch(headlessApiUrl(`/api/work-agents/${encodeURIComponent(workAgent.id)}/prompt`), { cache: 'no-store' })
      : null,
    loadPromptMetaSettings(),
    loadUserRules().catch(() => defaultUserRulesSettings()),
    resolveProvider(chat.providerId),
  ]);
  if (!registry.ok) throw new Error('Could not load the system prompt registry');
  const { prompts } = await registry.json() as { prompts: ParsedPrompt[] };
  if (workAgent && role?.ok) {
    const { content } = await role.json() as { content: string };
    prompts.push({
      id: workAgent.id,
      kind: 'work-agent',
      part: 'work-agent',
      label: workAgent.label,
      version: 1,
      body: content,
      relativePath: `work-agents/${workAgent.id}/agent.full.md`,
      source: 'user',
    });
  }
  setUserPromptRegistry(prompts);
  const security = getToolSecurityMetaCached();
  const composed = composeSystemPrompt({
    cwd,
    modeId: chat.modeId ?? null,
    expertId: null,
    workAgentId: workAgent?.id ?? null,
    workAgentLabel: workAgent?.label,
    skillBody: null,
    memoryBlock: null,
    codeMapBlock: null,
    contextDocumentsBlock: null,
    enabledToolIds,
    infoPresetId: meta.activeInfoPresetId,
    planGranularity: meta.planGranularity,
    flaticonIconGuidanceEnabled: meta.flaticonIconGuidanceEnabled,
    localModelGuidance: meta.localModelGuidance,
    providerIsLocal: isLocalProvider(provider),
    permissionLevel: security.permissionLevel,
    shellSandboxMode: security.shellSandbox,
  });
  if (!composed.trim()) throw new Error('No composed chat system prompt is available');
  return { composed, userRules: getUserRulesPayloadForSend(rules) };
}
