export const AGENT_CHAT_TOOL_IDS = Object.freeze(['agent_capabilities', 'chat_list', 'chat_read', 'chat_send', 'chat_wait', 'chat_stop']);
const recovery = new Set(['chat_list', 'chat_read', 'chat_wait', 'chat_stop']);
const spawnFields = new Set(['title', 'target', 'client_request_id', 'workspace_strategy', 'workspace_id']);
/** Capability projection preserves legacy schemas and never mutates the shared catalog. */
export function projectAgentConversationTools(tools, { creationEnabled = false, includeRecoveryTools = false } = {}) {
  return tools.filter(tool => !AGENT_CHAT_TOOL_IDS.includes(tool.function.name) || creationEnabled || (includeRecoveryTools && recovery.has(tool.function.name)))
    .map(tool => {
      if (tool.function.name !== 'spawn_sub_agent' || creationEnabled) return tool;
      return { ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters,
        properties: Object.fromEntries(Object.entries(tool.function.parameters?.properties ?? {}).filter(([key]) => !spawnFields.has(key))) } } };
    });
}
