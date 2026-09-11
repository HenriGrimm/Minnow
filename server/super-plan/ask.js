/**
 * Interview questions. The interviewer's `ask_question` call is journaled as
 * `question.asked`; the page answers it over HTTP; the answer is journaled as
 * `question.answered` and handed back to the model as readable text.
 *
 * Questions never time out. They survive pause and restart: a resumed
 * interview finds its dangling `ask_question` call and answers it from the
 * journal, waiting if the user has not answered yet.
 */

import { makeEvent } from './events.js';
import { emitLive } from './live-events.js';

export const OTHER_OPTION_ID = '__other__';

/** Questions per `ask_question` card. More than this is a wall of text. */
export const MAX_QUESTIONS_PER_BATCH = 6;
const MAX_OPTIONS = 8;

export const QUESTIONS_CLOSED_REPLY =
  'The user asked you to stop asking questions. Do not call ask_question again. Write the build spec now, using your recommended answers for anything still open, and list those assumptions in the spec.';

/**
 * @param {number} budget
 * @returns {string}
 */
function budgetSpentReply(budget) {
  return `You have asked the ${budget} questions this interview allows. Do not call ask_question again. Write the build spec now and list any remaining assumptions in it.`;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalise model-supplied `ask_question` arguments. Returns an error string
 * the model can act on when the card cannot be shown.
 * @param {unknown} raw
 * @returns {{ ok: true, title: string, questions: Array<Record<string, unknown>> } | { ok: false, error: string }}
 */
export function normalizeQuestionArgs(raw) {
  let args = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Error: ask_question arguments must be a JSON object with a "questions" array.' };
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'Error: ask_question arguments must be a JSON object with a "questions" array.' };
  }
  const rec = /** @type {Record<string, unknown>} */ (args);
  const list = Array.isArray(rec.questions) ? rec.questions : [];
  if (list.length === 0) return { ok: false, error: 'Error: ask_question needs a non-empty "questions" array.' };
  if (list.length > MAX_QUESTIONS_PER_BATCH) {
    return { ok: false, error: `Error: ask at most ${MAX_QUESTIONS_PER_BATCH} questions per ask_question call. Split them into batches.` };
  }
  /** @type {Array<Record<string, unknown>>} */
  const questions = [];
  const ids = new Set();
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== 'object') return { ok: false, error: `Error: questions[${index}] must be an object with id, prompt and options.` };
    const q = /** @type {Record<string, unknown>} */ (item);
    const prompt = text(q.prompt) || text(q.question) || text(q.text);
    if (!prompt) return { ok: false, error: `Error: questions[${index}] needs a "prompt" (the question text).` };
    let id = text(q.id) || `q${index + 1}`;
    if (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    const rawOptions = Array.isArray(q.options) ? q.options : Array.isArray(q.choices) ? q.choices : [];
    /** @type {Array<Record<string, unknown>>} */
    const options = [];
    const optionIds = new Set();
    for (const [optionIndex, rawOption] of rawOptions.slice(0, MAX_OPTIONS).entries()) {
      const option = typeof rawOption === 'string' ? { label: rawOption } : rawOption;
      if (!option || typeof option !== 'object') continue;
      const o = /** @type {Record<string, unknown>} */ (option);
      let label = text(o.label) || text(o.text) || text(o.name) || text(o.value);
      if (!label) continue;
      let recommended = o.recommended === true;
      const marker = /\s*\((recommended|suggested)\)\s*$/i;
      if (marker.test(label)) {
        recommended = true;
        label = label.replace(marker, '').trim();
      }
      let optionId = text(o.id) || text(o.value) || `o${optionIndex + 1}`;
      if (optionId === OTHER_OPTION_ID || optionIds.has(optionId)) optionId = `o${optionIndex + 1}`;
      optionIds.add(optionId);
      const description = text(o.description) || text(o.detail);
      options.push({ id: optionId, label, ...(description ? { description } : {}), ...(recommended ? { recommended: true } : {}) });
    }
    if (options.length < 2) {
      return { ok: false, error: `Error: questions[${index}] needs at least 2 options ({id, label}); the user can always type their own answer.` };
    }
    const multi = q.allow_multiple === true || q.allowMultiple === true || q.multi_select === true;
    questions.push({ id, prompt, options, ...(multi ? { allow_multiple: true } : {}) });
  }
  return { ok: true, title: text(rec.title), questions };
}

/**
 * Normalise an answer posted by the page against the question it answers.
 * @param {import('./types').QuestionRecord} question
 * @param {unknown} raw
 * @returns {{ ok: true, answer: Record<string, unknown> } | { ok: false, error: string }}
 */
export function normalizeAnswer(question, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'answer must be an object' };
  const rec = /** @type {Record<string, unknown>} */ (raw);
  const entries = Array.isArray(rec.answers) ? rec.answers : [];
  /** @type {Array<Record<string, unknown>>} */
  const answers = [];
  for (const item of question.questions) {
    const q = /** @type {{ id: string, options: Array<{ id: string }>, allow_multiple?: boolean }} */ (/** @type {unknown} */ (item));
    const entry = /** @type {Record<string, unknown> | undefined} */ (
      entries.find((e) => e && typeof e === 'object' && /** @type {any} */ (e).questionId === q.id)
    );
    const valid = new Set([...q.options.map((o) => o.id), OTHER_OPTION_ID]);
    let selectedIds = Array.isArray(entry?.selectedIds)
      ? entry.selectedIds.filter((id) => typeof id === 'string' && valid.has(id))
      : [];
    if (!q.allow_multiple) selectedIds = selectedIds.slice(0, 1);
    const otherText = typeof entry?.otherText === 'string' && entry.otherText.trim() ? entry.otherText.trim().slice(0, 4000) : null;
    if (otherText && !selectedIds.includes(OTHER_OPTION_ID)) selectedIds.push(OTHER_OPTION_ID);
    if (selectedIds.length === 0) return { ok: false, error: `Answer question "${q.id}" before continuing.` };
    if (selectedIds.includes(OTHER_OPTION_ID) && !otherText) {
      return { ok: false, error: `Type your own answer for question "${q.id}", or pick one of the options.` };
    }
    answers.push({ questionId: q.id, selectedIds, otherText });
  }
  return { ok: true, answer: { status: 'answered', answers } };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * What the model reads back as the tool result.
 * @param {import('./types').QuestionRecord} question
 * @returns {string}
 */
