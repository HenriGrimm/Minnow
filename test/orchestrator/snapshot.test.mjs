import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import {
  canonicalise,
  decanonicalise,
  deriveFrom,
  hashState,
  isSnapshotUsable,
  makeSnapshot,
  SNAPSHOT_INTERVAL,
  SNAPSHOT_VERSION,
  shouldSnapshot,
  stateFromJSON,
  stateToJSON,
} from '../../server/orchestrator/core/snapshot.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OUTCOMES = ['pass', 'fail', 'blocked', 'no_report', 'crashed', 'timeout'];

function longJournal(target = 5000, seed = 7) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const tasks = Array.from({ length: 40 }, (_, i) => ({
    id: `T${i}`,
    title: `Task ${i}`,
    wave: 1 + Math.floor(i / 8),
    dependsOn: i > 0 && r() < 0.4 ? [`T${Math.floor(r() * i)}`] : [],
    touches: [`src/t${i}/**`],
    build: 'b',
    test: 't',
    accept: 'a',
  }));

  const events = [
    makeEvent('board.created', { boardId: 'big', planPath: 'p.md', tasks, waves: [] }),
    makeEvent('board.started', { concurrency: 4 }),
  ];
  let n = 0;
  while (events.length < target) {
    const task = tasks[Math.floor(r() * tasks.length)];
    const role = pick(['builder', 'tester']);
    const id = `a${(n += 1)}`;
    events.push(makeEvent('task.attempt.started', { taskId: task.id, attemptId: id, role }));
    if (r() < 0.9) {
      events.push(
        makeEvent('task.attempt.ended', {
          taskId: task.id,
          attemptId: id,
          role,
          outcome: pick(OUTCOMES),
          summary: 'x'.repeat(Math.floor(r() * 40)),
        }),
      );
    }
    const roll = r();
    if (roll < 0.12) {
      events.push(makeEvent('merge.enqueued', { taskId: task.id }));
      events.push(makeEvent('merge.succeeded', { taskId: task.id, sha: `sha${n}` }));
    } else if (roll < 0.16) {
      events.push(makeEvent('merge.enqueued', { taskId: task.id }));
      events.push(makeEvent('merge.conflicted', { taskId: task.id, files: ['src/x.ts'] }));
    } else if (roll < 0.19) {
      events.push(makeEvent('task.abandoned', { taskId: task.id, reason: 'builder-failed' }));
    } else if (roll < 0.21) {
      events.push(
        makeEvent('touches.overflow', {
          taskId: task.id,
          attemptId: id,
          declared: [`src/t${task.id}/**`],
          actual: ['package-lock.json'],
        }),
      );
    }
  }
  events.push(makeEvent('run.finished', { summary: 'done' }));
  return events.map((e, i) => ({ ...e, seq: i + 1, ts: 1_700_000_000_000 + i }));
}

const JOURNAL = longJournal();

function snapshotAt(throughSeq, journal = JOURNAL) {
  const head = journal.filter((e) => e.seq <= throughSeq);
  return makeSnapshot('big', derive(head), throughSeq);
}

// ── Equivalence ──────────────────────────────────────────────────────────────

describe('snapshot — the equivalence property', () => {
  it('resumes to the same state at every 200-event boundary', () => {
    const full = derive(JOURNAL);
    let boundaries = 0;
    for (let through = SNAPSHOT_INTERVAL; through < JOURNAL.length; through += SNAPSHOT_INTERVAL) {
      boundaries += 1;
      const snapshot = snapshotAt(through);
      assert.equal(isSnapshotUsable(snapshot, JOURNAL), true, `unusable at ${through}`);
      assert.deepEqual(deriveFrom(snapshot, JOURNAL), full, `diverged at ${through}`);
    }
    assert.ok(boundaries >= 20, `only ${boundaries} boundaries tested`);
  });

  it('resumes correctly from every single-event boundary in the first 300', () => {
    const full = derive(JOURNAL.slice(0, 300));
    const head = JOURNAL.slice(0, 300);
    for (let through = 0; through <= 300; through += 1) {
      const snapshot = snapshotAt(through, head);
      assert.deepEqual(deriveFrom(snapshot, head), full, `diverged at ${through}`);
    }
  });

  it('resumes from a snapshot that is already current', () => {
    const last = JOURNAL[JOURNAL.length - 1].seq;
    const snapshot = snapshotAt(last);
    assert.deepEqual(deriveFrom(snapshot, JOURNAL), derive(JOURNAL));
  });

  it('resumes from an empty-board snapshot with no anchor event', () => {
    const snapshot = makeSnapshot('big', derive([]), 0);
    assert.equal(isSnapshotUsable(snapshot, JOURNAL), true);
    assert.deepEqual(deriveFrom(snapshot, JOURNAL), derive(JOURNAL));
  });

  it('folds only the tail', () => {
    const through = 1000;
    const snapshot = snapshotAt(through);
    const contradicted = JOURNAL.map((e) =>
      e.seq <= through ? { ...e, type: 'task.abandoned', taskId: 'T0', reason: 'injected' } : e,
    );
    assert.deepEqual(deriveFrom(snapshot, contradicted), deriveFrom(snapshot, JOURNAL));
  });
});

