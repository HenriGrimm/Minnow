import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { pollGithubWatch, boardReadyForPullRequest, retryGithubWatchIssue } from '../../server/scheduler/github-watch.js';
import { readWatchLedger, writeWatchLedger, withWatchLock } from '../../server/scheduler/github-watch-store.js';
import { normalizeGithubWatch } from '../../server/scheduler/github-watch-config.js';

let home;
const previousHome = process.env.MINNOW_HOME;
before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-watch-test-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
});
after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true });
});

const job = { id: 'job-1', workspacePath: '/repo', githubWatch: { repository: 'owner/repo' } };
const ready = () => ({ finished: true, finalTest: { outcome: 'pass' }, tasks: new Map([['A', { phase: 'merged' }]]) });
function harness() {
  let ledger = { version: 1, issues: [] };
  const calls = [];
  const deps = {
    readLedger: async () => structuredClone(ledger),
    writeLedger: async (_, value) => { ledger = structuredClone(value); calls.push('save'); },
    listIssues: async () => [{ number: 3, title: 'Fix bug', url: 'https://github.com/owner/repo/issues/3' }],
    getIssue: async () => ({ state: 'OPEN', labels: [{ name: 'minnow' }] }),
    prepare: async () => { calls.push('prepare'); },
    plan: async () => { calls.push('plan'); },
    comment: async (_, update) => { calls.push(`comment:${update.stage}`); },
    createBoard: async () => { calls.push('create'); },
    startBoard: async () => { calls.push('start'); },
    stopBoard: async () => { calls.push('stop'); },
    resumeBoard: async () => { calls.push('resume'); },
    boardState: async () => ready(),
    publish: async () => { calls.push('publish'); return 'https://github.com/owner/repo/pull/4'; },
  };
  return { deps, calls, ledger: () => ledger };
}

test('validates watcher repository and requires explicit workspace', () => {
  assert.deepEqual(normalizeGithubWatch({ repository: 'Owner/Repo' }, '/repo'), { repository: 'owner/repo', label: 'minnow' });
  for (const repository of ['--help', '../repo', 'a/b/c', 'https://github.com/a/b', 'a/..']) {
    assert.throws(() => normalizeGithubWatch({ repository }, '/repo'));
  }
  assert.throws(() => normalizeGithubWatch({ repository: 'a/b' }), /workspace/);
});

test('claims before effects, runs a board, publishes once, then stays quiet', async () => {
  const h = harness();
  const first = await pollGithubWatch(job, h.deps);
  assert.equal(h.calls[0], 'save');
  assert.equal(h.ledger().issues[0].phase, 'board');
  assert.equal(first.changed, true);
  await pollGithubWatch(job, h.deps);
  assert.equal(h.ledger().issues[0].phase, 'complete');
  const third = await pollGithubWatch(job, h.deps);
  assert.equal(third.changed, false);
  assert.equal(h.calls.filter(call => call === 'plan').length, 1);
  assert.equal(h.calls.filter(call => call === 'publish').length, 1);
  assert.ok(h.calls.includes('comment:complete'));
});

test('no matching issues never invokes a model or writes GitHub', async () => {
  const h = harness();
  h.deps.listIssues = async () => [];
  assert.equal((await pollGithubWatch(job, h.deps)).changed, false);
  assert.deepEqual(h.calls, []);
});

test('partial success, skipped tasks, and failed final tests cannot publish', () => {
  assert.equal(boardReadyForPullRequest(ready()), true);
  for (const phase of ['skipped', 'abandoned', 'testing', 'idle']) {
    const state = ready();
    state.tasks.set('B', { phase });
    assert.equal(boardReadyForPullRequest(state), false);
  }
  assert.equal(boardReadyForPullRequest({ ...ready(), finalTest: { outcome: 'fail' } }), false);
  assert.equal(boardReadyForPullRequest({ ...ready(), tasks: new Map() }), false);
});

test('failed board records actionable local failure and generic GitHub update', async () => {
  const h = harness();
  await pollGithubWatch(job, h.deps);
  h.deps.boardState = async () => ({ ...ready(), finalTest: { outcome: 'fail' } });
  const result = await pollGithubWatch(job, h.deps);
  assert.equal(result.blocked, true);
  assert.match(h.ledger().issues[0].error, /attention/);
  assert.equal(h.calls.includes('publish'), false);
  assert.ok(h.calls.includes('comment:blocked'));
});

