/** Schema discovery is turn-local; the caller supplies the already-authorized catalog. */

/**
 * Issue tracker tool names. They used to be pinned in the core set because a
 * model does not search for a capability it has not been told it has. The
 * capability index in `search_tools` now names every deferred family, so they
 * load on demand like the rest.
 */
export const ISSUE_TOOL_NAMES = Object.freeze([
  'issue_add', 'issue_update', 'issue_link', 'issue_get_state', 'issue_delete',
  'issue_search', 'issue_comment', 'issue_assign', 'issue_unlink', 'issue_move',
]);

/**
 * Loaded up front on every turn (when permitted). Fixed per release so the
 * provider prompt cache stays stable; deferred families append in load order.
 */
export const CORE_TOOL_NAMES = Object.freeze([
  'load_skill',
  'read_file', 'list_directory', 'grep', 'find_files',
  'apply_patch', 'save_file', 'replace_text_in_file',
  'execute_command', 'read_command_log', 'stop_command',
  'todo_write', 'check_plan', 'ask_question', 'spawn_sub_agent',
  'web_search', 'fetch_web_content',
]);

export const SEARCH_TOOLS_NAME = 'search_tools';

const SEARCH_TOOLS_BASE_DESCRIPTION = 'Load deferred tools before calling them. Use "select:name_a,name_b" to load exact names, or capability keywords to search. The result includes each loaded tool\'s schema; loaded tools are callable from the next request and stay loaded for this turn. list_only: true lists every permitted name without loading.';

const SEARCH_TOOLS_PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '"select:a,b" for exact names, or capability keywords. Required unless list_only is true.' },
    list_only: { type: 'boolean', description: 'Return all permitted tool names without loading schemas. No query needed; query and limit are ignored in this mode.' },
    limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Maximum keyword matches to load; defaults to 3. Ignored for select:.' },
  },
  additionalProperties: false,
};

export const SEARCH_TOOLS_DEFINITION = {
  type: 'function',
  function: { name: SEARCH_TOOLS_NAME, description: SEARCH_TOOLS_BASE_DESCRIPTION, parameters: SEARCH_TOOLS_PARAMETERS },
};

/** Families for the capability index, matched in order; the first hit wins. */
const TOOL_FAMILIES = [
  ['git', (n) => n.startsWith('git_')],
  ['issues (project tracker)', (n) => n.startsWith('issue_')],
  ['browser (in-app preview)', (n) => n.startsWith('browser_') || n === 'request_browser_origin_access'],
  ['code intelligence', (n) => ['repo_map', 'find_symbol', 'read_symbol', 'who_calls', 'get_lsp_diagnostics'].includes(n) || n.startsWith('lsp_')],
  ['files', (n) => ['read_file_range', 'read_document', 'append_file', 'insert_at_line', 'search_in_file', 'make_directory', 'move_file', 'copy_file', 'delete_path', 'get_file_metadata', 'present_files'].includes(n)],
  ['documents', (n) => n.startsWith('create_') && ['create_pdf', 'create_spreadsheet', 'create_word_document'].includes(n)],
  ['shell & processes', (n) => ['list_running_commands', 'start_background_command', 'stop_background_command', 'manage_dev_servers', 'run_javascript', 'run_python'].includes(n)],
  ['web', (n) => n.startsWith('web_') || ['wikipedia_search', 'rag_web_content'].includes(n)],
  ['sub-agents & chats', (n) => n.endsWith('_sub_agent') || n === 'list_sub_agents' || n === 'wait' || n.startsWith('chat_') || n === 'agent_capabilities'],
  ['brain & memory', (n) => n.startsWith('brain_') || n === 'manage_brain' || n === 'save_memory'],
  ['Minnow docs', (n) => n.startsWith('minnow_docs_')],
  ['Minnow settings & appearance', (n) => /(_settings|_appearance|appearance_asset|read_diagnostics)$/.test(n) || n === 'search_settings' || n === 'launch_minnow_app'],
  ['skills & design', (n) => n.startsWith('load_') || n === 'run_impeccable'],
  ['plugins', (n) => n.startsWith('plugin_')],
  ['Godot', (n) => n.startsWith('godot_')],
];

const INDEX_NAMES_PER_FAMILY = 6;

