/**
 * Tool security prefs from config.json → toolSecurity: the one system-wide
 * permission level (Manual / Auto / Full access) plus the shell sandbox.
 *
 * Filesystem reach is derived from the level (Full access = whole disk), so
 * there is no separate filesystem toggle any more.
 */

import {
  DEFAULT_PERMISSION_LEVEL,
  normalizePermissionLevel,
  type PermissionLevel,
} from '../lib/permissions.mjs';

export type { PermissionLevel } from '../lib/permissions.mjs';

export type FilesystemAccessMode = 'workspace' | 'full';

/** Agent shell sandbox mode (MIN-553 Phase 3). */
export type ShellSandboxMode = 'off' | 'prefer' | 'require';

export interface ToolSecurityMeta {
  permissionLevel: PermissionLevel;
  /** Derived from `permissionLevel` (read-only; never persisted). */
  filesystemAccess: FilesystemAccessMode;
  shellSandbox: ShellSandboxMode;
  /** Prefer-mode "Always allow" unsandboxed fallback when the OS sandbox is unavailable. */
  allowUnsandboxedShell: boolean;
}

const DEFAULT_TOOL_SECURITY: ToolSecurityMeta = {
  permissionLevel: DEFAULT_PERMISSION_LEVEL,
  filesystemAccess: 'workspace',
  shellSandbox: 'off',
  allowUnsandboxedShell: false,
};

let cached: ToolSecurityMeta | null = null;

/** True after the first load attempt finished (success or fallback). */
let metaLoaded = false;

/** Deduplicate overlapping loadToolSecurityMeta calls. */
let loadPromise: Promise<ToolSecurityMeta> | null = null;

const listeners = new Set<(meta: ToolSecurityMeta) => void>();

function normalizeShellSandbox(value: unknown): ShellSandboxMode {
  if (value === 'off' || value === 'prefer' || value === 'require') return value;
  return 'off';
}

/** Coerce unknown API payload into a valid toolSecurity block. */
export function normalizeToolSecurityMeta(raw: unknown): ToolSecurityMeta {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_TOOL_SECURITY };
  }
  const row = raw as Record<string, unknown>;
  const permissionLevel = normalizePermissionLevel(row.permissionLevel);
  return {
    permissionLevel,
    filesystemAccess: permissionLevel === 'full' ? 'full' : 'workspace',
    shellSandbox: normalizeShellSandbox(row.shellSandbox),
    allowUnsandboxedShell: row.allowUnsandboxedShell === true,
  };
}

/** Load tool security prefs from config API (defaults when missing). */
export async function loadToolSecurityMeta(): Promise<ToolSecurityMeta> {
  if (cached) return cached;
  if (loadPromise) return loadPromise;

  loadPromise = (async (): Promise<ToolSecurityMeta> => {
    try {
      const res = await fetch('/api/config/meta', { cache: 'no-store' });
      if (!res.ok) {
        cached = { ...DEFAULT_TOOL_SECURITY };
        return cached;
      }
      const meta = (await res.json()) as { toolSecurity?: unknown };
      cached = normalizeToolSecurityMeta(meta.toolSecurity);
      return cached;
    } catch {
      cached = { ...DEFAULT_TOOL_SECURITY };
      return cached;
    } finally {
      metaLoaded = true;
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/** Persist tool security via PUT /api/config/meta (partial merge). */
export async function saveToolSecurityMeta(
  patch: Partial<Omit<ToolSecurityMeta, 'filesystemAccess'>>,
): Promise<void> {
  const current = await loadToolSecurityMeta();
  const permissionLevel = normalizePermissionLevel(patch.permissionLevel ?? current.permissionLevel);
  const next: ToolSecurityMeta = {
    permissionLevel,
    filesystemAccess: permissionLevel === 'full' ? 'full' : 'workspace',
    shellSandbox: patch.shellSandbox ?? current.shellSandbox,
    allowUnsandboxedShell:
      patch.allowUnsandboxedShell !== undefined
        ? patch.allowUnsandboxedShell
        : current.allowUnsandboxedShell,
  };
  cached = next;
  for (const fn of listeners) {
    try { fn(next); } catch { /* ignore listener errors */ }
  }
  const { filesystemAccess: _derived, ...persisted } = next;
  await fetch('/api/config/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolSecurity: persisted }),
  });
}

/** The system-wide permission level (cached; call loadToolSecurityMeta during init). */
export function getPermissionLevelCached(): PermissionLevel {
  return (cached ?? DEFAULT_TOOL_SECURITY).permissionLevel;
}

/** Set the system-wide permission level (composer pill, Settings, Shift+Tab). */
export async function setPermissionLevel(level: PermissionLevel): Promise<void> {
  await saveToolSecurityMeta({ permissionLevel: level });
}

/** Subscribe to level / sandbox changes made in this window. */
export function onToolSecurityMetaChange(fn: (meta: ToolSecurityMeta) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Apply a value pushed from another window/device without re-saving it. */
export function applyRemoteToolSecurityMeta(raw: unknown): void {
  cached = normalizeToolSecurityMeta(raw);
  metaLoaded = true;
  for (const fn of listeners) {
    try { fn(cached); } catch { /* ignore listener errors */ }
  }
}

/** Cached value for synchronous gates (call loadToolSecurityMeta during init). */
export function getToolSecurityMetaCached(): ToolSecurityMeta {
  return cached ?? { ...DEFAULT_TOOL_SECURITY };
}

/** Whether tool security has been fetched at least once this session. */
export function isToolSecurityMetaLoaded(): boolean {
  return metaLoaded;
}

/** Reset cache (tests). */
export function resetToolSecurityMetaCache(): void {
  cached = null;
  metaLoaded = false;
  loadPromise = null;
  listeners.clear();
}
