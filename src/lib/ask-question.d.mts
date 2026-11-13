export interface AskQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AskQuestionItem {
  id: string;
  prompt: string;
  options: AskQuestionOption[];
  allow_multiple?: boolean;
}

export interface AskQuestionArgs {
  title?: string;
  questions: AskQuestionItem[];
}

/** One answered question in the tool result JSON. */
export interface AskQuestionAnswerEntry {
  questionId: string;
  selectedIds: string[];
  otherText: string | null;
}

export type AskQuestionToolResult =
  | { status: 'answered'; answers: AskQuestionAnswerEntry[] }
  | { status: 'cancelled'; answers: [] }
  | { status: 'error'; message: string };

export const ASK_QUESTION_OTHER_ID: '__other__';
export const ASK_QUESTION_MULTI_SELECT_PROMPT_RE: RegExp;
export function promptImpliesAllowMultiple(prompt: string): boolean;
export function isAskQuestionMultiSelect(question: AskQuestionItem): boolean;
export function normalizeAskQuestionItem(raw: unknown): AskQuestionItem;
export function diagnoseAskQuestionItem(raw: unknown): string | null;
export function validateAskQuestionArgs(raw: unknown): { ok: true; args: AskQuestionArgs } | { ok: false; error: string };
export function stringifyAskQuestionResult(result: AskQuestionToolResult): string;
