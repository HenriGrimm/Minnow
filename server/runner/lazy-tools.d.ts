import type { TurnToolDefinition } from './run-turn';
export const CORE_TOOL_NAMES: readonly string[];
export const SEARCH_TOOLS_NAME: string;
export const SEARCH_TOOLS_DEFINITION: TurnToolDefinition;
export function createLazyToolSession(catalog: TurnToolDefinition[], alwaysLoaded?: string[]): {
  tools: TurnToolDefinition[];
  isLoaded(name: string): boolean;
  search(raw: unknown): string;
};
