import { DEFAULT_TOOL_TIMEOUT_MS, toolCallTimeoutMs } from '../../runner/tool-timeouts.js';

/** Keep the CLI alive while Minnow executes even a sequential batch of tools. */
export function agentCliToolWaitMs(calls) {
  const batchMs = calls.reduce((total, call) => {
    let args = {};
    try { args = JSON.parse(call.function?.arguments ?? '{}') ?? {}; } catch { /* invalid args fail promptly */ }
    return total + (toolCallTimeoutMs(call.function?.name, args) ?? DEFAULT_TOOL_TIMEOUT_MS);
  }, 0);
  // Include time to return results and start the next generation.
  return Math.max(DEFAULT_TOOL_TIMEOUT_MS, batchMs + 30_000);
}
