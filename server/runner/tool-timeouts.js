/**
 * Per-tool wall-clock ceilings for a single tool call.
 *
 * This is a backstop, not a scheduling knob. Every tool that can block is expected to
 * enforce its own, tighter limit (`execute_command` caps at 30s, LSP requests at 6s,
 * the ask_question prompt at its own timeout). This ceiling exists only so that a tool
 * which forgets — or whose internal timeout is itself unreachable — cannot wedge the
 * turn forever.
 *
 * Why it matters: `executeToolCallBatch` awaits every call, and a turn awaits its batch.
 * One never-settling promise therefore strands the whole attempt with no recovery path,
 * which is exactly how orchestrator boards used to sit on a single tool call until a
 * human noticed. See `test/runner/tool-batch.test.mjs`.
 */

/** Backstop for any tool without an entry below. Chosen far above every observed p95. */
export const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Tools that legitimately outlive the default ceiling, mapped to `null` (unbounded here).
 *
 * Keep this list short and justified — an entry means "this tool owns its own liveness",
 * so anything added here must have a timeout of its own.
 */
const UNBOUNDED_TOOLS = new Set([
  // Blocks on a human answering; governed by ASK_QUESTION_TIMEOUT in run-turn.
  'ask_question',
  // `wait: true` deliberately blocks for as long as the child agent runs.
  'spawn_sub_agent',
]);

/**
 * Wall-clock ceiling for one call of `name`.
 *
 * @param {string} name
 * @returns {number | null} milliseconds, or null when the tool is unbounded
 */
export function toolCallTimeoutMs(name) {
  return UNBOUNDED_TOOLS.has(String(name ?? '')) ? null : DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * Result text handed back to the model when a call is abandoned.
 *
 * Phrased as a tool result rather than thrown, so the model sees a recoverable failure
 * and can pick another approach instead of the turn dying.
 *
 * @param {string} name
 * @param {number} timeoutMs
 * @returns {string}
 */
export function toolTimeoutMessage(name, timeoutMs) {
  const secs = Math.round(timeoutMs / 1000);
  return `Error: ${name} did not return within ${secs}s and was abandoned. The work may still be running in the background. Try a narrower call, or use a different tool.`;
}
