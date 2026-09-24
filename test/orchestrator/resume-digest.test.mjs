/**
 * Resume digest — what a `continue` seed learns about the attempt it picks up.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { boardReapVanished } from '../../server/orchestrator/board-graph.js';
import { formatResumeDigest, resumeChain } from '../../server/orchestrator/resume-digest.js';

const call = (id, name, args) => ({ type: 'tool_call', id, name, arguments: JSON.stringify(args) });
const result = (id, name, content) => ({ type: 'tool_result', id, name, content });

function boardWith(...tail) {
  const events = [
    makeEvent('board.created', {
      boardId: 'b',
      planPath: 'p.md',
      tasks: [{ id: 'A', title: 'A', wave: 1, dependsOn: [], touches: [], build: 'b', test: 't', accept: 'a' }],
      waves: [],
    }),
    makeEvent('board.started', { concurrency: 1 }),
    ...tail,
  ];
  return derive(events.map((e, i) => ({ ...e, seq: i + 1, ts: i + 1 })));
}

const run = (attemptId, role, outcome, extra = {}) => [
  makeEvent('task.attempt.started', { taskId: 'A', attemptId, role }),
  makeEvent('task.attempt.ended', { taskId: 'A', attemptId, role, outcome, ...extra }),
];

describe('formatResumeDigest', () => {
  it('lists edited files across the chain, the latest actions, and the last notes', () => {
    const digest = formatResumeDigest([
      {
        attemptId: 'a1',
        outcome: 'crashed',
        events: [
          call('1', 'save_file', { path: 'src/a.ts', content: 'x' }),
          result('1', 'save_file', 'Saved src/a.ts'),
        ],
      },
      {
        attemptId: 'a2',
        outcome: 'timeout',
        events: [
          call('2', 'replace_text_in_file', { path: 'src/b.ts', search: 'a', replace: 'b' }),
          result('2', 'replace_text_in_file', 'Replaced 1 occurrence'),
          call('3', 'execute_command', { command: 'npm test' }),
          result('3', 'execute_command', 'npm test (exit 1)\n\nstdout:\n1 passing\n1 failing'),
          call('4', 'report_outcome', { outcome: 'pass' }),
          result('4', 'report_outcome', 'rejected'),
          { type: 'round_end', text: '', reasoning: 'Next: fix the failing parser test.' },
        ],
      },
    ]);
    assert.match(digest, /Files it changed[\s\S]*- src\/a\.ts\n- src\/b\.ts/);
    assert.match(digest, /execute_command `npm test` → exit 1: 1 failing/);
    assert.equal(digest.includes('save_file'), false, 'actions come from the latest attempt only');
    assert.equal(digest.includes('report_outcome'), false);
    assert.match(digest, /Next: fix the failing parser test\./);
    assert.match(digest, /git status/);
  });

  it('prefers the attempt’s own compaction summary and stays bounded', () => {
    const events = [{ type: 'context_compaction', summary: 'Built the router; tests left.' }];
    for (let i = 0; i < 200; i += 1) {
      events.push(call(`c${i}`, 'read_file', { path: `src/file-${i}.ts` }));
      events.push(result(`c${i}`, 'read_file', `1: ${'x'.repeat(500)}`));
    }
    const digest = formatResumeDigest([{ attemptId: 'a1', outcome: 'crashed', events }]);
    assert.match(digest, /Built the router; tests left\./);
    assert.match(digest, /175 earlier omitted/);
    assert.ok(digest.length <= 8000);
  });

  it('is empty when the attempt did nothing', () => {
    assert.equal(formatResumeDigest([{ attemptId: 'a1', outcome: 'crashed', events: [] }]), '');
  });
});

describe('resumeChain', () => {
  it('takes the trailing run of interrupted builder attempts, oldest first', () => {
    const state = boardWith(
      ...run('b1', 'builder', 'pass'),
      ...run('t1', 'tester', 'fail'),
      ...run('b2', 'builder', 'crashed'),
      ...run('b3', 'builder', 'timeout'),
    );
    assert.deepEqual(resumeChain(state.tasks.get('A')).map((a) => a.attemptId), ['b2', 'b3']);

    const reported = boardWith(...run('b1', 'builder', 'fail'));
    assert.deepEqual(resumeChain(reported.tasks.get('A')), []);
  });
});

describe('boardReapVanished', () => {
  it('marks attempts that vanished under a restart as interruptions', () => {
    const state = boardWith(makeEvent('task.attempt.started', { taskId: 'A', attemptId: 'b1', role: 'builder' }));
    const [event] = boardReapVanished(state, new Set(), new Set());
    assert.equal(event.outcome, 'crashed');
    assert.deepEqual(event.evidence, { interrupted: true });
  });
});
