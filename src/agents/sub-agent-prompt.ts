import { loadPromptById } from '../chat/prompts/prompt-loader';
import { fetchPromptFile } from '../chat/prompts/prompt-file-api';
import { detectConfigServer, isServerStorageMode } from '../config/storage-mode';
import type { Chat } from '../types';
import { SHIPPED_SUB_AGENT_PROMPTS } from './shipped-sub-agent-prompts';
import { getWorkAgentPromptOverride } from './work-agent-registry';
import { fetchWorkAgentPrompt } from './work-agent-prompt-api';
import type { SubAgentTypeConfig } from './types';
import { UNTRUSTED_CONTEXT_POLICY_FULL } from '../lib/untrusted.mjs';

function loadShippedSubAgentPrompt(typeId: string): string {
  const key = `${typeId}`;
  return SHIPPED_SUB_AGENT_PROMPTS[key]?.trim() ?? '';
}

export async function resolveSubAgentBasePrompt(
  typeId: string,
  typeConfig: SubAgentTypeConfig,
): Promise<string> {
  if (typeConfig.workAgentId) {
    const override = getWorkAgentPromptOverride(typeConfig.workAgentId);
    if (override) return override;

    const fetched = await fetchWorkAgentPrompt(typeConfig.workAgentId);
    if (fetched?.content?.trim()) return fetched.content.trim();
  }


  await detectConfigServer();
  if (isServerStorageMode()) {
    const fromApi = await fetchPromptFile('sub-agents', typeId);
    if (fromApi?.content?.trim()) return fromApi.content.trim();
  }

  const shipped = loadShippedSubAgentPrompt(typeId);
  if (shipped) return shipped;

  return `You are a focused sub-agent (${typeId}). Complete tasks efficiently and return a concise summary.`;
}

const SUB_AGENT_UNTRUSTED_POLICY = `

### Untrusted external data
${UNTRUSTED_CONTEXT_POLICY_FULL}`;

const SUB_AGENT_ASK_QUESTION_RULES = `

### User choices (sub-agent)
When you need the user to pick among options, priorities, or approvals, call \`ask_question\` — do not list numbered or lettered choices in prose.`;

export function appendSubAgentAskQuestionRules(
  systemPrompt: string,
  enabledToolNames: string[],
): string {
  if (!enabledToolNames.includes('ask_question')) {
    return systemPrompt;
  }
  if (systemPrompt.includes('ask_question')) {
    return systemPrompt;
  }
  return `${systemPrompt}${SUB_AGENT_ASK_QUESTION_RULES}`;
}

const SUB_AGENT_MEMORY_FALLBACK = `### Project memory (sub-agent)
Search project memory with \`memory_search\` when the task touches earlier decisions or a familiar-looking problem, and read a match with \`memory_read\` before relying on it. You can't save or forget memories: report anything a future agent would need to whoever assigned the task.`;

/**
 * Append the read-only memory policy when memory tools are enabled. Nothing is
 * retrieved or injected: sub-agents search memory on demand.
 */
export async function appendSubAgentMemorySection(
  systemPrompt: string,
  _task: string,
  enabledToolNames: string[],
  _parentChat?: Chat | null,
): Promise<string> {
  if (!enabledToolNames.includes('memory_search') || /#{2,3} Project memory/.test(systemPrompt)) {
    return systemPrompt;
  }
  const body = loadPromptById('tool-usage', 'memory-readonly')?.body?.trim() || SUB_AGENT_MEMORY_FALLBACK;
  return `${systemPrompt}\n\n${body}`;
}

export async function buildSubAgentSystemPrompt(
  typeId: string,
  task: string,
  typeConfig: SubAgentTypeConfig,
  enabledToolNames: string[] = [],
  parentChat?: Chat | null,
): Promise<string> {
  const base = await resolveSubAgentBasePrompt(typeId, typeConfig);
  const envelope = `${base}

---

You are a sub-agent (type: ${typeId}). Complete the following task. You cannot spawn other sub-agents.
When finished, submit a structured JSON outcome (summary, findings, artifacts). Put actionable details in findings: severity, exact path and line, trigger/scenario, evidence, and suggested fix. Include validation results and limitations. The parent must be able to assess your result without reading your transcript.

Task:
${task}`;
  const withMemory = await appendSubAgentMemorySection(
    envelope,
    task,
    enabledToolNames,
    parentChat,
  );
  const withUntrustedPolicy = `${withMemory}${SUB_AGENT_UNTRUSTED_POLICY}`;
  return appendSubAgentAskQuestionRules(withUntrustedPolicy, enabledToolNames);
}
