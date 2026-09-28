import type { PlanResync } from '../../server/orchestrator/core/types';

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  build: 'Build',
  test: 'Test',
  accept: 'Accept',
  touches: 'Touches',
  wave: 'wave',
  dependsOn: 'dependencies',
};

function fields(list: readonly string[]): string {
  return list.map((field) => FIELD_LABELS[field] ?? field).join(', ');
}

/** What a re-sync will do (or did), one line per card, changes first. */
export function describeResync(result: PlanResync): { changes: string[]; skipped: string[] } {
  const changes = [
    ...result.updates.map((u) => `Update ${u.taskId}: ${fields(u.fields)}`),
    ...result.adds.map((a) => {
      const title = typeof a.task.title === 'string' && a.task.title ? ` — ${a.task.title}` : '';
      return `Add ${String(a.task.id)}${title} (wave ${String(a.task.wave)}${a.wave ? ', new' : ''})`;
    }),
  ];
  const skipped = [
    ...result.conflicts.map(
      (c) => `Keep ${c.taskId}'s board edit to ${fields(c.fields)} (the plan changed it differently)`,
    ),
    ...result.blocked.map((b) => `Not now ${b.taskId} (${fields(b.fields)}): ${b.reason}`),
    ...result.graph.map(
      (g) => `Ignore ${g.taskId}'s ${fields(g.fields)}: a live board keeps its planned order`,
    ),
    ...result.missing.map(
      (id) => `${id} is no longer in the plan; it stays on the board (Abandon it if unwanted)`,
    ),
  ];
  return { changes, skipped };
}
