import {
  getToolSecurityMetaCached,
  loadToolSecurityMeta,
  type ShellSandboxMode,
} from '../config/tool-security-meta';
import { loadAutopilotMeta } from '../config/autopilot-meta';

export interface SandboxStatusPayload {
  available: boolean;
  kind: string;
  reason: string | null;
  detail: string | null;
  mode: ShellSandboxMode;
  allowUnsandboxed: boolean;
  platform?: string;
  requireSupported?: boolean;
}

let statusCache: { at: number; payload: SandboxStatusPayload } | null = null;
const STATUS_TTL_MS = 30_000;

/** Fetch probe + modes from the tool server (cached briefly). */
export async function fetchSandboxStatus(force = false): Promise<SandboxStatusPayload | null> {
  const now = Date.now();
  if (!force && statusCache && now - statusCache.at < STATUS_TTL_MS) {
    return statusCache.payload;
  }
  try {
    const res = await fetch('/api/terminal/sandbox-status', { cache: 'no-store' });
    if (!res.ok) return null;
    const payload = (await res.json()) as SandboxStatusPayload;
    statusCache = { at: now, payload };
    return payload;
  } catch {
    return null;
  }
}

function clampShellSandboxForClient(mode: ShellSandboxMode): ShellSandboxMode {
  if (typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent) && mode === 'require') {
    return 'prefer';
  }
  return mode;
}

/** Resolve the configured shell sandbox mode on this platform. */
export function resolveShellSandboxModeForChat(_chatId?: string): ShellSandboxMode {
  return clampShellSandboxForClient(getToolSecurityMetaCached().shellSandbox);
}

/** Warm caches used by the permission gate. */
export async function ensureShellSandboxCaches(): Promise<void> {
  await Promise.all([loadToolSecurityMeta(), loadAutopilotMeta(), fetchSandboxStatus()]);
}

export const SHELL_SANDBOX_TOOL_IDS = new Set([
  'execute_command',
  'run_javascript',
  'run_python',
  'start_background_command',
]);
