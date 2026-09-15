import { mergeUserWorkAgentOverride } from './work-agent-registry';
import type { ContextEnforcementPolicy } from '../chat/context-budget';

export type WorkAgentPromptProfile = 'full' | 'lite';

export interface WorkAgentPromptResponse {
  content: string;
  source: 'builtin' | 'override';
}

export async function fetchWorkAgentPrompt(
  agentId: string,
  profile: WorkAgentPromptProfile = 'full',
): Promise<WorkAgentPromptResponse | null> {
  try {
    const res = await fetch(
      `/api/work-agents/${encodeURIComponent(agentId)}/prompt?profile=${profile}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as WorkAgentPromptResponse;
  } catch {
    return null;
  }
}

export async function fetchWorkAgentBuiltinBaseline(
  agentId: string,
  profile: WorkAgentPromptProfile = 'full',
): Promise<WorkAgentPromptResponse | null> {
  try {
    const res = await fetch(
      `/api/work-agents/${encodeURIComponent(agentId)}/prompt?profile=${profile}&baseline=builtin`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as WorkAgentPromptResponse;
  } catch {
    return null;
  }
}

export async function resetWorkAgentPromptOverride(
  agentId: string,
  profile: WorkAgentPromptProfile,
): Promise<WorkAgentPromptResponse | null> {
  try {
    const res = await fetch(
      `/api/work-agents/${encodeURIComponent(agentId)}/prompt?profile=${profile}`,
      { method: 'DELETE' },
    );
    if (!res.ok) return null;
    return (await res.json()) as WorkAgentPromptResponse;
  } catch {
    return null;
  }
}

export async function saveWorkAgentPromptOverride(
  agentId: string,
  profile: WorkAgentPromptProfile,
  content: string,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/work-agents/${encodeURIComponent(agentId)}/prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, content }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function patchWorkAgentOverride(
  agentId: string,
  patch: {
    providerId?: string | null;
    modelId?: string | null;
    disabled?: boolean;
    maxInputTokens?: number | null;
    contextEnforcementPolicy?: ContextEnforcementPolicy | null;
    minRecentTurns?: number;
    summaryReserveTokens?: number;
    sampler?: import('./sampler-types').SamplerPreset | null;
    thinkingMode?: import('./thinking-types').ThinkingTriState | null;
  },
): Promise<import('./work-agent-types').WorkAgentDefinition | null> {
  try {
    const res = await fetch(`/api/work-agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { agent: import('./work-agent-types').WorkAgentDefinition };
    mergeUserWorkAgentOverride(agentId, patch as import('./work-agent-types').WorkAgentUserOverride);
    return data.agent ?? null;
  } catch {
    return null;
  }
}

export async function fetchWorkAgentsList(): Promise<{
  agents: import('./work-agent-types').WorkAgentDefinition[];
} | null> {
  try {
    const res = await fetch('/api/work-agents', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as { agents: import('./work-agent-types').WorkAgentDefinition[] };
  } catch {
    return null;
  }
}
