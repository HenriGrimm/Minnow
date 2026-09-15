/**
 * Browser client for MCP server settings (GET /api/mcp/servers).
 */

import { refreshMcpToolCache } from '../tools/client';

/** Summary row returned by GET /api/mcp/servers. */
export type McpServerSummary = {
  id: string;
  label: string;
  description: string;
  builtin: boolean;
  enabled: boolean;
  connected: boolean;
  authorizationUrl?: string;
  error?: string;
};

export async function importMcpServers(payload: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/mcp/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) return { ok: false, error: body.error ?? 'Could not add MCP servers' };
    await refreshMcpToolCache();
    return { ok: true };
  } catch { return { ok: false, error: 'Could not add MCP servers. Check the configuration and try again.' }; }
}

/** Public MCP secret flags from GET /api/mcp/secrets (values never returned). */
export type McpSecretsFlags = {
  hasContext7ApiKey: boolean;
};

/** Whether the local server exposes the MCP API. */
export async function pingMcpApi(): Promise<boolean> {
  try {
    const res = await fetch('/api/mcp/ping', { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** Load MCP servers from ~/.minnow/mcp via the Node API. */
export async function fetchMcpServers(): Promise<McpServerSummary[] | null> {
  try {
    const res = await fetch('/api/mcp/servers');
    if (!res.ok) return null;
    const body = (await res.json()) as { servers?: McpServerSummary[] };
    return Array.isArray(body.servers) ? body.servers : [];
  } catch {
    return null;
  }
}

export {
  fetchMcpToolCatalog,
  type McpCatalogTool,
  type McpToolCatalogEntry,
} from './tool-catalog';

/** Payload for POST /api/mcp/servers (stdio transport). */
export type CreateMcpServerPayload = {
  id: string;
  label: string;
  description?: string;
  enabled?: boolean;
  transport: {
    type: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
};

/** Load MCP secret flags from ~/.minnow/mcp/secrets.json via the Node API. */
export async function fetchMcpSecrets(): Promise<McpSecretsFlags | null> {
  try {
    const res = await fetch('/api/mcp/secrets', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as McpSecretsFlags;
    return {
      hasContext7ApiKey: body.hasContext7ApiKey === true,
    };
  } catch {
    return null;
  }
}

/** Save MCP secrets (empty string clears a key). Reloads the MCP registry. */
export async function updateMcpSecrets(
  secrets: { context7ApiKey?: string },
): Promise<{ ok: true; flags: McpSecretsFlags } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/mcp/secrets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secrets),
    });
    const body = (await res.json()) as McpSecretsFlags & { error?: string };
    if (!res.ok) {
      return { ok: false, error: body.error ?? 'Failed to save MCP secrets' };
    }
    await refreshMcpToolCache();
    return {
      ok: true,
      flags: { hasContext7ApiKey: body.hasContext7ApiKey === true },
    };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

/** Persist enable flag in mcp.json and reload the registry. */
export async function setMcpServerEnabled(
  id: string,
  enabled: boolean,
): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/mcp/servers/${encodeURIComponent(id)}/enabled`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
    );
    if (!res.ok) return false;
    await fetch('/api/mcp/reload', { method: 'POST' });
    await refreshMcpToolCache();
    return true;
  } catch {
    return false;
  }
}

/** Register a custom stdio MCP server under ~/.minnow/mcp/. */
export async function createMcpServer(
  payload: CreateMcpServerPayload,
): Promise<{ ok: true; server: McpServerSummary } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { server?: McpServerSummary; error?: string };
    if (!res.ok) {
      return { ok: false, error: body.error ?? 'Failed to add MCP server' };
    }
    await refreshMcpToolCache();
    if (!body.server) {
      return { ok: false, error: 'Invalid server response' };
    }
    return { ok: true, server: body.server };
  } catch {
    return { ok: false, error: 'Network error. Open or restart Minnow and try again.' };
  }
}

/** Remove a user-added MCP server (built-ins cannot be deleted). */
export async function deleteMcpServer(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) return false;
    await fetch('/api/mcp/reload', { method: 'POST' });
    await refreshMcpToolCache();
    return true;
  } catch {
    return false;
  }
}
