/**
 * Dev server preflight: ping config + tools (+ optional spawn).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { headlessApiUrl, normalizeBaseUrl, resolveHeadlessToken } from './server-context';

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface WaitForServerOptions {
  baseUrl: string;
  timeoutSec: number;
  /** Session token override; defaults to MINNOW_TOKEN env or ~/.minnow/session-token. */
  token?: string | null;
  log?: (line: string) => void;
}

/** Poll GET /api/config/ping and /api/tools/ping until both succeed. */
export async function waitForServer(options: WaitForServerOptions): Promise<boolean> {
  const base = normalizeBaseUrl(options.baseUrl);
  const log = options.log ?? (() => undefined);
  const deadline = Date.now() + options.timeoutSec * 1000;

  while (Date.now() < deadline) {
    const token = resolveHeadlessToken(options.token);
    try {
      const [configOk, toolsOk] = await Promise.all([
        pingEndpoint(`${base}/api/config/ping`, token),
        pingEndpoint(`${base}/api/tools/ping`, token),
      ]);
      if (configOk && toolsOk) {
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`Timed out after ${options.timeoutSec}s waiting for ${base}`);
  return false;
}

async function pingEndpoint(url: string, token: string): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (token) headers['X-Minnow-Token'] = token;
  const res = await fetch(url, { cache: 'no-store', headers });
  if (!res.ok) return false;
  const body = (await res.json()) as { ok?: boolean };
  return body.ok === true;
}

export interface SpawnServerOptions {
  minnowHome?: string | null;
  log?: (line: string) => void;
}

let serverChild: ReturnType<typeof spawn> | null = null;

/** Spawn server.js with BROWSER=none; returns child handle. */
export function spawnMinnowServer(options: SpawnServerOptions = {}): ReturnType<typeof spawn> {
  const log = options.log ?? (() => undefined);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BROWSER: 'none',
    MINNOW_HEADLESS: '1',
  };
  if (options.minnowHome) {
    env.MINNOW_HOME = options.minnowHome;
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (buf) => log(String(buf).trimEnd()));
  child.stderr?.on('data', (buf) => log(String(buf).trimEnd()));
  serverChild = child;
  return child;
}

/** Kill spawned server child if any. */
export function stopSpawnedServer(): void {
  if (!serverChild) return;
  serverChild.kill('SIGTERM');
  serverChild = null;
}

/**
 * Claim the run's folder in the server's open-workspace registry.
 *
 * This replaces the old `PUT /api/workspace`, which was a *global* repoint: a
 * scheduled headless job would move the desktop UI's workspace out from under
 * the user mid-session. Registering instead only widens the filesystem
 * allowlist to this folder; the run then names it on every request via
 * `X-Minnow-Workspace`.
 */
export async function openWorkspace(baseUrl: string, workspacePath: string): Promise<void> {
  const res = await fetch(headlessApiUrl('/api/workspace/open'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: workspacePath }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/workspace/open failed: HTTP ${res.status} ${text}`);
  }
  await res.arrayBuffer();
}

/** Release the claim when the run finishes. Best-effort: never fails the run. */
export async function closeWorkspace(baseUrl: string, workspacePath: string): Promise<void> {
  try {
    const response = await fetch(headlessApiUrl('/api/workspace/open'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: workspacePath }),
    });
    await response.arrayBuffer();
  } catch {
    // The server may already be gone; the registry is in-memory anyway.
  }
}
