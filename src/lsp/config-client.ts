/**
 * Browser client for LSP config and status (npm start required).
 */

import { isLocalServerAvailable } from '../tools/config';

/** Install requirements from defaults (display-only; not probed on disk). */
export interface LspServerRequirements {
  package?: string;
  binary?: string;
  command?: string;
}

/** Single server row from GET /api/config/lsp */
export interface LspServerStatus {
  id: string;
  label: string;
  disabled: boolean;
  running: boolean;
  extensions: string[];
  builtin: boolean;
  hasCommand: boolean;
  requirements?: LspServerRequirements;
  disabledReason?: string;
  defaultEnabled?: boolean;
}

/** Merged LSP config from GET /api/config/lsp */
export interface LspConfigResponse {
  enabled: boolean;
  /** LSP languageIds that receive textDocument/formatting on save (opt-in; default none). */
  formatOnSaveLanguageIds?: string[];
  lsp: Record<string, LspServerConfig>;
  servers: LspServerStatus[];
}

/** Per-server config shape in ~/.minnow/lsp.json */
export interface LspServerConfig {
  disabled?: boolean;
  command?: string[];
  extensions?: string[];
  label?: string;
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  transport?: { type: 'godot' };
  /** Workspace-relative Godot root when a workspace contains multiple projects. */
  project?: string;
}

/** Partial update for PUT /api/config/lsp */
export interface LspConfigPatch {
  enabled?: boolean;
  formatOnSaveLanguageIds?: string[];
  lsp?: Record<string, LspServerConfig>;
  removeLspIds?: string[];
}

async function lspFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!isLocalServerAvailable()) return null;
  try {
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Load merged LSP config and server status list. */
export async function fetchLspConfig(): Promise<LspConfigResponse | null> {
  return lspFetch<LspConfigResponse>('/api/config/lsp');
}

/** Persist partial user overrides to ~/.minnow/lsp.json */
export async function saveLspConfig(patch: LspConfigPatch): Promise<boolean> {
  if (!isLocalServerAvailable()) return false;
  try {
    const res = await fetch('/api/config/lsp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Lightweight status poll (master switch + running flags). */
export async function fetchLspStatus(): Promise<{
  enabled: boolean;
  servers: LspServerStatus[];
} | null> {
  return lspFetch<{ enabled: boolean; servers: LspServerStatus[] }>(
    '/api/lsp/status',
  );
}

/** Install progress for a language server bundle job. */
export interface LspBundleJob {
  bundleId: string;
  phase: 'pending' | 'downloading' | 'installing' | 'done' | 'error';
  percent: number;
  message: string;
  error?: string;
}

/** Single bundle row from GET /api/lsp/bundles */
export interface LspBundleStatus {
  id: string;
  label: string;
  description?: string;
  kind: 'npm' | 'binary' | 'go';
  categoryId?: string;
  categoryLabel?: string;
  /** LSP server ids in defaults.json tied to this bundle (from bundles.json). */
  lspIds?: string[];
  installed: boolean;
  version: string | null;
  sizeBytes: number;
  prebundled?: boolean;
  sizeEstimateMb?: number;
  job?: LspBundleJob | null;
}

export interface LspBundlesResponse {
  categories: Array<{
    id: string;
    label: string;
    bundles: LspBundleStatus[];
  }>;
}

/** Catalog + install state for Language bundles settings UI. */
export async function fetchLspBundles(): Promise<LspBundlesResponse | null> {
  return lspFetch<LspBundlesResponse>('/api/lsp/bundles');
}

/** Poll install/uninstall progress for one bundle. */
export async function fetchLspBundleProgress(
  bundleId: string,
): Promise<{ job: LspBundleJob | null } | null> {
  return lspFetch<{ job: LspBundleJob | null }>(
    `/api/lsp/bundles/progress?bundleId=${encodeURIComponent(bundleId)}`,
  );
}

/** Install a language server bundle to ~/.minnow/lsp-servers. */
export async function installLspBundle(
  bundleId: string,
): Promise<{ ok: boolean; error?: string; alreadyInstalled?: boolean }> {
  if (!isLocalServerAvailable()) return { ok: false, error: 'Server offline' };
  try {
    const res = await fetch('/api/lsp/bundles/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundleId }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      alreadyInstalled?: boolean;
    };
    if (!res.ok) {
      return { ok: false, error: body.error ?? res.statusText };
    }
    return { ok: true, alreadyInstalled: body.alreadyInstalled === true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a managed bundle from ~/.minnow/lsp-servers. */
export async function uninstallLspBundle(bundleId: string): Promise<boolean> {
  if (!isLocalServerAvailable()) return false;
  try {
    const res = await fetch('/api/lsp/bundles/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundleId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface GodotRuntimeStatus {
  ok: boolean;
  status: string;
  installAvailable?: boolean;
  engine?: {
    path: string | null;
    source: string;
    error?: string;
    version?: { raw?: string } | string;
  };
  managedInstall?: { version?: string; executable?: string } | null;
}

/** Detect a system/portable/managed Godot runtime for the current workspace. */
export async function fetchGodotRuntimeStatus(): Promise<GodotRuntimeStatus | null> {
  return lspFetch<GodotRuntimeStatus>('/api/godot/status');
}

/** Install the latest stable official Godot 4 build under ~/.minnow. */
export async function installGodotRuntime(): Promise<{ ok: boolean; error?: string }> {
  if (!isLocalServerAvailable()) return { ok: false, error: 'Server offline' };
  try {
    const response = await fetch('/api/godot/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return response.ok ? { ok: true } : { ok: false, error: body.error ?? response.statusText };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
