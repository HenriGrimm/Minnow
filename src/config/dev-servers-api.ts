/**
 * Multi-server workspace registry + ports API (MIN-500).
 * Legacy single-server helpers remain in startup-api.ts.
 */

import type { DevServerLifecycleStatus, DevServerNetwork } from './startup-api';

export type DevServerSource = 'startup.md' | 'user';

export interface DevServerDefinition {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  port: number;
  network: DevServerNetwork;
  healthUrl?: string;
  autoStart?: boolean;
  order?: number;
  /** Absolute git worktree path to run from (default: Code workspace). */
  worktreeRoot?: string;
  source: DevServerSource;
}

export interface DevServerListItem {
  id: string;
  name: string;
  def: DevServerDefinition | null;
  status: DevServerLifecycleStatus;
  runId: string | null;
  pid: number | null;
  healthOk: boolean | null;
  startedAt: number | null;
  portInUse: boolean;
  port: number | null;
  network: DevServerNetwork | null;
  command: string | null;
  healthUrl: string | null;
  /** Active or configured worktree root for this server. */
  worktreeRoot?: string | null;
  error: string | null;
}

export interface ListeningPortRow {
  port: number;
  address: string;
  pid: number;
  process: string;
  protected: boolean;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** List registry definitions joined with live status. */
export async function fetchDevServers(signal?: AbortSignal): Promise<DevServerListItem[]> {
  const res = await fetch('/api/workspace/dev-servers', { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`dev-servers list failed (${res.status})`);
  const json = await readJson<{ ok?: boolean; servers?: DevServerListItem[] }>(res);
  return Array.isArray(json.servers) ? json.servers : [];
}

/** Create a user-defined server row. */
export async function createDevServerApi(
  input: Partial<DevServerDefinition> & { name: string; command: string },
): Promise<DevServerDefinition> {
  const res = await fetch('/api/workspace/dev-servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const json = await readJson<{ ok?: boolean; server?: DevServerDefinition; error?: string }>(res);
  if (!res.ok || !json.server) throw new Error(json.error ?? `create failed (${res.status})`);
  return json.server;
}

/** Update a registry row (startup.md rows only accept overridable fields). */
export async function updateDevServerApi(
  id: string,
  patch: Partial<DevServerDefinition>,
): Promise<DevServerDefinition> {
  const res = await fetch(`/api/workspace/dev-servers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const json = await readJson<{ ok?: boolean; server?: DevServerDefinition; error?: string }>(res);
  if (!res.ok || !json.server) throw new Error(json.error ?? `update failed (${res.status})`);
  return json.server;
}

/** Delete a registry row (stops the run first on the server). */
export async function deleteDevServerApi(id: string): Promise<void> {
  const res = await fetch(`/api/workspace/dev-servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const json = (await readJson<{ error?: string }>(res).catch(() => ({
      error: undefined as string | undefined,
    }))) as { error?: string };
    throw new Error(json.error ?? `delete failed (${res.status})`);
  }
}

export async function postDevServerStartById(
  id: string,
  options?: { worktreeRoot?: string },
): Promise<{
  ok: boolean;
  status?: DevServerLifecycleStatus;
  runId?: string;
  worktreeRoot?: string;
  error?: string;
}> {
  const res = await fetch(`/api/workspace/dev-servers/${encodeURIComponent(id)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      options?.worktreeRoot ? { worktreeRoot: options.worktreeRoot } : {},
    ),
  });
  return readJson(res);
}

export async function postDevServerStopById(id: string): Promise<{
  ok: boolean;
  status?: DevServerLifecycleStatus;
}> {
  const res = await fetch(`/api/workspace/dev-servers/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return readJson(res);
}

export async function postDevServerRestartById(
  id: string,
  options?: { worktreeRoot?: string },
): Promise<{
  ok: boolean;
  status?: DevServerLifecycleStatus;
  runId?: string;
  worktreeRoot?: string;
  error?: string;
}> {
  const res = await fetch(`/api/workspace/dev-servers/${encodeURIComponent(id)}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      options?.worktreeRoot ? { worktreeRoot: options.worktreeRoot } : {},
    ),
  });
  return readJson(res);
}

/** Full listening-port table for the ports panel. */
export async function fetchListeningPorts(signal?: AbortSignal): Promise<ListeningPortRow[]> {
  const res = await fetch('/api/workspace/ports', { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`ports list failed (${res.status})`);
  const json = await readJson<{ ok?: boolean; ports?: ListeningPortRow[] }>(res);
  return Array.isArray(json.ports) ? json.ports : [];
}

/** Guarded kill of a listening-port owner. */
export async function postKillPortOwner(
  pid: number,
  port?: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/workspace/ports/kill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, port }),
  });
  return readJson(res);
}

/** Next free port at or above base (skipping currently listening ports). */
export async function fetchNextFreePort(base: number): Promise<number> {
  const res = await fetch(
    `/api/workspace/ports/next-free?base=${encodeURIComponent(String(base))}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`next-free port failed (${res.status})`);
  const json = await readJson<{ ok?: boolean; port?: number }>(res);
  if (typeof json.port !== 'number') throw new Error('next-free port missing');
  return json.port;
}
