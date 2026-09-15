import type { OpenAIFunctionDefinition } from '../tools/definitions';
import type { SubAgentTypeConfig } from './types';

const META_SPAWN_TOOLS = new Set([
  'spawn_sub_agent',
  'cancel_sub_agent',
  'list_sub_agents',
  'get_sub_agent_status',
]);

export function resolveSubAgentTools(
  typeConfig: SubAgentTypeConfig,
  typeId: string,
  parentEnabled: OpenAIFunctionDefinition[],
): OpenAIFunctionDefinition[] {
  let tools = [...parentEnabled];

  if (typeConfig.allowedTools && typeConfig.allowedTools.length > 0) {
    const allow = new Set(typeConfig.allowedTools);
    tools = tools.filter((t) => (t.function.name.startsWith('mcp__') || allow.has(t.function.name)));
  }

  const deny = new Set([
    ...typeConfig.deniedTools,
    ...(typeId === 'orchestrator' ? [] : META_SPAWN_TOOLS),
  ]);
  tools = tools.filter((t) => t.function.name.startsWith('mcp__') || !deny.has(t.function.name));

  return tools;
}
