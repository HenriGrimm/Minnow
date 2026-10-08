/**
 * Per-tool benchmark prompts and arg expectations.
 */

import type { ToolDefinition } from '../../tools/definitions';

export interface ToolFixture {
  prompt: string;
  /** Pass if tool name matches and args satisfy predicate. */
  expectArgs?: (args: Record<string, unknown>) => boolean;
  /** Valid tool_call only; do not execute. */
  emitOnly?: boolean;
  /** Optional post-execution content check (e.g. read_file marker). */
  verifyExec?: (result: string) => boolean;
}

/** Tools that must not be executed during benchmark (UI / policy). */
export const EMIT_ONLY_TOOL_IDS = new Set([
  'generate_image',
  'ask_question',
  'spawn_sub_agent',
  'spawn_work_agent',
]);

const OVERRIDES: Record<string, ToolFixture> = {
  get_datetime: {
    prompt: 'Call get_datetime now. Use the tool; do not answer from memory.',
  },
  calculate: {
    prompt: 'Use calculate to compute (12 + 8) * 2. Call the tool.',
    expectArgs: (a) => typeof a.expression === 'string' && a.expression.length > 0,
  },
  web_search: {
    prompt: 'Use web_search for "TypeScript". Call the tool only.',
    expectArgs: (a) => typeof a.query === 'string',
    emitOnly: true,
  },
  ask_question: {
    prompt:
      'Call ask_question with one question id "bench-scope", prompt "Pick a scope", and two options bench-a and bench-b. Use the tool only.',
    expectArgs: (a) => Array.isArray(a.questions) && (a.questions as unknown[]).length > 0,
  },
};

export function getToolFixture(tool: ToolDefinition): ToolFixture {
  const override = OVERRIDES[tool.id];
  if (override) return { emitOnly: EMIT_ONLY_TOOL_IDS.has(tool.id), ...override };

  return {
    prompt: `Call the ${tool.id} tool once with minimal valid arguments for its schema. Output only the tool call.`,
    emitOnly: EMIT_ONLY_TOOL_IDS.has(tool.id),
  };
}
