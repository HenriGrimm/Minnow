export type AgentCliKind = 'claude' | 'codex' | 'cursor';

export type AgentCliAuthStatus = 'signed-in' | 'token' | 'unknown' | 'signed-out';

export interface AgentCliStatus {
  kind: AgentCliKind;
  providerId: string;
  label: string;
  installed: boolean;
  authStatus: AgentCliAuthStatus;
  enabled: boolean;
  version?: string;
  binPath?: string;
  binPathOverride?: string;
  hasCliToken: boolean;
  allowUtilityRoles: boolean;
  maxConcurrent: number;
  maxBudgetUsd?: number;
  sessionMode: 'replay';
  installCommand: string;
  loginCommand: string;
  checkedAt: string;
  verifiedAt?: string;
}

export interface AgentCliSettingsPatch {
  binPath?: string | null;
  allowUtilityRoles?: boolean;
  maxConcurrent?: number;
  maxBudgetUsd?: number | null;
}

interface AgentCliResponse {
  agentCli: AgentCliStatus;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error?.trim() || `Agent CLI request failed (${response.status})`);
  }
  return body;
}

function cliUrl(kind: AgentCliKind, action: string): string {
  return `/api/models/agent-clis/${encodeURIComponent(kind)}/${action}`;
}

export async function listAgentClis(signal?: AbortSignal): Promise<AgentCliStatus[]> {
  const body = await requestJson<{ agentClis?: AgentCliStatus[] }>('/api/models/agent-clis', {
    cache: 'no-store',
    signal,
  });
  return body.agentClis ?? [];
}

export async function verifyAgentCli(
  kind: AgentCliKind,
  signal?: AbortSignal,
): Promise<AgentCliStatus> {
  const body = await requestJson<AgentCliResponse>(cliUrl(kind, 'verify'), {
    method: 'POST',
    signal,
  });
  return body.agentCli;
}

export async function setAgentCliEnabled(
  kind: AgentCliKind,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<AgentCliStatus> {
  const body = await requestJson<AgentCliResponse>(cliUrl(kind, 'enable'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
    signal,
  });
  return body.agentCli;
}

export async function updateAgentCliSettings(
  kind: AgentCliKind,
  settings: AgentCliSettingsPatch,
  signal?: AbortSignal,
): Promise<AgentCliStatus> {
  const body = await requestJson<AgentCliResponse>(cliUrl(kind, 'settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
    signal,
  });
  return body.agentCli;
}
