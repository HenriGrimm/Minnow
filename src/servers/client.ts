/**
 * Browser client for managed local servers (GET /api/servers/*).
 */

/** Runtime phase from GET /api/servers. */
export type ServerRuntimePhase =
  | 'pending'
  | 'installing'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error';

/** Install job progress (POST /install and list payload). */
export type ServerInstallJobPhase = 'pending' | 'installing' | 'done' | 'error';

export interface ServerInstallJob {
  serverId: string;
  phase: ServerInstallJobPhase;
  percent: number;
  message: string;
  error?: string;
}

/** Catalog row merged with servers.json and process state. */
export interface ManagedServerSummary {
  id: string;
  label: string;
  description: string;
  kind: string;
  healthPath: string;
  enabled: boolean;
  autoStart: boolean;
  port: number;
  defaultPort: number;
  installed: boolean;
  version?: string;
  running: boolean;
  phase: ServerRuntimePhase;
  job: ServerInstallJob | null;
  /** Host can run this runtime (mlx-lm is Apple Silicon only). */
  supported?: boolean;
  /** Settings may offer Install when true; false hides a working Install button. */
  installable?: boolean;
  /** Why Install is unavailable (e.g. MLX off-platform). */
  reason?: string | null;
  /** Detected MTPLX CLI and Mac app, which can share one runtime. */
  path?: string | null;
  source?: 'app' | 'path' | 'user' | null;
  appPath?: string | null;
  appVersion?: string | null;
}

/** Whether the Servers API is reachable (npm start). */
export async function pingServersApi(): Promise<boolean> {
  try {
    const res = await fetch('/api/servers/ping', { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** Load managed servers from the Node API. */
export async function fetchManagedServers(): Promise<ManagedServerSummary[] | null> {
  try {
    const res = await fetch('/api/servers');
    if (!res.ok) return null;
    const body = (await res.json()) as { servers?: ManagedServerSummary[] };
    return Array.isArray(body.servers) ? body.servers : [];
  } catch {
    return null;
  }
}

/** Managed SearXNG loopback URL when enabled and running; otherwise null. */
export function getManagedSearxngActiveUrl(
  servers: ManagedServerSummary[],
): string | null {
  const searxng = servers.find((s) => s.id === 'searxng');
  if (!searxng?.enabled || !searxng.running) return null;
  return `http://127.0.0.1:${searxng.port}`;
}

/** GET /api/servers/:id install status + job. */
export async function fetchServerInstallStatus(
  serverId: string,
): Promise<ServerInstallJob | null> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      status?: { job?: ServerInstallJob | null };
    };
    return body.status?.job ?? null;
  } catch {
    return null;
  }
}

/** POST install — returns job for polling. */
export async function installManagedServer(
  serverId: string,
): Promise<
  | { ok: true; alreadyInstalled?: boolean; inProgress?: boolean; job?: ServerInstallJob | null }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/install`, {
      method: 'POST',
    });
    const body = (await res.json()) as {
      ok?: boolean;
      alreadyInstalled?: boolean;
      inProgress?: boolean;
      job?: ServerInstallJob | null;
      error?: string;
    };
    if (!res.ok) {
      return { ok: false, error: body.error ?? 'Install failed' };
    }
    return {
      ok: true,
      alreadyInstalled: body.alreadyInstalled,
      inProgress: body.inProgress,
      job: body.job ?? null,
    };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

export async function startManagedServer(
  serverId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/start`, {
      method: 'POST',
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) {
      return { ok: false, error: body.error ?? 'Start failed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

export async function stopManagedServer(
  serverId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/stop`, {
      method: 'POST',
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) {
      return { ok: false, error: body.error ?? 'Stop failed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

export async function restartManagedServer(
  serverId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/restart`, {
      method: 'POST',
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) {
      return { ok: false, error: body.error ?? 'Restart failed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

export async function uninstallManagedServer(
  serverId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Tail of ring-buffer logs. */
export async function fetchManagedServerLogs(
  serverId: string,
): Promise<string[] | null> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/logs`);
    if (!res.ok) return null;
    const body = (await res.json()) as { lines?: string[] };
    return Array.isArray(body.lines) ? body.lines : [];
  } catch {
    return null;
  }
}

export async function setManagedServerEnabled(
  serverId: string,
  enabled: boolean,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function setManagedServerAutoStart(
  serverId: string,
  autoStart: boolean,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/autostart`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoStart }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function setManagedServerPort(
  serverId: string,
  port: number,
): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/port`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    const body = (await res.json()) as { server?: { port?: number }; error?: string };
    if (!res.ok) {
      return { ok: false, error: body.error ?? 'Invalid port' };
    }
    return { ok: true, port: body.server?.port ?? port };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}
