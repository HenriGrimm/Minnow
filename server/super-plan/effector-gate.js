import { randomUUID } from 'node:crypto';
import { peekEngine } from '../orchestrator/engine.js';
import { ensurePromptSpec } from './artifacts.js';
import { createJournaledAsk } from './ask-bridge.js';

/** Checkpoints occupy an engine attempt, so reload and pause use normal reconciliation. */
export function createGateEffector({ runId }) {
  const live = new Map();
  const listeners = new Set();
  return {
    inspect: () => [...live.values()].map(({ attemptId }) => ({ attemptId, taskId: runId, role: 'gate' })),
    async start(desired) {
      const attemptId = `gate-${randomUUID()}`;
      const controller = new AbortController();
      const entry = { attemptId, controller };
      live.set(attemptId, entry);
      setTimeout(async () => {
        const engine = peekEngine(runId, 'superplan');
        if (!engine || !live.has(attemptId)) return;
        try {
          const kind = desired.seedKind;
          const state = engine.getState();
          if (kind === 'spec' && !state.specPath) await engine.append([{ type: 'spec.written', ...await ensurePromptSpec(state) }]);
          const ask = createJournaledAsk({ engine, runId, attemptId });
          const answer = await ask({ kind,
            question: kind === 'spec' ? `Confirm the build specification: ${state.specPath ?? state.prompt}` : `Accept the plan: ${state.planPath}`,
            choices: kind === 'spec' ? ['confirm', 'revise'] : ['accept', 'reject'],
          }, { signal: controller.signal });
          if (!live.has(attemptId)) return;
          for (const listener of listeners) await listener({ attemptId, taskId: runId, role: 'gate', outcome: answer.startsWith('Error:') ? 'timeout' : 'pass' });
        } catch (error) {
          for (const listener of listeners) await listener({ attemptId, taskId: runId, role: 'gate', outcome: 'crashed', summary: String(error) });
        } finally { live.delete(attemptId); }
      }, 0);
      return { attemptId };
    },
    async stop(attemptId) { const entry = live.get(attemptId); live.delete(attemptId); entry?.controller.abort(); },
    onEnd(handler) { listeners.add(handler); },
  };
}
