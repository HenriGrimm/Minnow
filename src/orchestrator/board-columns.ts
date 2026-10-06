import type { BoardState, TaskState } from '../../server/orchestrator/core/types';
import { satisfiesDependents } from '../../server/orchestrator/core/derive.js';

export type ColumnId = 'planned' | 'in_progress' | 'testing' | 'complete';

export interface ColumnDef {
  id: ColumnId;
  label: string;
  short: string;
}

export const COLUMNS: readonly ColumnDef[] = Object.freeze([
  Object.freeze({ id: 'planned', label: 'Planned', short: 'Plan' }),
  Object.freeze({ id: 'in_progress', label: 'In Progress', short: 'Run' }),
  Object.freeze({ id: 'testing', label: 'Testing', short: 'Test' }),
  Object.freeze({ id: 'complete', label: 'Complete', short: 'Done' }),
]) as readonly ColumnDef[];

export function columnOf(state: BoardState, task: TaskState): ColumnId {
  switch (task.phase) {
    case 'building':
    case 'merging':
      return 'in_progress';
    case 'testing':
      return 'testing';
    case 'merged':
    case 'abandoned':
    case 'skipped':
      return 'complete';
    case 'idle':
    default:
      return 'planned';
  }
}

export function isBlocked(state: BoardState, task: TaskState): boolean {
  if (task.phase !== 'idle') return false;
  return task.dependsOn.some((dep) => !satisfiesDependents(state.tasks.get(dep)));
}

export function bucketWave(
  state: BoardState,
  taskIds: readonly string[],
): Map<ColumnId, TaskState[]> {
  const buckets = new Map<ColumnId, TaskState[]>();
  for (const column of COLUMNS) buckets.set(column.id, []);
  for (const id of taskIds) {
    const task = state.tasks.get(id);
    if (!task) continue;
    buckets.get(columnOf(state, task))?.push(task);
  }
  return buckets;
}

export function groupByWave(state: BoardState): Array<[number, string[]]> {
  const waves = new Map<number, string[]>();
  for (const id of state.taskOrder) {
    const task = state.tasks.get(id);
    if (!task) continue;
    const bucket = waves.get(task.wave) ?? [];
    bucket.push(id);
    waves.set(task.wave, bucket);
  }
  return [...waves.entries()].sort((a, b) => a[0] - b[0]);
}
