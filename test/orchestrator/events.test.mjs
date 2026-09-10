/**
 * P0-B — journal event schema and versioned envelope.
 *
 * The journal is the state, so these tests are about the vocabulary being
 * exhaustive and tolerant at the same time: every known shape validated field by
 * field, every unknown shape carried through untouched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTEMPT_OUTCOMES,
  ENVELOPE_VERSION,
  EVENT_SCHEMAS,
  EVENT_TYPES,
  isKnownEventType,
  makeEvent,
  ROLES,
  STOP_REASONS,
  validateEvent,
} from '../../server/orchestrator/core/events.js';

/** One valid instance of every event type, used as the mutation base. */
const SAMPLES = {
  'board.created': {
    boardId: 'b1',
    planPath: 'documentation/plans/x.md',
    tasks: [{ id: 'W1-A' }],
    waves: [{ n: 1, name: 'Foundations' }],
  },
  'board.started': { concurrency: 2 },
  'board.stopped': { reason: 'user' },
  'task.attempt.started': { taskId: 'W1-A', attemptId: 'a1', role: 'builder' },
  'task.attempt.ended': {
    taskId: 'W1-A',
    attemptId: 'a1',
    role: 'builder',
    outcome: 'pass',
  },
  'merge.enqueued': { taskId: 'W1-A' },
  'merge.succeeded': { taskId: 'W1-A', sha: 'deadbeef' },
  'merge.conflicted': { taskId: 'W1-A', files: ['src/a.ts'] },
  'task.abandoned': { taskId: 'W1-A', reason: 'builder-failed-twice' },
  'task.skipped': { taskId: 'W1-B', blockedBy: 'W1-A' },
  'touches.overflow': {
    taskId: 'W1-A',
    attemptId: 'a1',
    declared: ['src/a.ts'],
    actual: ['src/a.ts', 'package-lock.json'],
  },
  'final.test.ended': { outcome: 'pass' },
  'run.finished': { summary: '3 merged, 1 abandoned' },
  'board.model.set': { providerId: 'anthropic', id: 'claude-opus-5' },
  'board.renamed': { name: 'Phase 9' },
  'board.reopened': { taskIds: ['W1-A', 'W1-B'], reason: 'user' },
  'task.added': {
    task: {
      id: 'FIX-1',
      title: 'Fix',
      wave: 2,
      dependsOn: [],
      touches: ['**/*'],
      build: 'b',
      test: 't',
      accept: 'x',
      line: 0,
    },
  },
  'task.reset': { taskIds: ['W1-A'], reason: 'user' },
  'board.rewound': {
    fromTaskId: 'W1-A',
    beforeSha: 'abc123',
    taskIds: ['W1-A', 'W1-B'],
    reason: 'user',
  },
};

/** @param {string} type */
const sample = (type) => makeEvent(type, { ...SAMPLES[type] });

// ── Vocabulary ───────────────────────────────────────────────────────────────

