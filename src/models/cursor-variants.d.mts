import type { ReasoningEffortOption } from '../types';

export interface CursorVariantParts {
  baseId: string;
  effort: ReasoningEffortOption | null;
  thinking: boolean;
  fast: boolean;
}
export function cursorVariantParts(modelId: string): CursorVariantParts | null;
export function cursorVariantFamilyKey(modelId: string): string;
export function resolveCursorVariantId(
  selectedId: string,
  availableIds: string[],
  options?: { effort?: ReasoningEffortOption; fast?: boolean },
): string;
export function cursorReasoningForModels<T extends { id: string }>(rows: T[]): T[];
