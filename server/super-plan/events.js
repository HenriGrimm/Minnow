/** Journal event shapes and validation for the Super Plan run engine. */

/** Envelope version this build writes. Readers tolerate anything >= 1. */
export const ENVELOPE_VERSION = 1;

/** Every stage the engine can run. Each is also a Desired role. */
export const STAGES = /** @type {const} */ (['interview', 'research', 'draft', 'review', 'polish']);

/** Stages that run a model turn through `runTurn`. Research uses the Research store. */
export const AGENT_STAGES = /** @type {const} */ (['interview', 'draft', 'review', 'polish']);

/** Stages the pipeline can do without. The rest are required for a plan. */
export const OPTIONAL_STAGES = /** @type {const} */ (['research', 'review', 'polish']);

/** How a stage attempt ended. `rejected` means the work did not pass its checks. */
export const STAGE_OUTCOMES = /** @type {const} */ (['ok', 'crashed', 'timeout', 'rejected']);

/** The two user checkpoints. Neither makes a model call and neither expires. */
export const CHECKPOINTS = /** @type {const} */ (['spec', 'accept']);

/** What a user can answer at each checkpoint. */
export const CHECKPOINT_VERDICTS = Object.freeze({
  spec: Object.freeze(['confirm', 'revise']),
  accept: Object.freeze(['accept', 'revise', 'review']),
});

/** Files the pipeline owns. */
export const ARTIFACT_KINDS = /** @type {const} */ (['spec', 'research', 'plan']);

/** Why an attempt is seeded the way it is. */
export const SEED_KINDS = /** @type {const} */ ([
  'initial',
  'continue',
  'errors',
  'revise',
  'findings',
  'feedback',
  'rework',
]);

/**
 * v2 stage names. Old journals still fold, so `stage.*` and `gate.*` accept
 * these without failing validation; the fold maps or ignores them.
 */
const LEGACY_STAGES = ['spec', 'gate'];
const ANY_STAGE = [...STAGES, ...LEGACY_STAGES];

/**
 * The event vocabulary.
 *
 * Every event records a completed fact: a run was created, a stage ended, a
 * file was written, a question was answered. Nothing here asks for work.
 * Replay only recovers a crashed run if the fold is a pure function of this
 * list, so the fold never reads a clock and never touches disk.
 */
export const EVENT_SCHEMAS = /** @type {const} */ ({
  // ── lifecycle ──────────────────────────────────────────────────────────────
  'run.created': {
    required: { runId: 'id', prompt: 'str' },
    optional: { workspacePath: 'str', config: 'obj', chatId: 'str', title: 'str' },
  },
  'run.started': { required: {}, optional: {} },
  'run.paused': { required: {}, optional: { reason: 'str' } },
  'run.resumed': { required: {}, optional: { reason: 'str' } },
  'run.cancelled': { required: {}, optional: { reason: 'str' } },
  /** v2: `paused` is a pause, `gate-expired` a terminal failure. */
  'run.stopped': { required: { reason: 'str' }, optional: {} },
  /** v2 terminal outcome. v3 finishes through `checkpoint.answered`. */
  'run.finished': { required: { outcome: 'str' }, optional: { summary: 'str' } },
  // ── identity ───────────────────────────────────────────────────────────────
  'slug.assigned': { required: { slug: 'str' }, optional: { title: 'str', displayTitle: 'str' } },
  'run.renamed': { required: {}, optional: { title: 'str', slug: 'str' } },
  // ── stages ─────────────────────────────────────────────────────────────────
  'stage.started': {
    required: { stage: { enum: ANY_STAGE }, attemptId: 'id' },
    optional: { seedKind: 'str', iteration: 'posint', transcriptKey: 'str' },
  },
  'stage.ended': {
    required: { stage: { enum: ANY_STAGE }, attemptId: 'id', outcome: 'str' },
    optional: { summary: 'str', errors: 'str[]', addressed: 'obj', usage: 'obj' },
  },
  'stage.skipped': { required: { stage: { enum: ANY_STAGE } }, optional: { reason: 'str' } },
  'stage.reopened': { required: { stage: { enum: ANY_STAGE } }, optional: { reason: 'str' } },
  // ── artifacts ──────────────────────────────────────────────────────────────
  'artifact.written': {
    required: { kind: { enum: ARTIFACT_KINDS }, path: 'str' },
    optional: {
      sha256: 'str',
      attemptId: 'str',
      involvesUi: 'bool',
      title: 'str',
      empty: 'bool',
      bytes: 'int',
      executable: 'bool',
      tasks: 'int',
    },
  },
  'spec.written': { required: { path: 'str' }, optional: { sha256: 'str', attemptId: 'str', involvesUi: 'bool' } },
  'research.written': { required: { path: 'str' }, optional: { sha256: 'str', attemptId: 'str', involvesUi: 'bool' } },
  'plan.written': { required: { path: 'str' }, optional: { sha256: 'str', attemptId: 'str', involvesUi: 'bool' } },
  'research.started': { required: { researchId: 'id' }, optional: {} },
  // ── review ─────────────────────────────────────────────────────────────────
  'review.recorded': {
    required: { round: 'posint', findings: 'obj[]' },
    optional: { summary: 'str', attemptId: 'str' },
  },
  // ── interview questions ────────────────────────────────────────────────────
  'question.asked': {
    required: { questionId: 'id', questions: 'obj[]' },
    optional: { attemptId: 'str', title: 'str' },
  },
  'question.answered': {
    required: { questionId: 'id' },
    optional: { answer: 'obj', skipped: 'bool' },
  },
  'question.cancelled': { required: { questionId: 'id' }, optional: { reason: 'str' } },
  'questions.closed': { required: {}, optional: { reason: 'str' } },
  // ── checkpoints ────────────────────────────────────────────────────────────
  'checkpoint.answered': {
    required: { checkpoint: { enum: CHECKPOINTS }, verdict: 'str' },
    optional: { feedback: 'str' },
  },
  // ── v2 gates (read-only compatibility) ─────────────────────────────────────
  'gate.opened': { required: {}, optional: {} },
  'gate.answered': { required: {}, optional: {} },
  'gate.expired': { required: {}, optional: {} },
});