describe('event vocabulary', () => {
  it('declares exactly the nineteen types', () => {
    assert.equal(EVENT_TYPES.length, 19);
    assert.deepEqual(EVENT_TYPES, Object.keys(SAMPLES));
  });

  it('names no event after an intent', () => {
    for (const type of EVENT_TYPES) {
      assert.doesNotMatch(type, /\.(requested|pending|starting|will)$/, `${type} names an intent`);
    }
  });

  it('exposes the six-way outcome union and the four roles', () => {
    assert.deepEqual([...ATTEMPT_OUTCOMES], [
      'pass',
      'fail',
      'blocked',
      'no_report',
      'crashed',
      'timeout',
    ]);
    assert.deepEqual([...ROLES], ['builder', 'tester', 'merge', 'final']);
    assert.deepEqual([...STOP_REASONS], ['user', 'complete', 'terminal', 'quota']);
  });

  it('recognises known types and only known types', () => {
    for (const type of EVENT_TYPES) assert.equal(isKnownEventType(type), true);
    assert.equal(isKnownEventType('some.future.event'), false);
    assert.equal(isKnownEventType(''), false);
    assert.equal(isKnownEventType(undefined), false);
    assert.equal(isKnownEventType('toString'), false); // not inherited from Object.prototype
  });
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('validateEvent — the happy path', () => {
  for (const type of EVENT_TYPES) {
    it(`accepts a well-formed ${type}`, () => {
      const result = validateEvent({ ...sample(type), seq: 7, ts: 1_700_000_000_000 });
      assert.equal(result.ok, true);
      assert.equal(result.known, true);
    });
  }

  it('round-trips every event through JSON unchanged', () => {
    for (const type of EVENT_TYPES) {
      const event = { ...sample(type), seq: 1, ts: 1 };
      assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
    }
  });

  it('accepts optional fields when present and when absent', () => {
    assert.equal(validateEvent(makeEvent('task.attempt.started', {
      ...SAMPLES['task.attempt.started'],
      worktree: '/tmp/wt',
      seedKind: 'initial',
    })).ok, true);
    assert.equal(validateEvent(makeEvent('task.attempt.ended', {
      ...SAMPLES['task.attempt.ended'],
      summary: '',
      evidence: { log: 'x' },
    })).ok, true);
  });

  it('rejects an optional field of the wrong type', () => {
    const bad = validateEvent(makeEvent('task.attempt.ended', {
      ...SAMPLES['task.attempt.ended'],
      evidence: 'not-an-object',
    }));
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'task.attempt.ended.evidence: must be an object');
  });
});

// ── Per-field tests ──────────────────────────────────────────────────────────

describe('validateEvent — one test per required field', () => {
  for (const type of EVENT_TYPES) {
    for (const field of Object.keys(EVENT_SCHEMAS[type].required)) {
      it(`rejects ${type} missing ${field}`, () => {
        const event = sample(type);
        delete event[field];
        const result = validateEvent(event);
        assert.equal(result.ok, false);
        assert.equal(result.error, `${type}.${field}: is required`);
      });

      it(`rejects ${type} with a wrong-typed ${field}`, () => {
        const event = sample(type);
        event[field] = EVENT_SCHEMAS[type].required[field] === 'posint' ? 'two' : 42;
        const result = validateEvent(event);
        assert.equal(result.ok, false, `${type}.${field} accepted a wrong type`);
        assert.match(result.error, new RegExp(`^${type}\\.${field}: `));
      });
    }
  }

  it('rejects an empty id rather than treating it as present', () => {
    const result = validateEvent(makeEvent('task.attempt.started', {
      ...SAMPLES['task.attempt.started'],
      taskId: '',
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'task.attempt.started.taskId: must be a non-empty string');
  });

  it('rejects an out-of-range enum value', () => {
    const result = validateEvent(makeEvent('board.stopped', { reason: 'because' }));
    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      'board.stopped.reason: must be one of user | complete | terminal | quota',
    );
  });

  it('rejects a concurrency below one', () => {
    assert.equal(validateEvent(makeEvent('board.started', { concurrency: 0 })).ok, false);
    assert.equal(validateEvent(makeEvent('board.started', { concurrency: 1.5 })).ok, false);
    assert.equal(validateEvent(makeEvent('board.started', { concurrency: 1 })).ok, true);
  });
});

// ── Envelope ─────────────────────────────────────────────────────────────────

describe('validateEvent — envelope', () => {
  it('requires a non-empty type', () => {
    assert.equal(validateEvent({ v: 1 }).error, 'type: must be a non-empty string');
    assert.equal(validateEvent({ v: 1, type: '' }).error, 'type: must be a non-empty string');
  });

  it('rejects a non-object', () => {
    for (const raw of [null, undefined, 42, 'x', ['a']]) {
      assert.equal(validateEvent(raw).error, 'event must be an object');
    }
  });

  it('type-checks seq and ts when present', () => {
    assert.equal(validateEvent({ ...sample('run.finished'), seq: 0 }).ok, false);
    assert.equal(validateEvent({ ...sample('run.finished'), seq: 1.5 }).ok, false);
    assert.equal(validateEvent({ ...sample('run.finished'), ts: 'now' }).ok, false);
    assert.equal(validateEvent({ ...sample('run.finished'), ts: Number.NaN }).ok, false);
  });

  it('accepts an unstamped event, because the writer stamps seq and ts', () => {
    const result = validateEvent(sample('run.finished'));
    assert.equal(result.ok, true);
    assert.equal('seq' in result.event, false);
  });

  it('stamps the current envelope version on makeEvent', () => {
    assert.equal(makeEvent('run.finished', { summary: '' }).v, ENVELOPE_VERSION);
    assert.equal(ENVELOPE_VERSION, 1);
  });

  it('accepts optional beforeSha on merge results (P3-C snapshot)', () => {
    assert.equal(validateEvent({ ...sample('merge.succeeded'), beforeSha: 'abc123' }).ok, true);
    assert.equal(validateEvent({ ...sample('merge.conflicted'), beforeSha: 'abc123' }).ok, true);
    assert.equal(validateEvent({ ...sample('merge.succeeded'), beforeSha: '' }).ok, false);
  });

  it('accepts optional workspacePath on board.created (MIN-752)', () => {
    assert.equal(validateEvent(sample('board.created')).ok, true);
    assert.equal(
      validateEvent({ ...sample('board.created'), workspacePath: '/repos/minnow' }).ok,
      true,
    );
    assert.equal(
      validateEvent({ ...sample('board.created'), workspacePath: 12 }).ok,
      false,
    );
  });
});

// ── Tolerance ────────────────────────────────────────────────────────────────

describe('validateEvent — tolerance', () => {
  it('tolerates an unknown type as opaque rather than erroring', () => {
    const result = validateEvent({ v: 1, type: 'some.future.event' });
    assert.equal(result.ok, true);
    assert.equal(result.known, false);
    assert.deepEqual(result.event, { v: 1, type: 'some.future.event' });
  });

  it('tolerates a future envelope version', () => {
    const result = validateEvent({ v: 2, type: 'run.finished', summary: 'x' });
    assert.equal(result.ok, true);
  });

  it('tolerates a v: 2 event of an unknown type carrying arbitrary payload', () => {
    const result = validateEvent({ v: 2, seq: 9, ts: 1, type: 'x.y.z', anything: [1, { a: 2 }] });
    assert.equal(result.ok, true);
    assert.equal(result.known, false);
  });

  it('still rejects a malformed known event on a future envelope version', () => {
    assert.equal(validateEvent({ v: 2, type: 'merge.succeeded', taskId: 'W1-A' }).ok, false);
  });

  it('rejects a bad envelope version outright', () => {
    assert.equal(validateEvent({ v: 0, type: 'run.finished', summary: '' }).ok, false);
    assert.equal(validateEvent({ v: '1', type: 'run.finished', summary: '' }).ok, false);
  });
});
