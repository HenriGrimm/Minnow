export const ENVELOPE_VERSION = 1;

export const ATTEMPT_OUTCOMES = /** @type {const} */ ([
  'pass',
  'fail',
  'blocked',
  'no_report',
  'crashed',
  'timeout',
]);

export const SUB_AGENT_ROLE = /** @type {const} */ ('sub-agent');

/**
 * @typedef {'id' | 'str' | 'int' | 'posint' | 'str[]' | 'obj[]' | 'obj' | { enum: string[] }} FieldType
 */
export const EVENT_SCHEMAS = /** @type {const} */ ({
  'run.requested': {
    required: {
      runId: 'id',
      agentType: 'id',
      task: 'str',
      parentChatId: 'id',
      cwd: 'str',
      requestedAt: 'int',
    },
    optional: {
      parentTurnId: 'str',
      parentToolCallId: 'str',
      model: 'obj',
      modelSource: 'str',
    },
  },
  'attempt.started': {
    required: { runId: 'id', attemptId: 'id', seed: 'obj' },
    optional: { model: 'obj', seedKind: 'str' },
  },
  'attempt.ended': {
    required: {
      runId: 'id',
      attemptId: 'id',
      outcome: { enum: ATTEMPT_OUTCOMES },
    },
    optional: { summary: 'str', evidence: 'obj', usage: 'obj', resolvedModel: 'obj' },
  },
  'run.abandoned': {
    required: { runId: 'id', reason: 'id' },
    optional: { evidence: 'obj' },
  },
  'run.cancelled': {
    required: { runId: 'id', reason: { enum: ['user'] } },
    optional: {},
  },
  'result.delivered': {
    required: { runId: 'id', parentChatId: 'id' },
    optional: { skipReason: { enum: ['missing_chat', 'orchestrate'] } },
  },
  'run.nudged': {
    required: { runId: 'id', parentChatId: 'id' },
    optional: {},
  },
});

export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS);

/**
 * @param {unknown} type
 * @returns {boolean}
 */
export function isKnownEventType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, type);
}

/**
 * @param {unknown} value
 * @param {FieldType} type
 * @returns {string | null}
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
