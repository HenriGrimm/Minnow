import type { ReasoningEffortOption } from '../types.ts';
import type { ThinkingTriState } from '../agents/thinking-types.ts';
import { REASONING_EFFORT_OPTIONS, isReasoningEffortOption } from '../lib/reasoning-effort.ts';

export type BoardReasoningPatch = {
  reasoningEffort?: ReasoningEffortOption;
  thinkingMode?: ThinkingTriState;
  clearReasoningEffort?: boolean;
  clearThinkingMode?: boolean;
};

export const BOARD_JOURNAL_REASONING = REASONING_EFFORT_OPTIONS;

export type BoardJournalReasoning = (typeof BOARD_JOURNAL_REASONING)[number];

export interface BoardReasoningFields {
  thinkingMode?: ThinkingTriState;
  reasoningEffort?: ReasoningEffortOption;
}

export function isBoardJournalReasoning(value: string): value is BoardJournalReasoning {
  return isReasoningEffortOption(value);
}

export function fieldsFromJournalReasoning(
  reasoning: string | null | undefined,
): BoardReasoningFields {
  if (!reasoning) return {};
  if (reasoning === 'off') return { reasoningEffort: 'off' };
  if (reasoning === 'on') return { thinkingMode: 'on' };
  if (isReasoningEffortOption(reasoning)) {
    return { reasoningEffort: reasoning };
  }
  return {};
}

export function journalReasoningFromFields(fields: BoardReasoningFields): string {
  if (fields.reasoningEffort === 'off' || fields.thinkingMode === 'off') return 'off';
  if (isReasoningEffortOption(fields.reasoningEffort)) {
    return fields.reasoningEffort;
  }
  if (fields.thinkingMode === 'on') return 'on';
  return '';
}

export function mergeReasoningPatch(
  current: BoardReasoningFields,
  patch: BoardReasoningPatch,
): BoardReasoningFields {
  const next: BoardReasoningFields = { ...current };
  if (patch.clearReasoningEffort) {
    delete next.reasoningEffort;
  } else if (patch.reasoningEffort !== undefined) {
    next.reasoningEffort = patch.reasoningEffort;
  }
  if (patch.clearThinkingMode) {
    delete next.thinkingMode;
  } else if (patch.thinkingMode !== undefined) {
    next.thinkingMode = patch.thinkingMode;
  }
  return next;
}
