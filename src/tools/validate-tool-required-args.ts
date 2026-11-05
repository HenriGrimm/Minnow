import { BUILT_IN_TOOLS, type ToolDefinition } from './definitions.ts';

function findBuiltInTool(functionName: string): ToolDefinition | undefined {
  return BUILT_IN_TOOLS.find((t) => t.definition.function.name === functionName);
}

function isPresentRequiredValue(value: unknown, fieldKey?: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') {
    if (fieldKey === 'content') return true;
    return value.trim().length > 0;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return false;
}

/**
 * Returns an error message when required schema fields are missing or empty, else null.
 */
export function validateToolRequiredArgs(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const tool = findBuiltInTool(toolName);
  if (!tool) return null;

  const params = tool.definition.function.parameters as
    | { required?: string[] }
    | undefined;
  const required = params?.required;
  if (!required?.length) return null;

  if (toolName === 'execute_command' && args.stop === true) {
    if (!isPresentRequiredValue(args.run_id)) {
      return `Error: tool "execute_command" requires argument(s): "run_id" when stop is true.`;
    }
    return null;
  }

  const missing: string[] = [];
  for (const key of required) {
    if (toolName === 'replace_text_in_file' && key === 'replace') {
      if (typeof args.replace !== 'string') missing.push(key);
      continue;
    }
    if (toolName === 'todo_write' && key === 'todos' && Array.isArray(args.todos)) {
      continue;
    }
    if (toolName === 'execute_command' && key === 'command') {
      if (args.background === true || args.stop === true) continue;
    }
    if (!isPresentRequiredValue(args[key], key)) {
      missing.push(key);
    }
  }

  if (missing.length === 0) return null;

  const fields = missing.map((k) => `"${k}"`).join(', ');
  return `Error: tool "${toolName}" requires argument(s): ${fields}. Provide valid JSON in function.arguments (got ${summarizeArgs(args)}).`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return 'empty object {}';
  return `{ ${keys.join(', ')} }`;
}
