import { getToolById } from './builtin-catalog.js';
import { agentBrowserToolDefinition } from './agent-browser-tool-defs.js';

const searchProviders = new Map([
  ['web_search_ddg', 'DuckDuckGo'],
  ['web_search_tavily', 'Tavily'],
  ['web_search_searxng', 'SearXNG'],
]);

/** Server search endpoints share query/deep_read with the chat search tool. */
function searchDefinition(name) {
  const provider = searchProviders.get(name);
  if (!provider) return undefined;
  const definition = structuredClone(getToolById('web_search').definition);
  definition.function.name = name;
  definition.function.description = `Search the web using ${provider}. Supports deep_read to fetch relevant passages from the top results.`;
  delete definition.function.parameters.properties.api_key;
  return definition;
}

/**
 * Resolve only caller-permitted tools. A missing schema is a configuration
 * error: advertising a name-only stub leaves the model guessing arguments.
 * @param {readonly string[]} ids
 * @returns {import('../runner/run-turn').TurnToolDefinition[]}
 */
export function headlessToolDefinitions(ids) {
  return ids.map((name) => {
    const definition = agentBrowserToolDefinition(name) ?? searchDefinition(name) ?? getToolById(name)?.definition;
    if (!definition) throw new Error(`Missing tool schema for "${name}"`);
    return structuredClone(definition);
  });
}
