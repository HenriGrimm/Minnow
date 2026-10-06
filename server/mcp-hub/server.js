import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { BUILT_IN_TOOLS } from '../tools/builtin-catalog.js';
import { issueHubTools, callIssueHubTool } from './issues.js';
import { toolBrainSearch, toolBrainReadPage, toolBrainList, toolBrainWritePage, toolBrainAppendLog } from '../tools/brain-tools.js';
import { toolMinnowDocsSearch, toolMinnowDocsRead, toolMinnowDocsList } from '../tools/minnow-docs-tools.js';
import path from 'node:path';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { runWithViewWorkspace } from '../runtime/path-access.js';
import { mcpWorkspaceKey } from '../auth/mcp-store.js';

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
].map(tool => ({ ...tool, inputSchema: {
  ...tool.inputSchema,
  properties: { ...tool.inputSchema.properties, workspace_path: {
    type: 'string', minLength: 1,
    description: 'Absolute path of the workspace you are working in. Supply your current agent workspace on every call when it is not provided by the transport. Never use the Minnow application folder or another project as a fallback.',
  } },
} }));
const validator = new AjvJsonSchemaValidator();
const validators = new Map(catalog.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));

export function listHubTools(readOnly = false) {
  return catalog.filter(tool => !readOnly || tool.annotations.readOnlyHint);
}

/** Curated hub surface: never dispatch arbitrary built-in, plugin or shell tools. */
export function createHubServer({ workspace, boundWorkspace = null, readOnly = false }) {
  const tools = listHubTools(readOnly);
  const allowed = new Set(tools.map(tool => tool.name));
  const server = new Server({ name: 'minnow-hub', version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: `Minnow is your shared issue tracker and knowledge hub. ${workspace ? `Transport workspace: ${workspace}.` : 'Pass your current agent workspace as workspace_path on every tool call.'} Workspace selection is per call; no active Minnow window is used as a fallback. Issues are restricted to the selected workspace. Brain pages are shared across Minnow; search uses workspace context. Read issue_taxonomy before choosing status/type/priority ids. Use comments for progress and Brain pages for durable knowledge. ${readOnly ? 'This connection is read-only.' : 'This connection can create and update issues and Brain pages.'}`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const { name, arguments: args = {} } = request.params;
      if (!allowed.has(name)) throw new Error('Unknown or unavailable hub tool.');
      const validation = validators.get(name)(args);
      if (!validation.valid) throw new Error(`Invalid arguments: ${validation.errorMessage}`);
      const { workspace_path: requestedWorkspace = workspace, ...toolArgs } = args;
      if (!requestedWorkspace || !path.isAbsolute(requestedWorkspace)) throw new Error('Provide workspace_path as the absolute path of your current agent workspace.');
      const selectedWorkspace = await validateAllowedWorkspaceRoot(requestedWorkspace);
      if (boundWorkspace && mcpWorkspaceKey(selectedWorkspace) !== boundWorkspace) throw new Error('Connection workspace mismatch. Create an agent-scoped connection to switch workspaces.');
      const result = await runWithViewWorkspace(selectedWorkspace, () => Object.hasOwn(handlers, name)
        ? handlers[name](toolArgs)
        : callIssueHubTool(name, toolArgs, selectedWorkspace));
      const output = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text: output }], ...(typeof result === 'string' && /^Error\b/.test(result) ? { isError: true } : {}) };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}