// ── Cache ────────────────────────────────────────────────────────────────────

describe('snapshot — a cache, never a source', () => {
  it('is snapshot format version 6', () => {
    assert.equal(SNAPSHOT_VERSION, 6);
  });

  it('changes nothing when deleted', () => {
    assert.deepEqual(deriveFrom(null, JOURNAL), derive(JOURNAL));
    assert.deepEqual(deriveFrom(undefined, JOURNAL), derive(JOURNAL));
  });

  it('falls back to a correct full fold on every corruption mode', () => {
    const full = derive(JOURNAL);
    const good = snapshotAt(1000);

    const corruptions = {
      'mutated state': { ...good, state: stateToJSON(derive(JOURNAL.slice(0, 40))) },
      'mutated throughSeq': { ...good, throughSeq: 1200 },
      'mutated hash': { ...good, stateHash: 'deadbeefdeadbeef' },
      'missing hash': { ...good, stateHash: '' },
      'ahead of the journal': { ...good, throughSeq: JOURNAL.length + 500 },
      'anchor event missing': { ...good, throughSeq: 1000.5 },
      'negative throughSeq': { ...good, throughSeq: -1 },
      'null state': { ...good, state: null },
      'garbage state': { ...good, state: 'not a state' },
      'version skew': { ...good, v: SNAPSHOT_VERSION + 1 },
      'no version': { ...good, v: undefined },
      'an array': [1, 2, 3],
      'a string': 'snapshot',
      'a number': 42,
    };

    for (const [label, snapshot] of Object.entries(corruptions)) {
      assert.equal(isSnapshotUsable(snapshot, JOURNAL), false, `${label}: reported usable`);
      assert.deepEqual(deriveFrom(snapshot, JOURNAL), full, `${label}: wrong fallback state`);
    }
  });

  it('refuses to resume across a journal that is not cleanly sequenced', () => {
    const tasks = [{ id: 'A', title: 'A', wave: 1, dependsOn: [], touches: ['src/a/**'] }];
    const base = [
      { ...makeEvent('board.created', { boardId: 'b', planPath: 'p', tasks, waves: [] }), seq: 1, ts: 1 },
      makeEvent('board.started', { concurrency: 3 }),
      { ...makeEvent('task.attempt.started', { taskId: 'A', attemptId: 'a1', role: 'builder' }), seq: 2, ts: 2 },
    ];
    const snapshot = makeSnapshot('b', derive(base.slice(0, 1)), 1);

    assert.equal(isSnapshotUsable(snapshot, base), false, 'an unsequenced event must veto resume');
    assert.deepEqual(deriveFrom(snapshot, base), derive(base));
    assert.equal(deriveFrom(snapshot, base).status, 'running');
    assert.equal(deriveFrom(snapshot, base).concurrency, 3);
  });

  it('refuses to resume across a duplicated seq', () => {
    const duplicated = JOURNAL.map((e, i) => (i === 1500 ? { ...e, seq: JOURNAL[1499].seq } : e));
    const snapshot = snapshotAt(1000, duplicated);
    assert.equal(isSnapshotUsable(snapshot, duplicated), false);
    assert.deepEqual(deriveFrom(snapshot, duplicated), derive(duplicated));
  });

  it('ignores a version-skewed snapshot rather than migrating it', () => {
    const skewed = { ...snapshotAt(1000), v: 99 };
    assert.equal(isSnapshotUsable(skewed, JOURNAL), false);
    assert.equal(hashState(deriveFrom(skewed, JOURNAL)), hashState(derive(JOURNAL)));
  });

  it('detects a snapshot whose state was edited by hand', () => {
    const tampered = snapshotAt(1000);
    const state = stateFromJSON(tampered.state);
    state.concurrency = 99;
    assert.deepEqual(
      deriveFrom({ ...tampered, state: stateToJSON(state) }, JOURNAL),
      derive(JOURNAL),
    );
  });

  it('exposes no repair path', async () => {
    const module = await import('../../server/orchestrator/core/snapshot.js');
    for (const name of Object.keys(module)) {
      assert.doesNotMatch(
        name,
        /repair|reconcile|patch|fix|migrate|salvage/i,
        `snapshot.js exports ${name}`,
      );
    }
  });
});

// ── Hash state ───────────────────────────────────────────────────────────────

