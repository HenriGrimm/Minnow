import type { TurnToolDefinition } from '../runner/run-turn';
export const AGENT_BROWSER_TOOL_DEFINITIONS: readonly TurnToolDefinition[];
export const AGENT_BROWSER_TOOL_IDS: readonly string[];
export function agentBrowserToolDefinition(name: string): TurnToolDefinition | null;
