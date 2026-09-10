/** Schema discovery is turn-local; the caller supplies the already-authorized catalog. */
export const CORE_TOOL_NAMES = Object.freeze([
  'read_file', 'list_directory', 'grep', 'execute_command',
  'save_file', 'replace_text_in_file', 'ask_question',
]);

export const SEARCH_TOOLS_NAME = 'search_tools';
export const SEARCH_TOOLS_DEFINITION = {
  type: 'function',
  function: {
    name: SEARCH_TOOLS_NAME,
    description: 'Find and load additional tools by capability or exact tool name (for example: git diff, browser screenshot, issues, memory, skills, agents). Only core tools are initially loaded. Search before calling an additional tool. Matches become callable on the next request and remain loaded for this turn.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Capability keywords or exact tool names.' },
        limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Maximum matches to load; defaults to 3.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

const words = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'and', 'with', 'tool', 'tools']);

/** @param {import('./run-turn').TurnToolDefinition[]} catalog
 * @param {string[]} [alwaysLoaded]
 */
export function createLazyToolSession(catalog, alwaysLoaded = []) {
  const core = new Set([...CORE_TOOL_NAMES, ...alwaysLoaded]);
  const unique = [...new Map(catalog.filter(t => t.function.name !== SEARCH_TOOLS_NAME)
    .map(t => [t.function.name, t])).values()];
  // Keep this array stable: the runner uses it for schemas, decoding and token reserves.
  const tools = unique.filter(t => core.has(t.function.name));
  if (tools.length < unique.length) tools.push(SEARCH_TOOLS_DEFINITION);
  const loaded = new Set(tools.map(t => t.function.name));
  return {
    tools,
    isLoaded: (name) => loaded.has(name),
    search(raw) {
      let args = raw;
      if (typeof raw === 'string') {
        try { args = JSON.parse(raw); } catch { return 'Error: search_tools requires valid JSON arguments.'; }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
          typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500 ||
          (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5))) {
        return 'Error: provide a non-empty query (up to 500 characters) and an optional integer limit from 1 to 5.';
      }
      const query = args.query.trim().toLowerCase();
      const terms = [...new Set(words(query).filter(word => !STOP_WORDS.has(word)))];
      const matches = unique.map(tool => {
        const name = tool.function.name.toLowerCase();
        const nameWords = words(name);
        const descriptionWords = new Set(words(tool.function.description ?? ''));
        const score = name === query ? 10000 : terms.reduce((sum, term) => sum +
          (nameWords.includes(term) ? 10 : descriptionWords.has(term) ? 1 : 0), 0);
        return { tool, score };
      }).filter(row => row.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.function.name.localeCompare(b.tool.function.name))
        .slice(0, args.limit ?? 3);
      for (const { tool } of matches) {
        if (!loaded.has(tool.function.name)) {
          loaded.add(tool.function.name);
          tools.push(tool);
        }
      }
      return JSON.stringify({
        loaded: matches.map(({ tool }) => tool.function.name),
        message: matches.length ? 'These tools are callable on the next request; use their supplied schemas.' :
          'No permitted tools matched. Try different capability keywords or an exact tool name.',
      });
    },
  };
}
