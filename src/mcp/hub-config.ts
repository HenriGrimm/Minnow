export interface McpHubInfo {
  workspace: string;
  endpoint: string;
  stdio: { command: string; cliPath: string; home: string } | null;
  stdioUnavailableReason?: string | null;
  tools: { name: string; description: string; readOnly: boolean }[];
}

export function canUseHubStdio(info: McpHubInfo, origin: string): boolean {
  return Boolean(info.stdio) && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
}

/** Preview and clipboard use the same configuration; only the token differs. */
export function buildHubConfig(info: McpHubInfo, origin: string, transport: 'http' | 'stdio', readOnly: boolean, token: string, boundWorkspace?: string | null): string {
  const url = new URL(info.endpoint, origin);
  if (readOnly) url.searchParams.set('readOnly', '1');
  if (transport === 'stdio') {
    if (!info.stdio || !canUseHubStdio(info, origin)) throw new Error('Use HTTP to connect to this Minnow host.');
    return JSON.stringify({ mcpServers: { minnow: {
      command: info.stdio.command,
      args: [info.stdio.cliPath, 'mcp', '--base-url', new URL(origin).origin, ...(readOnly ? ['--read-only'] : [])],
      env: { MINNOW_HOME: info.stdio.home },
    } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { minnow: {
    url: url.href,
    headers: { 'X-Minnow-Token': token, ...(boundWorkspace ? { 'X-Minnow-Workspace': boundWorkspace } : {}) },
  } } }, null, 2);
}
