import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { BUILT_IN_TOOLS } from '../tools/builtin-catalog.js';
import { issueHubTools, callIssueHubTool } from './issues.js';
import { toolBrainSearch, toolBrainReadPage, toolBrainList, toolBrainWritePage, toolBrainAppendLog } from '../tools/brain-tools.js';
import { toolMinnowDocsSearch, toolMinnowDocsRead, toolMinnowDocsList } from '../tools/minnow-docs-tools.js';

const handlers = {
  brain_search: toolBrainSearch, brain_read_page: toolBrainReadPage, brain_list: toolBrainList,
  brain_write_page: toolBrainWritePage, brain_append_log: toolBrainAppendLog,
  minnow_docs_search: toolMinnowDocsSearch, minnow_docs_read: toolMinnowDocsRead, minnow_docs_list: toolMinnowDocsList,
};
const writes = new Set(['brain_write_page', 'brain_append_log']);
const catalog = [
  ...issueHubTools,
  ...BUILT_IN_TOOLS.filter(tool => Object.hasOwn(handlers, tool.id)).map(tool => ({
    name: tool.id, description: tool.definition.function.description,
    inputSchema: { ...tool.definition.function.parameters, additionalProperties: false },
    annotations: { readOnlyHint: !writes.has(tool.id), destructiveHint: tool.id === 'brain_write_page', openWorldHint: false },
  })),
];
const validator = new AjvJsonSchemaValidator();
const validators = new Map(catalog.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));

export function listHubTools(readOnly = false) {
  return catalog.filter(tool => !readOnly || tool.annotations.readOnlyHint);
}

/** Curated hub surface: never dispatch arbitrary built-in, plugin or shell tools. */
export function createHubServer({ workspace, readOnly = false }) {
  const tools = listHubTools(readOnly);
  const allowed = new Set(tools.map(tool => tool.name));
  const server = new Server({ name: 'minnow-hub', version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: `Minnow is your shared issue tracker and knowledge hub. Connected workspace: ${workspace}. Issues are restricted to this workspace. Brain pages are shared across Minnow; search uses workspace context. Read issue_taxonomy before choosing status/type/priority ids. Use comments for progress and Brain pages for durable knowledge. ${readOnly ? 'This connection is read-only.' : 'This connection can create and update issues and Brain pages.'}`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const { name, arguments: args = {} } = request.params;
      if (!allowed.has(name)) throw new Error('Unknown or unavailable hub tool.');
      const validation = validators.get(name)(args);
      if (!validation.valid) throw new Error(`Invalid arguments: ${validation.errorMessage}`);
      const result = Object.hasOwn(handlers, name)
        ? await handlers[name](args)
        : await callIssueHubTool(name, args, workspace);
      const output = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text: output }], ...(typeof result === 'string' && /^Error\b/.test(result) ? { isError: true } : {}) };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}
