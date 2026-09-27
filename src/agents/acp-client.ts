export interface AcpAgentRegistration {
  id: string;
  label: string;
  command: string;
  args: string[];
  enabled: boolean;
  envKeys: string[];
  hasPrivateEnvironment: boolean;
  createdAt: string;
  updatedAt: string;
  lastValidation?: {
    ok: boolean;
    checkedAt: string;
    protocolVersion?: number;
    agentInfo?: { name?: string; version?: string } | null;
    error?: string;
  };
}

export interface AcpValidation {
  ok: boolean;
  protocolVersion?: number;
  capabilities?: Record<string, boolean>;
  agentInfo?: { name?: string; version?: string } | null;
  authMethods?: Array<{ id: string; name: string }>;
  error?: string;
}

export interface AcpRunEvent {
  seq: number;
  at: string;
  type: 'status' | 'message' | 'thought' | 'tool' | 'plan' | 'update' | 'unsupported' | 'complete' | 'error';
  status?: string;
  text?: string;
  title?: string;
  message?: string;
  stopReason?: string;
}

export interface AcpRun {
  id: string;
  agentId: string;
  agentLabel: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  sessionId: string | null;
  stopReason: string | null;
  error: string | null;
  events: AcpRunEvent[];
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error?.trim() || `ACP request failed (${response.status})`);
  }
  return body;
}

export async function listAcpAgents(signal?: AbortSignal): Promise<AcpAgentRegistration[]> {
  const body = await requestJson<{ agents?: AcpAgentRegistration[] }>('/api/models/acp-agents', {
    cache: 'no-store',
    signal,
  });
  return body.agents ?? [];
}

export async function saveAcpAgent(
  input: Pick<AcpAgentRegistration, 'id' | 'label' | 'command' | 'args' | 'enabled'> & {
    secretEnv?: Record<string, string>;
  },
  exists = false,
): Promise<AcpAgentRegistration> {
  const url = exists
    ? `/api/models/acp-agents/${encodeURIComponent(input.id)}`
    : '/api/models/acp-agents';
  const body = await requestJson<{ agent: AcpAgentRegistration }>(url, {
    method: exists ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return body.agent;
}

export async function verifyAcpAgent(
  id: string,
  workspaceRoot?: string,
): Promise<AcpValidation> {
  const response = await fetch(`/api/models/acp-agents/${encodeURIComponent(id)}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceRoot }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    validation?: AcpValidation;
    error?: string;
  };
  if (!body.validation) throw new Error(body.error || `ACP verification failed (${response.status})`);
  return body.validation;
}

export async function startAcpAgentRun(
  id: string,
  prompt: string,
  workspaceRoot?: string,
): Promise<AcpRun> {
  const body = await requestJson<{ run: AcpRun }>(
    `/api/models/acp-agents/${encodeURIComponent(id)}/runs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, workspaceRoot }),
    },
  );
  return body.run;
}

export async function getAcpAgentRun(id: string, since = 0): Promise<AcpRun> {
  const body = await requestJson<{ run: AcpRun }>(
    `/api/models/acp-runs/${encodeURIComponent(id)}?since=${since}`,
    { cache: 'no-store' },
  );
  return body.run;
}

export async function cancelAcpAgentRun(id: string): Promise<AcpRun> {
  const body = await requestJson<{ run: AcpRun }>(
    `/api/models/acp-runs/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' },
  );
  return body.run;
}