describe('hashState — stable and order-independent', () => {
  it('is stable across repeated calls', () => {
    const state = derive(JOURNAL);
    const first = hashState(state);
    for (let i = 0; i < 20; i += 1) assert.equal(hashState(state), first);
  });

  it('is independent of Map insertion order', () => {
    const state = derive(JOURNAL);
    const reordered = derive(JOURNAL);
    const entries = [...reordered.tasks.entries()].reverse();
    reordered.tasks = new Map(entries);
    reordered.taskOrder = [...reordered.taskOrder];
    assert.notDeepEqual([...state.tasks.keys()], [...reordered.tasks.keys()]);
    assert.equal(hashState(reordered), hashState(state));
  });

  it('is independent of object key order', () => {
    const a = { x: 1, y: { p: 2, q: 3 } };
    const b = { y: { q: 3, p: 2 }, x: 1 };
    assert.equal(JSON.stringify(canonicalise(a)), JSON.stringify(canonicalise(b)));
  });

  it('depends on array order, which is meaningful', () => {
    const state = derive(JOURNAL);
    const swapped = derive(JOURNAL);
    const task = [...swapped.tasks.values()].find((t) => t.attempts.length >= 2);
    assert.ok(task, 'no task with two attempts in the fixture');
    task.attempts.reverse();
    assert.notEqual(hashState(swapped), hashState(state));
  });

  it('changes when any part of the state changes', () => {
    const base = derive(JOURNAL);
    const seen = new Set([hashState(base)]);
    for (const mutate of [
      (s) => { s.concurrency += 1; },
      (s) => { s.status = 'stopped'; },
      (s) => { s.integrationSha = 'x'; },
      (s) => { s.finished = !s.finished; },
      (s) => { s.mergeQueue = [...s.mergeQueue, 'T0']; },
      (s) => { s.tasks.get('T0').phase = 'merged'; },
      (s) => { s.tasks.get('T0').touches = ['src/other/**']; },
    ]) {
      const state = derive(JOURNAL);
      mutate(state);
      const hash = hashState(state);
      assert.equal(seen.has(hash), false, 'collision after a state change');
      seen.add(hash);
    }
  });

  it('produces a fixed-width hex digest', () => {
    assert.match(hashState(derive(JOURNAL)), /^[0-9a-f]{16}$/);
    assert.match(hashState(derive([])), /^[0-9a-f]{16}$/);
  });
});

// ── Canonical form ───────────────────────────────────────────────────────────

describe('canonical form round-trips', () => {
  it('restores a state exactly', () => {
    const state = derive(JOURNAL);
    const restored = stateFromJSON(stateToJSON(state));
    assert.deepEqual(restored, state);
    assert.ok(restored.tasks instanceof Map);
    assert.equal(hashState(restored), hashState(state));
  });

  it('survives JSON serialisation, which is how it reaches disk', () => {
    const state = derive(JOURNAL);
    const restored = stateFromJSON(JSON.parse(JSON.stringify(stateToJSON(state))));
    assert.deepEqual(restored, state);
  });

  it('restores nested Maps and empty collections', () => {
    const value = { m: new Map([['b', 2], ['a', new Map([['z', 1]])]]), e: new Map(), a: [] };
    const restored = decanonicalise(canonicalise(value));
    assert.deepEqual(restored, value);
  });

  it('fills in defaults for a snapshot missing newer fields', () => {
    const state = stateFromJSON({ boardId: 'b' });
    assert.equal(state.boardId, 'b');
    assert.equal(state.status, 'created');
    assert.ok(state.tasks instanceof Map);
    assert.equal(state.tasks.size, 0);
  });

  it('coerces a non-finite number rather than emitting invalid JSON', () => {
    assert.equal(canonicalise(Number.NaN), null);
    assert.equal(canonicalise(Number.POSITIVE_INFINITY), null);
  });
});

// ── Cadence ──────────────────────────────────────────────────────────────────

describe('snapshot cadence', () => {
  it('is due every SNAPSHOT_INTERVAL events', () => {
    assert.equal(SNAPSHOT_INTERVAL, 200);
    assert.equal(shouldSnapshot(200), true);
    assert.equal(shouldSnapshot(400), true);
    assert.equal(shouldSnapshot(199), false);
    assert.equal(shouldSnapshot(0), false);
    assert.equal(shouldSnapshot(-200), false);
    assert.equal(shouldSnapshot(1.5), false);
  });
});

// ── Memoised fold ────────────────────────────────────────────────────────────

describe('the memoised fold matches a full derive', () => {
  it('restoring a snapshot and folding the tail equals loading the journal', () => {
    assert.ok(JOURNAL.length >= 5000, `fixture is only ${JOURNAL.length} events`);
    const through = JOURNAL[JOURNAL.length - 1].seq - SNAPSHOT_INTERVAL;
    const snapshot = snapshotAt(through);

    const lines = JOURNAL.map((e) => JSON.stringify(e));
    const tailLines = JOURNAL.filter((e) => e.seq > through).map((e) => JSON.stringify(e));
    const snapshotText = JSON.stringify(snapshot);

    const fromJournal = derive(lines.map((line) => JSON.parse(line)));
    const fromSnapshot = deriveFrom(
      JSON.parse(snapshotText),
      tailLines.map((line) => JSON.parse(line)),
    );
    assert.deepEqual(fromSnapshot, fromJournal);
  });

  it('is equivalent when the caller passes only the tail', () => {
    const through = JOURNAL[JOURNAL.length - 1].seq - SNAPSHOT_INTERVAL;
    const snapshot = snapshotAt(through);
    const tail = JOURNAL.filter((e) => e.seq > through);

    assert.equal(isSnapshotUsable(snapshot, tail), true, 'tail-only must verify');
    assert.deepEqual(deriveFrom(snapshot, tail), derive(JOURNAL));
  });
});
