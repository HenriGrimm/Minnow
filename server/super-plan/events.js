/** Journal event shapes and validation for the Super Plan run engine. */

/** Envelope version this build writes. Readers tolerate anything >= 1. */
export const ENVELOPE_VERSION = 1;

/** Every stage the pipeline can run. Each is a Desired role too. */
export const STAGES = /** @type {const} */ (['interview', 'spec', 'research', 'draft', 'review', 'polish', 'gate']);

/** How a stage attempt ended. `rejected` is the accept-gate verdict on a draft. */
export const STAGE_OUTCOMES = /** @type {const} */ (['ok', 'crashed', 'timeout', 'rejected']);

/** The two user checkpoints. */
export const GATE_KINDS = /** @type {const} */ (['spec', 'accept', 'question']);

/** What a user can say at a gate. */
export const GATE_VERDICTS = /** @type {const} */ (['confirm', 'revise', 'accept', 'reject']);

/** How a whole run ended. */
export const RUN_OUTCOMES = /** @type {const} */ (['pass', 'fail', 'skip']);

/** Why a run stopped. `paused` is non-terminal (resumable via `run.resumed`). */
export const STOP_REASONS = /** @type {const} */ ([
  'cancelled',
  'gate-expired',
  'complete',
  'failed',
  'skipped',
  'paused',
]);

/**
 * The event vocabulary.
 *
 * Every event records a completed fact: a run was created, a stage ended, an
 * artifact was written, a review round was recorded, a gate was answered.
 * There is no `.requested` and no `.pending` in the vocabulary — nothing here
 * asks for work, it reports work that is already true. Replay only recovers a
 * crashed run if the fold is a pure function of this list.
 */
export const EVENT_SCHEMAS = /** @type {const} */ ({
  // ── lifecycle ──────────────────────────────────────────────────────────────
  'run.created': {
    required: { runId: 'id', prompt: 'str' },
    optional: { workspacePath: 'str', config: 'obj', chatId: 'str' },
  },
  'run.started': {
    required: {},
    optional: {},
  },
  'run.resumed': {
    required: {},
    optional: {},
  },
  'run.cancelled': {
    required: { reason: { enum: ['user'] } },
    optional: {},
  },
  'run.stopped': {
    // `paused` is the non-terminal stop (D8): the run keeps its stage and
    // attempt, and a later `run.resumed` re-plans the *same* stage.
    required: { reason: { enum: ['gate-expired', 'paused'] } },
    optional: {},
  },
  'run.finished': {
    required: { outcome: { enum: RUN_OUTCOMES }, summary: 'str' },
    optional: {},
  },
  // ── identity ───────────────────────────────────────────────────────────────
  'slug.assigned': { required: { slug: 'str' }, optional: { displayTitle: 'str' } },
  'run.renamed': {
    required: { slug: 'str' },
    optional: {},
  },
  // ── stages ─────────────────────────────────────────────────────────────────
  'stage.reopened': { required: { stage: { enum: STAGES } }, optional: {} },
  'stage.skipped': { required: { stage: { enum: STAGES } }, optional: {} },
  'stage.started': {
    required: { stage: { enum: STAGES }, attemptId: 'id' },
    optional: { seedKind: 'str' },
  },
  'stage.ended': {
    required: { stage: { enum: STAGES }, attemptId: 'id', outcome: { enum: STAGE_OUTCOMES } },
    optional: { summary: 'str', errors: 'str[]', addressed: 'obj' },
  },
  // ── artifacts ──────────────────────────────────────────────────────────────
  'spec.written': {
    required: { path: 'str' },
    optional: { sha256: 'str', attemptId: 'str', involvesUi: 'bool' },
  },
  'research.started': { required: { researchId: 'id' }, optional: {} },
  'research.written': {
    required: { path: 'str' },
    optional: { sha256: 'str', attemptId: 'str', involvesUi: 'bool' },
  },
  'plan.written': {
    required: { path: 'str' },
    optional: { sha256: 'str', attemptId: 'str', involvesUi: 'bool' },
  },
  // ── review ─────────────────────────────────────────────────────────────────
  'review.recorded': {
    required: { round: 'posint', findings: 'obj[]' },
    optional: {},
  },
  // ── gates ──────────────────────────────────────────────────────────────────
  'gate.opened': {
    required: { kind: { enum: GATE_KINDS } },
    optional: { gateId: 'str', attemptId: 'str', question: 'str', choices: 'str[]', questions: 'obj[]', title: 'str' },
  },
  'gate.answered': {
    required: { kind: { enum: GATE_KINDS }, verdict: 'str' },
    optional: { errors: 'str[]', gateId: 'str', attemptId: 'str' },
  },
  'gate.expired': {
    required: { kind: { enum: GATE_KINDS } },
    optional: { gateId: 'str', attemptId: 'str', question: 'str', choices: 'str[]' },
  },
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
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return { v: ENVELOPE_VERSION, type, ...payload };
}
