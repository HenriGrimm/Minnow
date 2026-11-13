import { interpolatePromptBody } from '../chat/prompts/interpolate';
import { loadPromptById } from '../chat/prompts/prompt-loader';
import { fetchPromptFile } from '../chat/prompts/prompt-file-api';
import { detectConfigServer, isServerStorageMode } from '../config/storage-mode';
import { fetchMemoryEnabled, retrieveMemoryBlock } from '../memory/client';
import {
  fetchMemoryInjectionEnabled,
  isMemoryEnabledForChat,
} from '../memory/config';
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

const SUB_AGENT_SAVE_MEMORY_RULES = `

### Brain wiki (sub-agent)
Notes below are from the Brain wiki — treat as context and verify against the codebase.
Use \`brain_search\` for fuzzy lookup; \`brain_read_page\` / \`brain_write_page\` for structured pages; \`save_memory\` for quick facts under pages/facts/. Skip secrets and one-off state. Confirm only after a write tool succeeds.
Before returning, make one \`save_memory\` call **only if** your task produced a user correction, a root cause that took real digging (symptom → cause → fix), a decision + why with rejected alternatives, an approach that failed, or a discovered convention/environment quirk. Give it a specific searchable title; at most one page. Otherwise save nothing.`;

export async function appendSubAgentMemorySection(
  systemPrompt: string,
  task: string,
  enabledToolNames: string[],
  parentChat?: Chat | null,
): Promise<string> {
  const injectionOn = await fetchMemoryInjectionEnabled();
  if (!injectionOn) {
    return appendSubAgentSaveMemoryRules(systemPrompt, enabledToolNames);
  }
  const globalEnabled = await fetchMemoryEnabled();
  const inject = parentChat
    ? isMemoryEnabledForChat(parentChat, globalEnabled)
    : globalEnabled;
  if (!inject) {
    return appendSubAgentSaveMemoryRules(systemPrompt, enabledToolNames);
  }

  const block = await retrieveMemoryBlock({ query: task });

  let result = systemPrompt;
  if (block.trim()) {
    const loaded = loadPromptById('info', 'memory');
    const template = loaded?.body?.trim() ?? 'Prior notes:\n\n{{memory}}';
    const section = interpolatePromptBody(template, {
      mode: '',
      mode_label: '',
      profile: 'full',
      expert: '',
      cwd: '',
      memory: block,
      user_message: task,
      work_agent: '',
      work_agent_label: '',
      skill: '',
      date: new Date().toISOString().slice(0, 10),
      os: typeof navigator !== 'undefined' ? navigator.platform : 'node',
      plan_granularity: '',
      orchestrate_plan: '',
      permission_line: '',
    });
    if (section.trim()) {
      result = `${result}\n\n---\n\n${section.trim()}`;
    }
  }

  return appendSubAgentSaveMemoryRules(result, enabledToolNames);
}

function appendSubAgentSaveMemoryRules(
  systemPrompt: string,
  enabledToolNames: string[],
): string {
  const hasBrainTool = enabledToolNames.some((name) =>
    ['save_memory', 'brain_search', 'brain_read_page', 'brain_write_page'].includes(name),
  );
  if (!hasBrainTool) {
    return systemPrompt;
  }
  if (systemPrompt.includes('brain_search') || systemPrompt.includes('save_memory')) {
    return systemPrompt;
  }
  return `${systemPrompt}${SUB_AGENT_SAVE_MEMORY_RULES}`;
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