/** Every known event type, in declaration order. */
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS);

/**
 * Is this a type the fold understands?
 * @param {unknown} type
 * @returns {boolean}
 */
export function isKnownEventType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, type);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {import('./types').FieldType} type
 * @returns {string | null} a human message, or null when the value conforms
 */
function checkField(value, type) {
  if (typeof type === 'object') {
    return type.enum.includes(/** @type {string} */ (value))
      ? null
      : `must be one of ${type.enum.join(' | ')}`;
  }
  switch (type) {
    case 'id':
      return typeof value === 'string' && value.length > 0 ? null : 'must be a non-empty string';
    case 'bool':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'str':
      return typeof value === 'string' ? null : 'must be a string';
    case 'int':
      return Number.isSafeInteger(value) ? null : 'must be an integer';
    case 'posint':
      return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 1
        ? null
        : 'must be an integer >= 1';
    case 'str[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : 'must be an array of strings';
    case 'obj[]':
      return Array.isArray(value) && value.every(isPlainObject)
        ? null
        : 'must be an array of objects';
    case 'obj':
      return isPlainObject(value) ? null : 'must be an object';
    default:
      return `unknown field type ${String(type)}`;
  }
}

/**
 * Validate one raw journal line.
 * @param {unknown} raw
 * @returns {{ ok: true, event: Record<string, unknown>, known: boolean }
 *          | { ok: false, error: string }}
 */
export function validateEvent(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'event must be an object' };
  const event = /** @type {Record<string, unknown>} */ (raw);

  if (typeof event.type !== 'string' || event.type.length === 0) {
    return { ok: false, error: 'type: must be a non-empty string' };
  }
  if ('v' in event && !(Number.isSafeInteger(event.v) && /** @type {number} */ (event.v) >= 1)) {
    return { ok: false, error: 'v: must be an integer >= 1' };
  }
  if ('seq' in event && !(Number.isSafeInteger(event.seq) && /** @type {number} */ (event.seq) >= 1)) {
    return { ok: false, error: 'seq: must be an integer >= 1' };
  }
  if ('ts' in event && !(typeof event.ts === 'number' && Number.isFinite(event.ts))) {
    return { ok: false, error: 'ts: must be a finite number' };
  }

  if (!isKnownEventType(event.type)) {
    return { ok: true, event, known: false };
  }

  const schema = EVENT_SCHEMAS[/** @type {keyof typeof EVENT_SCHEMAS} */ (event.type)];
  const required = /** @type {Record<string, import('./types').FieldType>} */ (schema.required);
  const optional = /** @type {Record<string, import('./types').FieldType>} */ (schema.optional);

  for (const [field, type] of Object.entries(required)) {
    if (!(field in event)) return { ok: false, error: `${event.type}.${field}: is required` };
    const problem = checkField(event[field], type);
    if (problem) return { ok: false, error: `${event.type}.${field}: ${problem}` };
  }
  for (const [field, type] of Object.entries(optional)) {
    if (!(field in event) || event[field] === undefined) continue;
    const problem = checkField(event[field], type);
    if (problem) return { ok: false, error: `${event.type}.${field}: ${problem}` };
  }

  return { ok: true, event, known: true };
}

/**
 * Build an envelope around a payload. The journal writer stamps `seq` and `ts`.
 *
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 * @returns {Record<string, unknown>}
 */
export function makeEvent(type, payload = {}) {
  /** @type {Record<string, unknown>} */
  const event = { v: ENVELOPE_VERSION, type };
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) event[key] = value;
  }
  return event;
}
