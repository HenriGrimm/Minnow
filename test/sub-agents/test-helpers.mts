/**
 * Shared helpers for sub-agent store and runner tests (P8-G).
 *
 * The renderer adapter (`src/agents/sub-agent-runner.ts`) is gone. Runner
 * unit tests wire `createTurnRunner(createRendererRunnerDeps())` here.
 */

import { isSubAgentRunTerminal } from '../../src/agents/sub-agent-outcome.ts';
import { createRendererRunnerDeps } from '../../src/agents/renderer-runner-deps.ts';
import { getSubAgentRun } from '../../src/agents/orchestrator.ts';
import type { SubAgentRunner } from '../../src/agents/types.ts';
import type { ApiMessage } from '../../src/types.ts';
import {
  cloneTurnMessages,
  createTurnRunner,
} from '../../server/runner/index.js';

export { cloneTurnMessages };

export const FIXED_RUN_ID = '11111111-1111-1111-1111-111111111111';
export const FIXED_SUMMARY = 'FIXED_SUMMARY';

/** Same wiring the deleted renderer adapter used: HTTP generations + headless tools. */
export const defaultSubAgentRunner = createTurnRunner(createRendererRunnerDeps());

let runIdCounter = 0;

export function nextFixedRunId(): string {
  runIdCounter += 1;
  return `11111111-1111-1111-1111-${String(runIdCounter).padStart(12, '0')}`;
}

export function resetRunIdCounter(): void {
  runIdCounter = 0;
}

/** Poll until a sub-agent run in the SSE store reaches a terminal status. */
export async function waitForSubAgentRunTerminal(
  runId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = getSubAgentRun(runId);
    if (run && isSubAgentRunTerminal(run.status)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const run = getSubAgentRun(runId);
  throw new Error(
    `Timed out waiting for sub-agent ${runId} to finish (status=${run?.status ?? 'missing'})`,
  );
}

/** Deterministic mock runner for unit tests that still inject a local loop. */
export function createMockSubAgentRunner(
  options?: { summary?: string; delayMs?: number },
): SubAgentRunner {
  const summary = options?.summary ?? FIXED_SUMMARY;
  const delayMs = options?.delayMs ?? 0;

  return {
    async run(input) {
      const messages: ApiMessage[] = [
        { role: 'system', content: 'mock' },
        { role: 'user', content: input.task },
      ];
      input.onMessagesChange?.(cloneTurnMessages(messages));
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      messages.push({ role: 'assistant', content: summary });
      input.onMessagesChange?.(cloneTurnMessages(messages));
      const structuredOutcome = {
        summary,
        findings: [] as { title: string; detail: string }[],
        artifacts: [] as { kind: 'note'; label: string; ref: string }[],
      };
      return {
        summary,
        structuredOutcome,
        toolTurns: 0,
        messages,
      };
    },
  };
}