test('removing the label stops an active board', async () => {
  const h = harness();
  await pollGithubWatch(job, h.deps);
  h.deps.getIssue = async () => ({ state: 'OPEN', labels: [] });
  await pollGithubWatch(job, h.deps);
  assert.ok(h.calls.includes('stop'));
  assert.equal(h.calls.includes('publish'), false);
});

test('unfinished running board is resumed without another plan or creation', async () => {
  const h = harness();
  await pollGithubWatch(job, h.deps);
  h.deps.boardState = async () => ({ ...ready(), finished: false, status: 'running' });
  await pollGithubWatch(job, h.deps);
  assert.ok(h.calls.includes('resume'));
  assert.equal(h.calls.filter(call => call === 'create').length, 1);
});

test('temporary API failures retain the running board slot and clear on recovery', async () => {
  const h = harness();
  await pollGithubWatch(job, h.deps);
  h.deps.boardState = async () => { throw new Error('offline'); };
  const failed = await pollGithubWatch(job, h.deps);
  assert.equal(failed.blocked, true);
  assert.equal(h.ledger().issues[0].phase, 'board');
  h.deps.boardState = async () => ready();
  await pollGithubWatch(job, h.deps);
  assert.equal(h.ledger().issues[0].phase, 'complete');
  assert.equal(h.ledger().issues[0].error, undefined);
  assert.equal(h.calls.filter(call => call === 'create').length, 1);
});

test('failed cancellation stays pollable until the board confirms it stopped', async () => {
  const h = harness();
  await pollGithubWatch(job, h.deps);
  h.deps.getIssue = async () => ({ state: 'CLOSED', labels: [] });
  h.deps.stopBoard = async () => { throw new Error('offline'); };
  await pollGithubWatch(job, h.deps);
  assert.equal(h.ledger().issues[0].phase, 'board');
  h.deps.stopBoard = async () => {};
  await pollGithubWatch(job, h.deps);
  assert.equal(h.ledger().issues[0].phase, 'blocked');
});

test('interrupted planning is held for review instead of silently rerun', async () => {
  const h = harness();
  h.ledger().issues.push({ jobId: job.id, number: 3, boardId: 'persisted', phase: 'planning' });
  await pollGithubWatch(job, h.deps);
  assert.equal(h.ledger().issues[0].phase, 'blocked');
  assert.match(h.ledger().issues[0].error, /interrupted/);
  assert.equal(h.calls.includes('plan'), false);
});

test('comment delivery failure survives completed publication without making another PR', async () => {
  const h = harness();
  await pollGithubWatch(job, h.deps);
  h.deps.comment = async (_, update) => { if (update.stage === 'complete') throw new Error('offline'); };
  await assert.rejects(pollGithubWatch(job, h.deps), /offline/);
  assert.equal(h.ledger().issues[0].phase, 'complete');
  assert.equal(h.ledger().issues[0].pendingComment.stage, 'complete');
  h.deps.comment = async () => {};
  await pollGithubWatch(job, h.deps);
  assert.equal(h.ledger().issues[0].pendingComment, undefined);
  assert.equal(h.calls.filter(call => call === 'publish').length, 1);
});

test('repository admission prevents overlapping polls', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let admitted;
  const entered = new Promise(resolve => { admitted = resolve; });
  const first = withWatchLock('owner/parallel', async () => { admitted(); await held; });
  await entered;
  assert.equal((await withWatchLock('OWNER/PARALLEL', () => assert.fail())).changed, false);
  release();
  await first;
});

test('retry preserves board identity and terminal deduplication persists on disk', async () => {
  const retryJob = { ...job, githubWatch: { repository: 'owner/retry' } };
  await writeWatchLedger('owner/retry', { version: 1, issues: [
    { jobId: job.id, number: 7, phase: 'blocked', failedPhase: 'publishing', boardId: 'original', error: 'offline' },
    { jobId: job.id, number: 8, phase: 'complete' },
  ] });
  await retryGithubWatchIssue(retryJob, 7);
  const ledger = await readWatchLedger('owner/retry');
  assert.equal(ledger.issues[0].phase, 'publishing');
  assert.equal(ledger.issues[0].boardId, 'original');
  assert.equal(ledger.issues[0].error, undefined);
  await assert.rejects(retryGithubWatchIssue(retryJob, 8), /blocked/);
});
