import { fetchMcpToolCatalog, type McpToolCatalogEntry } from '../mcp/tool-catalog';
import { createDynamicToolGroup } from './tools-list';

/** Test fixture server — hidden here as it is in the MCP servers list. */
const MCP_TOOLS_HIDDEN_IDS = new Set(['fixture']);

const GROUP_PREFIX = 'mcp:';

/** Descriptions longer than this get the full text on hover. */
const CLAMP_HINT_CHARS = 160;

function createMcpToolRow(
  tool: McpToolCatalogEntry['tools'][number],
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tool-row tool-row--mcp';
  row.setAttribute('data-tool-id', tool.namespacedName);
  row.setAttribute('data-server-required', '');
  row.dataset.settingsSearchKey = `tools.item.${tool.namespacedName}`;

  const controlWrap = document.createElement('div');
  controlWrap.className = 'tool-permission-wrap';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'tool-label tool-label--code';
  nameSpan.textContent = tool.name;

  controlWrap.append(nameSpan);
  row.appendChild(controlWrap);

  if (tool.description) {
    const desc = document.createElement('p');
    desc.className = 'tool-desc tool-desc--clamped';
    desc.textContent = tool.description;
    if (tool.description.length > CLAMP_HINT_CHARS) {
      desc.title = tool.description;
    }
    row.appendChild(desc);
  }

  return row;
}

/** Why a server contributes no rows, phrased so the fix is obvious. */
function createServerNotice(entry: McpToolCatalogEntry): HTMLElement {
  const hint = document.createElement('p');
  hint.className = 'tool-group-hint';
  hint.textContent = entry.error
    ? `Could not start this server: ${entry.error}. Check its command in Integrations → MCP servers.`
    : 'Connected, but the server listed no tools.';
  return hint;
}

export async function appendMcpToolsToList(listId: string): Promise<void> {
  const container = document.getElementById(listId);
  if (!container) return;

  const catalog = await fetchMcpToolCatalog();

  for (const stale of container.querySelectorAll(
    `[data-tool-category^="${GROUP_PREFIX}"]`,
  )) {
    stale.remove();
  }

  const servers = catalog.filter((entry) => !MCP_TOOLS_HIDDEN_IDS.has(entry.id));
  if (servers.length === 0) return;

  const collapsible = container.classList.contains('tools-list--settings');


  for (const entry of servers) {
    const bodyNodes: HTMLElement[] = [];
    if (entry.tools.length === 0) {
      bodyNodes.push(createServerNotice(entry));
    }
    for (const tool of entry.tools) {
      bodyNodes.push(
        createMcpToolRow(tool),
      );
    }

    const count = entry.error
      ? 'Not connected'
      : `${entry.tools.length} tool${entry.tools.length === 1 ? '' : 's'}`;

    container.appendChild(
      createDynamicToolGroup({
        category: `${GROUP_PREFIX}${entry.id}`,
        title: entry.label,
        count,
        searchKey: `tools.category.mcp.${entry.id}`,
        collapsible,
        bodyNodes,
      }),
    );
  }


}
