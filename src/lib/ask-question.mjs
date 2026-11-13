/** Reserved id when the user selects the synthetic "Other" row. */
export const ASK_QUESTION_OTHER_ID = '__other__';

const MAX_QUESTIONS = 10;
const MIN_OPTIONS = 2;

/** Common Super Plan / grill phrasing for click-all-that-apply cards. */
export const ASK_QUESTION_MULTI_SELECT_PROMPT_RE =
  /\b(click|select|choose|pick|check)\s+all(\s+that|\s+which|\s+the)?\s+(apply|are\s+relevant|relevant)\b/i;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** True when the prompt text signals a click-all-that-apply question. */
export function promptImpliesAllowMultiple(prompt) {
  return ASK_QUESTION_MULTI_SELECT_PROMPT_RE.test(prompt.trim());
}

/** True when the UI should render checkboxes instead of radios. */
export function isAskQuestionMultiSelect(q) {
  return q.allow_multiple === true;
}

function readExplicitAllowMultiple(o) {
  const flags = [o.allow_multiple, o.allowMultiple, o.multi_select, o.multiSelect];
  for (const flag of flags) {
    if (flag === true) return true;
    if (flag === false) return false;
  }
  if (typeof o.type === 'string') {
    const kind = o.type.trim().toLowerCase();
    if (kind === 'multiple' || kind === 'multi_select' || kind === 'multi') return true;
    if (kind === 'single' || kind === 'single_select') return false;
  }
  return undefined;
}

/**
 * Canonicalize one validated question object (aliases + prompt inference for multi-select).
 */
export function normalizeAskQuestionItem(raw) {
  const o = raw;
  const item = {
    id: String(o.id).trim(),
    prompt: String(o.prompt).trim(),
    options: o.options.map((opt) => ({
      id: opt.id.trim(),
      label: opt.label.trim(),
      ...(typeof opt.description === 'string' && opt.description.trim() ? { description: opt.description.trim() } : {}),
    })),
  };
  const explicit = readExplicitAllowMultiple(o);
  if (explicit === true) {
    item.allow_multiple = true;
  } else if (explicit === false) {
    item.allow_multiple = false;
  } else if (promptImpliesAllowMultiple(item.prompt)) {
    item.allow_multiple = true;
  }
  return item;
}

/**
 * Returns a specific validation hint for one question object, or null if valid.
 */
export function diagnoseAskQuestionItem(raw) {
  if (!raw || typeof raw !== 'object') {
    return 'must be an object with id, prompt, and options';
  }
  const o = raw;

  if (!isNonEmptyString(o.id)) {
    if (isNonEmptyString(o.questionId)) {
      return 'use "id" (not "questionId") for the question id';
    }
    return 'missing non-empty "id"';
  }
  if (!isNonEmptyString(o.prompt)) {
    if (isNonEmptyString(o.question)) {
      return 'use "prompt" (not "question") for the question text';
    }
    if (isNonEmptyString(o.text)) {
      return 'use "prompt" (not "text") for the question text';
    }
    return 'missing non-empty "prompt" (the question text shown to the user)';
  }
  if (!Array.isArray(o.options)) {
    if (Array.isArray(o.choices)) {
      return 'use "options" (not "choices") for the preset answers array';
    }
    return 'missing "options" array (at least 2 {id, label} objects)';
  }
  if (o.options.length < MIN_OPTIONS) {
    return `options must have at least ${MIN_OPTIONS} entries (got ${o.options.length})`;
  }
  for (let j = 0; j < o.options.length; j++) {
    const opt = o.options[j];
    if (typeof opt === 'string') {
      return `options[${j}] must be {"id":"...","label":"..."} objects, not plain strings`;
    }
    if (!opt || typeof opt !== 'object') {
      return `options[${j}] must be an object with id and label`;
    }
    const oo = opt;
    if (!isNonEmptyString(oo.id)) {
      if (isNonEmptyString(oo.value)) {
        return `options[${j}]: use "id" (not "value") for the option id`;
      }
      return `options[${j}] missing non-empty "id"`;
    }
    if (!isNonEmptyString(oo.label)) {
      if (isNonEmptyString(oo.text)) {
        return `options[${j}]: use "label" (not "text") for the option title`;
      }
      if (isNonEmptyString(oo.name)) {
        return `options[${j}]: use "label" (not "name") for the option title`;
      }
      return `options[${j}] missing non-empty "label"`;
    }
  }
  for (const key of ['allow_multiple', 'allowMultiple', 'multi_select', 'multiSelect']) {
    if (typeof o[key] !== 'undefined' && typeof o[key] !== 'boolean') {
      return `${key} must be a boolean when provided`;
    }
  }
  if (typeof o.type !== 'undefined' && typeof o.type !== 'string') {
    return 'type must be a string when provided';
  }
  return null;
}

/**
 * Validates model-provided arguments. Returns normalized args or an error message.
 */
export function validateAskQuestionArgs(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'arguments must be an object' };
  }
  const o = raw;
  let title;
  if (o.title !== undefined) {
    if (!isNonEmptyString(o.title)) {
      return { ok: false, error: 'title must be a non-empty string when provided' };
    }
    title = o.title.trim();
  }
  if (!Array.isArray(o.questions) || o.questions.length === 0) {
    return { ok: false, error: 'questions must be a non-empty array' };
  }
  if (o.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: `at most ${MAX_QUESTIONS} questions allowed` };
  }
  const questionIds = new Set();
  for (let i = 0; i < o.questions.length; i++) {
    const q = o.questions[i];
    const itemError = diagnoseAskQuestionItem(q);
    if (itemError) {
      return {
        ok: false,
        error: `questions[${i}]: ${itemError}. Required shape: { "id": "...", "prompt": "...", "options": [{ "id": "...", "label": "..." }, ...] }`,
      };
    }
    const questionId = q.id.trim();
    if (questionIds.has(questionId)) {
      return { ok: false, error: `duplicate question id: ${q.id}` };
    }
    questionIds.add(questionId);
    const optionIds = new Set();
    for (const opt of q.options) {
      const optionId = opt.id.trim();
      if (optionId === ASK_QUESTION_OTHER_ID) {
        return {
          ok: false,
          error: `option id "${ASK_QUESTION_OTHER_ID}" is reserved for the UI Other row`,
        };
      }
      if (optionIds.has(optionId)) {
        return { ok: false, error: `duplicate option id "${opt.id}" in question "${q.id}"` };
      }
      optionIds.add(optionId);
    }
  }
  const questions = o.questions.map((q) => normalizeAskQuestionItem(q));
  return { ok: true, args: { ...(title === undefined ? {} : { title }), questions } };
}

/** Serializes a structured tool result for the model (always JSON string in history). */
export function stringifyAskQuestionResult(result) {
  return JSON.stringify(result);
}
