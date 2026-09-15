import type { OpenAIFunctionDefinition } from '../../tools/definitions';
import {
  UI_DESIGNER_TOOL_ALLOWLIST,
  UI_DESIGNER_WRITE_TOOLS,
  type UiDesignerMode,
} from './constants';

const ALLOW_SET = new Set<string>(UI_DESIGNER_TOOL_ALLOWLIST);

export function filterToolsForUiDesigner(
  tools: OpenAIFunctionDefinition[],
): OpenAIFunctionDefinition[] {
  return tools.filter((t) => t.function.name.startsWith('mcp__') || ALLOW_SET.has(t.function.name));
}

export function assertUiDesignerToolAllowed(
  toolName: string,
  mode: UiDesignerMode,
): string | null {
  if (mode !== 'plan') return null;
  if (!UI_DESIGNER_WRITE_TOOLS.has(toolName)) return null;
  return 'Error: UI Designer plan mode does not allow file writes';
}