export function formatAnswerForModel(question) {
  if (question.status === 'skipped') return QUESTIONS_CLOSED_REPLY;
  if (question.status === 'cancelled') {
    return 'These questions were withdrawn before the user answered. Do not ask them again; carry on with your best judgement and note the assumptions.';
  }
  const answers = Array.isArray(question.answer?.answers) ? /** @type {Array<Record<string, any>>} */ (question.answer.answers) : [];
  const lines = ['The user answered:'];
  for (const item of question.questions) {
    const q = /** @type {{ id: string, prompt: string, options: Array<{ id: string, label: string }> }} */ (/** @type {unknown} */ (item));
    const entry = answers.find((a) => a.questionId === q.id);
    const picked = (entry?.selectedIds ?? [])
      .filter((id) => id !== OTHER_OPTION_ID)
      .map((id) => q.options.find((o) => o.id === id)?.label ?? id);
    const parts = [...picked];
    if (entry?.otherText) parts.push(`"${entry.otherText}"`);
    lines.push(`- ${q.prompt}\n  → ${parts.length ? parts.join('; ') : '(no answer)'}`);
  }
  return lines.join('\n');
}

// ── Waiting ──────────────────────────────────────────────────────────────────

/**
 * Resolve when the question is no longer open. Rejects with an AbortError when
 * the attempt is stopped; the question itself stays open for the next attempt.
 * @param {{ getState: () => any, subscribe: (fn: (event: any) => void) => () => void }} engine
 * @param {string} questionId
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('./types').QuestionRecord>}
 */
export function waitForQuestion(engine, questionId, signal) {
  return new Promise((resolve, reject) => {
    const settled = () => engine.getState().questions.find((q) => q.questionId === questionId && q.status !== 'open');
    const done = settled();
    if (done) {
      resolve(done);
      return;
    }
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let unsubscribe = () => {};
    const onAbort = () => {
      unsubscribe();
      reject(abortError());
    };
    unsubscribe = engine.subscribe(() => {
      const found = settled();
      if (!found) return;
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(found);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

// ── Capability ───────────────────────────────────────────────────────────────

/**
 * The `ask` capability `runTurn` calls for `ask_question`.
 * @param {{
 *   engine: { getState: () => any, append: (events: Record<string, unknown>[]) => Promise<unknown>, subscribe: (fn: (event: any) => void) => () => void },
 *   runId: string,
 *   attemptId: string,
 *   transcriptKey: string,
 *   budget: number,
 * }} options
 */
export function createInterviewAsk({ engine, runId, attemptId, transcriptKey, budget }) {
  return {
    /**
     * @param {unknown} args
     * @param {{ signal?: AbortSignal }} [context]
     * @returns {Promise<string>}
     */
    async ask(args, context = {}) {
      const state = engine.getState();
      if (state.questionsClosed) return QUESTIONS_CLOSED_REPLY;
      const mine = state.questions.filter((q) => q.transcriptKey === transcriptKey && q.status !== 'cancelled');
      const asked = mine.reduce((sum, q) => sum + q.questions.length, 0);
      if (budget <= 0 || asked >= budget) return budgetSpentReply(budget);
      const normalized = normalizeQuestionArgs(args);
      if (!normalized.ok) return normalized.error;
      const questionId = `${transcriptKey}-q${state.questions.filter((q) => q.transcriptKey === transcriptKey).length + 1}`;
      await engine.append([
        makeEvent('question.asked', {
          questionId,
          attemptId,
          questions: normalized.questions,
          ...(normalized.title ? { title: normalized.title } : {}),
        }),
      ]);
      emitLive({ runId, stage: 'interview', event: { type: 'question', questionId } });
      const answered = await waitForQuestion(engine, questionId, context.signal);
      const reply = formatAnswerForModel(answered);
      const remaining = budget - asked - normalized.questions.length;
      if (answered.status === 'answered' && remaining <= 0) {
        return `${reply}\n\nThat was the last batch this interview allows. Write the build spec now.`;
      }
      return reply;
    },
  };
}

/**
 * Answer a dangling `ask_question` call from the journal. Waits for the user
 * when the question is still open. Returns null when the journal has no
 * question for this call (the process stopped before it was recorded).
 * @param {{ getState: () => any, subscribe: (fn: (event: any) => void) => () => void }} engine
 * @param {string} transcriptKey
 * @param {unknown} callArguments the dangling call's raw arguments
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | null>}
 */
export async function answerForDanglingAsk(engine, transcriptKey, callArguments, signal) {
  const mine = engine.getState().questions.filter((q) => q.transcriptKey === transcriptKey);
  const last = mine[mine.length - 1];
  if (!last) return null;
  const asked = normalizeQuestionArgs(callArguments);
  if (asked.ok) {
    const prompts = (list) => list.map((q) => String(q.prompt)).join('\n');
    if (prompts(asked.questions) !== prompts(last.questions)) return null;
  }
  const settled = last.status === 'open' ? await waitForQuestion(engine, last.questionId, signal) : last;
  return formatAnswerForModel(settled);
}
