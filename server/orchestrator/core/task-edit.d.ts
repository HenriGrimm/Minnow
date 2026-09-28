import type { BoardState, TaskEditChanges, TaskState } from './types';

/** Fields a board edit may change. */
export const EDITABLE_TASK_FIELDS: readonly ['title', 'build', 'test', 'accept', 'touches'];

/** Check and canonicalise a raw edit body. Blank spec text clears the field. */
export function normaliseTaskChanges(
  raw: unknown,
): { ok: true; changes: TaskEditChanges } | { ok: false; error: string };

/** Why this task cannot be edited right now, or null when it can. */
export function taskEditBlocker(state: BoardState, taskId: string): string | null;

/** The subset of `changes` that differs from the task as it stands. */
export function diffTaskChanges(task: TaskState, changes: TaskEditChanges): TaskEditChanges;
