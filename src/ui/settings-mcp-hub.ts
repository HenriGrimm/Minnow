import '../styles/settings-mcp-hub.css';
import { getWorkspacePath } from '../state/workspace';
import { getSessionToken } from '../api/session-token';
import { buildHubConfig, canUseHubStdio, type McpHubInfo } from '../mcp/hub-config';
import { appendSettingsGroup, appendSettingsCrosslinks } from './settings-layout';
import { createSettingsSelectRow } from './settings-controls';
import { beginAsyncSectionRender, isAsyncSectionRenderStale } from './settings-section-render-guard';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export async function renderMcpHubSettingsSection(): Promise<void> {
  const root = document.getElementById('settingsMcpHubBody');
  if (!root) return;
  const generation = beginAsyncSectionRender('mcp-hub');
  const workspace = getWorkspacePath();
  root.classList.add('mcp-hub-settings');
  root.replaceChildren();
  root.dataset.settingsSearchKey = 'integrations.mcp-hub';
  const status = element('p', 'mcp-hub-status', 'Checking connection…');
  status.setAttribute('role', 'status');
  root.append(status);
  const retry = element('button', 'settings-inline-btn', 'Refresh connection');
  retry.type = 'button';
  retry.addEventListener('click', () => { void renderMcpHubSettingsSection(); });
  if (!workspace) {
    status.textContent = 'Open a project folder to set up an agent connection.';
    root.append(retry);
    return;
  }
  let info: McpHubInfo;
  try {
    const response = await fetch('/api/mcp/hub/info', { cache: 'no-store', headers: { 'X-Minnow-Workspace': workspace }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('unavailable');
    info = await response.json() as McpHubInfo;
    if (!info.workspace || !Array.isArray(info.tools) || info.endpoint !== '/api/mcp/hub') throw new Error('invalid response');
  } catch {
    if (isAsyncSectionRenderStale('mcp-hub', generation) || !root.isConnected) return;
    status.textContent = 'MCP hub is unavailable. Open or restart Minnow, then refresh the connection.';
    root.append(retry);
    return;
  }
  if (isAsyncSectionRenderStale('mcp-hub', generation) || !root.isConnected) return;
  if (workspace !== getWorkspacePath()) { void renderMcpHubSettingsSection(); return; }
  status.textContent = 'Ready to connect';
  const setup = appendSettingsGroup(root, 'Connect an agent', 'Keep Minnow open while your agent uses this connection.');
  const workspaceLabel = element('p', 'field-hint', 'Workspace');
  const workspaceValue = element('code', 'mcp-hub-workspace', info.workspace);
  const workspaceBlock = element('div', 'mcp-hub-workspace-block');
  const scope = element('p', 'field-hint', 'Issues stay scoped to this folder. Brain pages and the project catalog are shared across Minnow.');
  workspaceBlock.append(workspaceLabel, workspaceValue, scope);
  setup.append(workspaceBlock);
  const origin = window.location.origin;
  const choices = [{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'Local command (stdio)' }];
  const transport = createSettingsSelectRow('Connection method', {
    id: 'mcpHubTransport', options: choices, value: 'http',
    description: 'Choose the method supported by your agent’s MCP settings.',
  });
  const access = createSettingsSelectRow('Access for this connection', {
    id: 'mcpHubAccess', options: [{ value: 'write', label: 'Read and write' }, { value: 'read', label: 'Read only' }], value: 'write',
    description: 'Read only hides and rejects tools that change issues or Brain pages.',
  });
  const credential = createSettingsSelectRow('HTTP credential', {
    id: 'mcpHubCredential', options: [{ value: 'persistent', label: 'Persistent connection' }, { value: 'session', label: 'Current host session (legacy)' }], value: 'persistent',
    description: 'Persistent connections survive restarts and only authorize this workspace’s MCP hub.',
  });
  const nameLabel = element('label', 'field-hint', 'Connection name');
  nameLabel.htmlFor = 'mcpHubConnectionName';
  const nameInput = element('input', 'settings-input');
  nameInput.id = 'mcpHubConnectionName';
  nameInput.maxLength = 64;
  nameInput.value = 'My agent';
  const create = element('button', 'settings-inline-btn', 'Create connection');
  create.type = 'button';
  const creation = element('div', 'mcp-hub-creation');
  creation.append(nameLabel, nameInput, create);
  setup.append(transport.row, credential.row, access.row, creation);
  type Connection = { id: string; name: string; access: 'read' | 'write'; createdAt: string; lastUsedAt: string | null };
  let issued: { token: string; connection: Connection } | null = null;
  const hint = element('p', 'field-hint');
  const preview = element('pre', 'mcp-hub-config');
  preview.tabIndex = 0;
  preview.setAttribute('aria-label', 'Agent configuration preview');
  const code = element('code', '');
  preview.append(code);
  const actions = element('div', 'mcp-hub-actions');
  const copy = element('button', 'settings-inline-btn', 'Copy configuration');
  copy.type = 'button';
  const copyToken = element('button', 'settings-inline-btn', 'Copy session token');
  copyToken.type = 'button';
  const feedback = element('span', 'field-hint');
  feedback.setAttribute('role', 'status');
  const done = element('button', 'settings-inline-btn', 'Hide token');
  done.type = 'button';
  done.addEventListener('click', () => { issued = null; update(); feedback.textContent = 'Token hidden. Replace the connection if you need a new token.'; });
  actions.append(copy, copyToken, done, feedback);
  setup.append(hint, preview, actions);
  const saved = appendSettingsGroup(root, 'Saved HTTP connections', 'Replace rotates a connection’s token immediately. Revoke stops access immediately. Save the new token before leaving this page; Minnow cannot show it again.');
  const savedList = element('div', 'mcp-hub-connections');
  saved.append(savedList);
  async function requestConnections<T>(method = 'GET', body?: object, id?: string): Promise<T> {
    const response = await fetch(`/api/mcp/hub/connections${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
      method, cache: 'no-store', headers: { 'X-Minnow-Workspace': workspace, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not update connections');
    return result as T;
  }
  function currentView(): boolean {
    return root!.isConnected && !isAsyncSectionRenderStale('mcp-hub', generation) && workspace === getWorkspacePath();
  }
  async function loadConnections(): Promise<void> {
    try {
      const result = await requestConnections<{ connections: Connection[] }>();
      if (!currentView()) return;
      const connections: Connection[] = result.connections;
      if (!Array.isArray(connections)) throw new Error('Invalid connection list');
      savedList.replaceChildren();
      if (!connections.length) savedList.append(element('p', 'field-hint', 'No saved connections for this workspace.'));
      for (const connection of connections) {
        const row = element('div', 'mcp-hub-actions');
        row.append(element('span', '', connection.name), element('span', 'field-hint',
          `${connection.access === 'read' ? 'Read only' : 'Read and write'} · Created ${new Date(connection.createdAt).toLocaleString()} · ${connection.lastUsedAt ? `Last used ${new Date(connection.lastUsedAt).toLocaleString()}` : 'Never used'}`));
        for (const action of ['Replace', 'Revoke']) {
          const button = element('button', 'settings-inline-btn', action);
          button.type = 'button';
          button.setAttribute('aria-label', `${action} ${connection.name}`);
          button.addEventListener('click', () => { void mutateConnection(action === 'Replace' ? connection.id : undefined, action === 'Revoke' ? connection.id : undefined, button); });
          row.append(button);
        }
        savedList.append(row);
      }
    } catch (error) { if (currentView()) savedList.textContent = error instanceof Error ? error.message : 'Could not load connections. Refresh to retry.'; }
  }
  let managing = false;
  async function mutateConnection(replaceId?: string, revokeId?: string, button = create): Promise<void> {
    if (!currentView()) { feedback.textContent = 'Workspace changed. Refresh the connection.'; return; }
    if (managing) return;
    managing = true;
    button.disabled = true;
    try {
      if (revokeId) {
        await requestConnections('DELETE', undefined, revokeId);
        if (!currentView()) return;
        if (issued?.connection.id === revokeId) issued = null;
      } else {
        const result = await requestConnections<{ token: string; connection: Connection }>('POST',
          { name: nameInput.value, access: access.select.value, ...(replaceId ? { replaceId } : {}) });
        if (!currentView()) return;
        issued = result;
        credential.select.value = 'persistent';
        transport.select.value = 'http';
        access.select.value = result.connection.access;
      }
      update();
      feedback.textContent = revokeId ? 'Connection revoked.' : 'Token shown once. Copy and save this configuration now.';
      await loadConnections();
    } catch (error) { if (currentView()) feedback.textContent = error instanceof Error ? error.message : 'Could not update connections. Refresh to retry.'; }
    finally { managing = false; button.disabled = false; }
  }
  create.addEventListener('click', () => { void mutateConnection(); });
  const capabilities = appendSettingsGroup(root, 'Available to your agent');
  const summary = element('p', 'field-hint');
  const disclosure = element('details', 'mcp-hub-tool-details');
  const disclosureLabel = element('summary', '', 'View tools');
  const tools = element('ul', 'mcp-hub-tools');
  disclosure.append(disclosureLabel, tools);
  capabilities.append(summary, disclosure);
  function update(): void {
    const method = transport.select.value as 'http' | 'stdio';
    if (method === 'http' && credential.select.value === 'persistent' && issued) access.select.value = issued.connection.access;
    const readOnly = access.select.value === 'read';
    const persistent = credential.select.value === 'persistent';
    const unavailable = method === 'stdio' && !canUseHubStdio(info, origin);
    done.hidden = method !== 'http' || !persistent || !issued;
    credential.row.hidden = method !== 'http';
    creation.hidden = method !== 'http' || !persistent;
    access.select.disabled = method === 'http' && persistent && Boolean(issued);
    code.textContent = unavailable ? '' : buildHubConfig(info, origin, method, readOnly, persistent ? issued?.token ?? '<create a connection first>' : '<session token hidden>');
    copy.disabled = unavailable || (method === 'http' && persistent && !issued);
    copyToken.disabled = copy.disabled;
    copyToken.textContent = persistent ? 'Copy connection token' : 'Copy session token';
    hint.textContent = method === 'http'
      ? persistent ? 'Create a named connection and save its token now. It survives Minnow restarts until replaced or revoked. Access is enforced by Minnow, even if the URL or headers change. Brain pages and the project catalog remain shared.'
        : 'This host session token changes when Minnow restarts. Copy again after restarting Minnow. Read-only access does not restrict this credential on other Minnow APIs.'
      : unavailable ? info.stdioUnavailableReason ?? 'Local command (stdio) requires a Minnow source checkout with dependencies installed and Node.js on the same computer. Use HTTP for this host, or run node /path/to/Minnow/bin/minnow.mjs mcp from a source checkout.'
        : 'Requires a Minnow source checkout with dependencies installed and Node.js on this computer. The command reads Minnow’s current session token on every request, including after restarts. It does not start Minnow.';
    copyToken.hidden = method !== 'http';
    feedback.textContent = '';
    const visible = info.tools.filter(tool => !readOnly || tool.readOnly);
    summary.textContent = `${visible.length} tools. Your agent uses its own tools to edit code and run commands.`;
    tools.replaceChildren(...visible.map(tool => {
      const item = element('li', 'mcp-hub-tool');
      item.append(element('code', '', tool.name), element('span', 'field-hint', tool.readOnly ? 'Read' : 'Write'));
      item.title = tool.description;
      return item;
    }));
  }
  transport.select.addEventListener('change', update);
  access.select.addEventListener('change', update);
  credential.select.addEventListener('change', update);
  async function copyConnection(tokenOnly: boolean): Promise<void> {
    if (!currentView()) {
      feedback.textContent = 'Workspace changed. Refresh the connection before copying.';
      return;
    }
    copy.disabled = true;
    copyToken.disabled = true;
    try {
      const method = transport.select.value as 'http' | 'stdio';
      const persistent = credential.select.value === 'persistent';
      const token = persistent ? issued?.token ?? '' : getSessionToken();
      if ((tokenOnly || method === 'http') && !token) {
        feedback.textContent = persistent ? 'Create a connection before copying.' : 'Session token unavailable. Reopen Minnow and refresh the connection, then try again.';
        return;
      }
      await navigator.clipboard.writeText(tokenOnly ? token : buildHubConfig(info, origin, method, access.select.value === 'read', token));
      feedback.textContent = tokenOnly
        ? `${persistent ? 'Connection' : 'Session'} token copied. Paste it into your agent’s X-Minnow-Token header.`
        : 'Configuration copied. Paste it into your agent’s MCP settings.';
    } catch {
      feedback.textContent = 'Could not copy. Check clipboard access and refresh the connection, then try again.';
    } finally { const message = feedback.textContent; update(); feedback.textContent = message; }
  }
  copy.addEventListener('click', () => { void copyConnection(false); });
  copyToken.addEventListener('click', () => { void copyConnection(true); });
  root.append(retry);
  appendSettingsCrosslinks(root, [{ label: 'MCP servers', sectionId: 'mcp' }]);
  update();
  await loadConnections();
}
