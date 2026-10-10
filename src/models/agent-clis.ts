export type AgentCliKind = 'claude' | 'codex' | 'cursor';

export type AgentCliAuthStatus = 'signed-in' | 'token' | 'unknown' | 'signed-out';

export interface AgentCliUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface AgentCliAccountUsage {
  kind: AgentCliKind;
  status: 'ready' | 'stale' | 'signed-out' | 'unsupported' | 'unavailable' | 'error';
  windows: AgentCliUsageWindow[];
  plan: string | null;
  credits?: { unlimited: boolean; balance: string | null };
  fetchedAt: string | null;
  checkedAt: string;
  retryAt: string | null;
  message: string | null;
}

export function agentCliUsageKind(providerId: string | undefined): 'codex' | 'claude' | null {
  return providerId === 'codex-cli' ? 'codex' : providerId === 'claude-code-cli' ? 'claude' : null;
}

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
  contextWindowTokens?: number;
  sessionMode: 'auto' | 'replay';
  transport?: 'app-server' | 'stream-json' | 'claude-interactive' | 'acp' | 'replay';
  restartResumeSupported?: boolean;
  fallbackReason?: string;
  installCommand: string;
  loginCommand: string;
  updateCommand: string;
  checkedAt: string;
  verifiedAt?: string;
}

export interface AgentCliSettingsPatch {
  binPath?: string | null;
  allowUtilityRoles?: boolean;
  maxConcurrent?: number;
  maxBudgetUsd?: number | null;
  contextWindowTokens?: number | null;
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

export async function fetchAgentCliAccountUsage(
  kind: AgentCliKind,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<AgentCliAccountUsage> {
  const body = await requestJson<{ usage: AgentCliAccountUsage }>(
    `${cliUrl(kind, 'usage')}${options.refresh ? '?refresh=1' : ''}`,
    { cache: 'no-store', signal: options.signal },
  );
  return body.usage;
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

/** Close idle Minnow-owned CLI processes so the vendor updater can replace their files. */
export async function prepareAgentCliUpdate(
  kind: AgentCliKind,
  signal?: AbortSignal,
): Promise<AgentCliStatus> {
  const body = await requestJson<AgentCliResponse>(cliUrl(kind, 'prepare-update'), {
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
