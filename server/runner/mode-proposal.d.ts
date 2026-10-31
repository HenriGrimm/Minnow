import type { AskQuestionArgs } from '../../src/tools/ask-question-types';
export type HandoffSituation = 'implement_in_wrong_mode' | 'plan_in_build';
export function buildProposeModeSwitchQuestions(situation: HandoffSituation): AskQuestionArgs;
export function validateProposeModeSwitchArgs(args: Record<string, unknown>): { ok: true; args: AskQuestionArgs } | { ok: false; error: string };