/** One line per deferred family: names only, no schemas. MCP is grouped per server. */
export function buildCapabilityIndex(deferredNames) {
  const families = new Map();
  const mcp = new Map();
  for (const name of deferredNames) {
    const server = /^mcp__(.+?)__/.exec(name)?.[1];
    if (server) {
      mcp.set(server, (mcp.get(server) ?? 0) + 1);
      continue;
    }
    const family = TOOL_FAMILIES.find(([, match]) => match(name))?.[0] ?? 'other';
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(name);
  }
  const order = [...TOOL_FAMILIES.map(([label]) => label), 'other'];
  const lines = [];
  for (const label of order) {
    const names = families.get(label);
    if (!names?.length) continue;
    const shown = names.slice(0, INDEX_NAMES_PER_FAMILY).join(', ');
    lines.push(`- ${label}: ${shown}${names.length > INDEX_NAMES_PER_FAMILY ? ` … (+${names.length - INDEX_NAMES_PER_FAMILY})` : ''}`);
  }
  for (const [server, count] of [...mcp].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- mcp · ${server}: ${count} tool${count === 1 ? '' : 's'} — mcp__${server}__*`);
  }
  return lines.join('\n');
}

const words = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'and', 'with', 'tool', 'tools']);

/** @param {import('./run-turn').TurnToolDefinition[]} catalog
 * @param {string[]} [alwaysLoaded]
 */
export function createLazyToolSession(catalog, alwaysLoaded = []) {
  const core = new Set([...CORE_TOOL_NAMES, ...alwaysLoaded]);
  const unique = [...new Map(catalog.filter(t => t.function.name !== SEARCH_TOOLS_NAME)
    .map(t => [t.function.name, t])).values()];
  const byName = new Map(unique.map(t => [t.function.name, t]));
  // Keep this array stable: the runner uses it for schemas, decoding and token reserves.
  const tools = unique.filter(t => core.has(t.function.name));
  const deferred = unique.filter(t => !core.has(t.function.name)).map(t => t.function.name);
  if (deferred.length) {
    const index = buildCapabilityIndex(deferred);
    tools.push({
      type: 'function',
      function: {
        name: SEARCH_TOOLS_NAME,
        description: `${SEARCH_TOOLS_BASE_DESCRIPTION}\n\nDeferred tools you can load:\n${index}`,
        parameters: SEARCH_TOOLS_PARAMETERS,
      },
    });
  }
  const loaded = new Set(tools.map(t => t.function.name));
  const load = (tool) => {
    if (!loaded.has(tool.function.name)) {
      loaded.add(tool.function.name);
      tools.push(tool);
    }
  };
  const result = (matches, empty) => JSON.stringify({
    loaded: matches.map(tool => tool.function.name),
    ...(matches.length ? { tools: matches.map(tool => tool.function) } : {}),
    message: matches.length ? 'These tools are callable on the next request; use the schemas above.' : empty,
  });
  return {
    tools,
    isLoaded: (name) => loaded.has(name),
    search(raw) {
      let args = raw;
      if (typeof raw === 'string') {
        try { args = JSON.parse(raw); } catch { return 'Error: search_tools requires valid JSON arguments.'; }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
          (args.list_only !== undefined && typeof args.list_only !== 'boolean') ||
          (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) ||
          (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5))) {
        return 'Error: provide a boolean list_only, a query of up to 500 characters, and an optional integer limit from 1 to 5.';
      }
      if (args.list_only === true) {
        return JSON.stringify({
          names: unique.map(tool => tool.function.name).sort(),
          message: 'No schemas loaded. Use select:<name> to load a tool before calling it.',
        });
      }
      if (typeof args.query !== 'string' || !args.query.trim()) {
        return 'Error: provide a non-empty query, or use list_only: true to list all permitted tool names.';
      }
      const query = args.query.trim();
      const select = /^select:(.*)$/i.exec(query);
      if (select) {
        const names = [...new Set(select[1].split(',').map(s => s.trim()).filter(Boolean))].slice(0, 20);
        const found = names.map(name => byName.get(name)).filter(Boolean);
        const missing = names.filter(name => !byName.has(name));
        found.forEach(load);
        const parsed = JSON.parse(result(found, 'No permitted tools have those names. Use list_only: true to see what exists.'));
        if (missing.length) parsed.not_found = missing;
        return JSON.stringify(parsed);
      }
      const lowered = query.toLowerCase();
      const terms = [...new Set(words(lowered).filter(word => !STOP_WORDS.has(word)))];
      const matches = unique.map(tool => {
        const name = tool.function.name.toLowerCase();
        const nameWords = words(name);
        const descriptionWords = new Set(words(tool.function.description ?? ''));
        const score = name === lowered ? 10000 : terms.reduce((sum, term) => sum +
          (nameWords.includes(term) ? 10 : descriptionWords.has(term) ? 1 : 0), 0);
        return { tool, score };
      }).filter(row => row.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.function.name.localeCompare(b.tool.function.name))
        .slice(0, args.limit ?? 3)
        .map(row => row.tool);
      // Clicking requires a UID from a snapshot. Discover the pair together.
      if (matches.some(tool => tool.function.name === 'browser_click')) {
        const snapshot = byName.get('browser_snapshot');
        if (snapshot && !matches.includes(snapshot)) matches.unshift(snapshot);
      }
      matches.forEach(load);
      return result(matches, 'No permitted tools matched. Try different capability keywords, an exact select:<name>, or list_only: true.');
    },
  };
}
