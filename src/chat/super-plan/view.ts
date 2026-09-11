import type { SuperPlanState } from './types';
import type { PlanLibraryState } from './plan-library';
export interface SuperPlanGate {
  gateId: string;
  kind: 'spec' | 'accept' | 'question';
  question: string;
  choices?: string[];
  questions?: import('../../tools/ask-question-types').AskQuestionItem[];
  title?: string;
}
export interface SuperPlanView extends SuperPlanState {
  runId: string;
  stage: string;
  stageLabel: string;
  stageIndex: number;
  stageTotal: number;
  state: PlanLibraryState;
  finished: boolean;
  atMs: number;
  seq?: number;
  disputedClaims?: string[];
  reviewExitReason?: string;
  gate?: SuperPlanGate | null;
}
