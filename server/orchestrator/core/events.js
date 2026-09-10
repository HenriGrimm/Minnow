/** Journal event shapes and validation. */

/** Envelope version this build writes. Readers tolerate anything >= 1. */
export const ENVELOPE_VERSION = 1;

/**
 * Field type vocabulary used by {@link EVENT_SCHEMAS}.
 * @typedef {'id' | 'str' | 'int' | 'posint' | 'str[]' | 'obj[]' | 'obj' | { enum: string[] }} FieldType
 */

/** How an attempt ended. Three reported by the agent, three by the runner. */
export const ATTEMPT_OUTCOMES = /** @type {const} */ ([
  'pass',
  'fail',
  'blocked',
  'no_report',
  'crashed',
  'timeout',
]);

/** Roles that can own an attempt. `merge` and `final` are engine-driven. */
export const ROLES = /** @type {const} */ (['builder', 'tester', 'merge', 'final']);

/** Why a board stopped. */
export const STOP_REASONS = /** @type {const} */ (['user', 'complete', 'terminal', 'quota']);

/**
 * The event vocabulary.
 */
export const EVENT_SCHEMAS = /** @type {const} */ ({
  'board.created': {
    required: { boardId: 'id', planPath: 'str', tasks: 'obj[]', waves: 'obj[]' },
    optional: { name: 'str', workspacePath: 'str' },
  },
  'board.started': {
    required: { concurrency: 'posint' },
    optional: {},
  },
  'board.stopped': {
    required: { reason: { enum: STOP_REASONS } },
    optional: {},
  },
  'task.attempt.started': {
    required: { taskId: 'id', attemptId: 'id', role: { enum: ROLES } },
    optional: { worktree: 'str', seedKind: 'str' },
  },
  'task.attempt.ended': {
    required: {
      taskId: 'id',
      attemptId: 'id',
      role: { enum: ROLES },
      outcome: { enum: ATTEMPT_OUTCOMES },
    },
    optional: { summary: 'str', evidence: 'obj', usage: 'obj' },
  },
  'merge.enqueued': {
    required: { taskId: 'id' },
    optional: {},
  },
  'merge.succeeded': {
    required: { taskId: 'id', sha: 'id' },
    optional: { beforeSha: 'id' },
  },
  'merge.conflicted': {
    required: { taskId: 'id', files: 'str[]' },
    optional: { beforeSha: 'id', summary: 'str' },
  },
  'task.abandoned': {
    required: { taskId: 'id', reason: 'id' },
    optional: { evidence: 'obj' },
  },
  'task.skipped': {
    required: { taskId: 'id', blockedBy: 'id' },
    optional: {},
  },
  'touches.overflow': {
    required: { taskId: 'id', attemptId: 'id', declared: 'str[]', actual: 'str[]' },
    optional: {},
  },
  'final.test.ended': {
    required: { outcome: { enum: ['pass', 'fail'] } },
    optional: { runInstructions: 'str', evidence: 'obj' },
  },
  'run.finished': {
    required: { summary: 'str' },
    optional: {},
  },
  'board.model.set': {
    required: { providerId: 'id', id: 'id' },
    optional: { reasoning: 'str' },
  },
  'board.renamed': {
    required: { name: 'str' },
    optional: {},
  },
  'board.reopened': {
    required: { taskIds: 'str[]', reason: 'str' },
    optional: {},
  },
  'task.added': {
    required: { task: 'obj' },
    optional: { wave: 'obj' },
  },
  'task.reset': {
    required: { taskIds: 'str[]', reason: 'str' },
    optional: {},
  },
  'board.rewound': {
    required: { fromTaskId: 'id', beforeSha: 'id', taskIds: 'str[]', reason: 'str' },
    optional: {},
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
 * @param {FieldType} type
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
  const required = /** @type {Record<string, FieldType>} */ (schema.required);
  const optional = /** @type {Record<string, FieldType>} */ (schema.optional);

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
