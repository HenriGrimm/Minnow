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
  const choices = [{ value: 'http', label: 'HTTP' }];
  if (canUseHubStdio(info, origin)) choices.push({ value: 'stdio', label: 'Local command (stdio)' });
  const transport = createSettingsSelectRow('Connection method', {
    id: 'mcpHubTransport', options: choices, value: 'http',
    description: 'Choose the method supported by your agent’s MCP settings.',
  });
  const access = createSettingsSelectRow('Access for this connection', {
    id: 'mcpHubAccess', options: [{ value: 'write', label: 'Read and write' }, { value: 'read', label: 'Read only' }], value: 'write',
    description: 'Read only hides and rejects tools that change issues or Brain pages.',
  });
  setup.append(transport.row, access.row);
  const hint = element('p', 'field-hint');
  const preview = element('pre', 'mcp-hub-config');
  preview.tabIndex = 0;
  preview.setAttribute('aria-label', 'Agent configuration preview, session token hidden');
  const code = element('code', '');
  preview.append(code);
  const actions = element('div', 'mcp-hub-actions');
  const copy = element('button', 'settings-inline-btn', 'Copy configuration');
  copy.type = 'button';
  const copyToken = element('button', 'settings-inline-btn', 'Copy session token');
  copyToken.type = 'button';
  const feedback = element('span', 'field-hint');
  feedback.setAttribute('role', 'status');
  actions.append(copy, copyToken, feedback);
  setup.append(hint, preview, actions);
  const capabilities = appendSettingsGroup(root, 'Available to your agent');
  const summary = element('p', 'field-hint');
  const disclosure = element('details', 'mcp-hub-tool-details');
  const disclosureLabel = element('summary', '', 'View tools');
  const tools = element('ul', 'mcp-hub-tools');
  disclosure.append(disclosureLabel, tools);
  capabilities.append(summary, disclosure);
  function update(): void {
    const method = transport.select.value as 'http' | 'stdio';
    const readOnly = access.select.value === 'read';
    code.textContent = buildHubConfig(info, origin, method, readOnly, '<session token hidden>');
    hint.textContent = method === 'http'
      ? 'Minnow creates the session token automatically so agents can connect. Copy configuration includes it, or use Copy session token for the X-Minnow-Token header. Paste only into a trusted agent. Copy again after restarting Minnow. Read-only access does not restrict this credential on other Minnow APIs.'
      : 'Requires Node.js on this computer. The command reads Minnow’s current session token automatically.';
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
  async function copyConnection(tokenOnly: boolean): Promise<void> {
    if (workspace !== getWorkspacePath()) {
      feedback.textContent = 'Workspace changed. Refresh the connection before copying.';
      return;
    }
    copy.disabled = true;
    copyToken.disabled = true;
    try {
      const method = transport.select.value as 'http' | 'stdio';
      const token = getSessionToken();
      if ((tokenOnly || method === 'http') && !token) {
        feedback.textContent = 'Session token unavailable. Reopen Minnow and refresh the connection, then try again.';
        return;
      }
      await navigator.clipboard.writeText(tokenOnly ? token : buildHubConfig(info, origin, method, access.select.value === 'read', token));
      feedback.textContent = tokenOnly
        ? 'Session token copied. Paste it into your agent’s X-Minnow-Token header.'
        : 'Configuration copied. Paste it into your agent’s MCP settings.';
    } catch {
      feedback.textContent = 'Could not copy. Check clipboard access and refresh the connection, then try again.';
    } finally { copy.disabled = false; copyToken.disabled = false; }
  }
  copy.addEventListener('click', () => { void copyConnection(false); });
  copyToken.addEventListener('click', () => { void copyConnection(true); });
  root.append(retry);
  appendSettingsCrosslinks(root, [{ label: 'MCP servers', sectionId: 'mcp' }]);
  update();
}
