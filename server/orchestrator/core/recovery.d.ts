import type { BoardState, RecoveryHold, RecoveryFailure } from './types';
export const RECOVERY_VERSION: number;
export const FINAL_REPAIR_LIMIT: number;
export const TASK_REPAIR_LIMIT: number;
export const OPERATIONAL_CATEGORIES: string[];
export function recoveryKey(taskId: string | null, role: string): string;
export function recoverySpent(state: BoardState): number;
export function held(state: BoardState, taskId: string | null, role: string): boolean;
export function recoveryHold(state: BoardState, input: { taskId?: string | null; role: string; failure: RecoveryFailure; now: number; stage?: string; attemptId?: string }): RecoveryHold;
