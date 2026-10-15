import { DEFAULT_TOOL_TIMEOUT_MS, toolCallTimeoutMs } from '../../runner/tool-timeouts.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../../runner/ask-question-tool.js';

/** Keep the CLI alive while Minnow executes even a sequential batch of tools. */
export function agentCliToolWaitMs(calls) {
  const batchMs = calls.reduce((total, call) => {
    let args = {};
    try { args = JSON.parse(call.function?.arguments ?? '{}') ?? {}; } catch { /* invalid args fail promptly */ }
    // Questions wait on a human for up to an hour in the shared runner. The
    // native CLI must still be waiting when that answer (or timeout) returns.
    const timeoutMs = call.function?.name === 'ask_question'
      ? DEFAULT_ASK_TIMEOUT_MS : toolCallTimeoutMs(call.function?.name, args);
    return total + (timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
  }, 0);
  // Include time to return results and start the next generation.
  return Math.max(DEFAULT_TOOL_TIMEOUT_MS, batchMs + 30_000);
}
