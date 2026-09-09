/**
 * Map shell tool args to terminal-stream options.
 *
 * A blocking in-app `execute_command` does not reach the server tool handler — it
 * streams through the terminal panel instead, and its args are forwarded by hand.
 * Every result-size knob in the schema has to be listed here or it silently does
 * nothing on the path the model actually uses, while the truncation footer keeps
 * telling the model to re-run with it.
 */

import { resolveOutputSliceFromArgs } from '../../server/tools/output-cap.js';

export type StreamingCommandOptions = {
  /** Working directory relative to the workspace root (execute_command only). */
  cwd?: string;
  timeoutMs?: number;
  allowUnsandboxed: boolean;
  fullResult: boolean;
  outputSlice?: { headLines?: number; tailLines?: number };
  maxOutputChars?: number;
};

/**
 * @param name Tool name — `cwd` and `timeout_ms` are execute_command-only.
 * @param args Raw tool arguments from the model.
 */
export function resolveStreamingCommandOptions(
  name: string,
  args: Record<string, unknown>,
): StreamingCommandOptions {
  const isExecute = name === 'execute_command';

  const cwd = isExecute && typeof args.cwd === 'string' ? args.cwd.trim() : '';
  const timeoutMs =
    isExecute && typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;

  const rawMaxOutputChars = Number(args.max_output_chars);
  const maxOutputChars = Number.isFinite(rawMaxOutputChars) ? rawMaxOutputChars : undefined;
  const outputSlice = resolveOutputSliceFromArgs(args);

  return {
    ...(cwd ? { cwd } : {}),
    ...(timeoutMs != null ? { timeoutMs } : {}),
    allowUnsandboxed: args.allow_unsandboxed === true,
    fullResult: args.full_result === true || args.full === true,
    ...(outputSlice ? { outputSlice } : {}),
    ...(maxOutputChars != null ? { maxOutputChars } : {}),
  };
}
