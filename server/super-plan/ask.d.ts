import type { QuestionRecord } from './types';

export const OTHER_OPTION_ID: '__other__';
export const MAX_QUESTIONS_PER_BATCH: number;
export const QUESTIONS_CLOSED_REPLY: string;

export function normalizeQuestionArgs(
  raw: unknown,
): { ok: true; title: string; questions: Array<Record<string, unknown>> } | { ok: false; error: string };

export function normalizeAnswer(
  question: QuestionRecord,
  raw: unknown,
): { ok: true; answer: Record<string, unknown> } | { ok: false; error: string };

export function formatAnswerForModel(question: QuestionRecord): string;

export function waitForQuestion(
  engine: { getState: () => any; subscribe: (fn: (event: any) => void) => () => void },
  questionId: string,
  signal?: AbortSignal,
): Promise<QuestionRecord>;

export function createInterviewAsk(options: {
  engine: {
    getState: () => any;
    append: (events: Record<string, unknown>[]) => Promise<unknown>;
    subscribe: (fn: (event: any) => void) => () => void;
  };
  runId: string;
  attemptId: string;
  transcriptKey: string;
  budget: number;
}): { ask(args: unknown, context?: { signal?: AbortSignal }): Promise<string> };

export function answerForDanglingAsk(
  engine: { getState: () => any; subscribe: (fn: (event: any) => void) => () => void },
  transcriptKey: string,
  callArguments: unknown,
  signal?: AbortSignal,
): Promise<string | null>;
