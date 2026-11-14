import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_MARKER,
  choosePull,
  formatResultComment,
  parseReviewerVerdict,
  pollPrReview,
  retryPrReview,
} from '../../server/scheduler/pr-review.js';

const PASS = 'Looks fine.\n\n```json\n{"verdict":"pass","summary":"No issues.","findings":[]}\n```';
const FAIL = 'One problem.\n```json\n{"verdict":"pass","summary":"Bad clamp.","findings":[{"severity":"blocking","file":"src/a.js","line":3,"note":"Clamp drops negative speed."}]}\n```';

function pull(number, extra = {}) {
  return { number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, author: 'mira', isDraft: false,
    headSha: `sha${number}`, createdAt: new Date(2026, 10, number).toISOString(), baseRefName: 'main', ...extra };
}

function harness({ pulls = [pull(1)], comments = {}, verdicts = {}, config = {}, rival = false } = {}) {
  const ledger = { version: 1, pulls: [], queue: [] };
  const posted = [];
  const deleted = [];
  const merges = [];
  const reviews = [];
  const activity = [];
  let nextId = 100;
  const store = new Map(Object.entries(comments).map(([n, list]) => [Number(n), [...list]]));
  const job = {
    id: 'job-1', label: 'PR Reviewer',
    preset: { id: 'pr-review', config: { repository: 'o/r', interval: '2m', claim: true, skipCommented: true, skipDrafts: true,
      reviewers: ['correctness', 'tests'], onPass: 'queue', onFail: 'request_changes', guidance: '', ...config } },
  };
  const deps = {
    readLedger: async () => ledger,
    writeLedger: async () => {},
    sleep: async () => {
      if (!rival) return;
      // Another agent claimed the same commit a moment earlier.
      const list = store.get(1) ?? [];
      list.push({ id: 1, body: `Review in progress <!-- ${CLAIM_MARKER}:other-run:sha1 -->`, createdAt: new Date(2026, 0, 1).toISOString() });
      store.set(1, list);
    },
    listPulls: async () => pulls,
    listComments: async (n) => store.get(n) ?? [],
    comment: async (n, body) => {
      const id = nextId++;
      posted.push({ n, body, id });
      const list = store.get(n) ?? [];
      list.push({ id, body, createdAt: new Date(2026, 5, 1, 0, 0, id).toISOString() });
      store.set(n, list);
      return id;
    },
    deleteComment: async (id) => { deleted.push(id); },
    prepareWorktree: async () => ({ workspacePath: '/tmp/wt', baseRef: 'refs/base' }),
    cleanupWorktree: async () => {},
    runReviewer: async ({ role }) => ({ runId: `run-${role}`, status: 'completed', assistantFinal: verdicts[role] ?? PASS }),
    merge: async (n, opts) => { merges.push({ n, ...opts }); },
    review: async (n, event) => { reviews.push({ n, event }); },
    activity: (row) => activity.push(row),
  };
  return { job, deps, ledger, posted, deleted, merges, reviews, activity };
}

describe('PR Reviewer verdicts', () => {
  test('parses the last json block and upgrades blocking findings to fail', () => {
    assert.equal(parseReviewerVerdict(PASS)?.verdict, 'pass');
    const failed = parseReviewerVerdict(FAIL);
    assert.equal(failed?.verdict, 'fail');
    assert.equal(failed?.findings[0].file, 'src/a.js');
    assert.equal(parseReviewerVerdict('no verdict here'), null);
  });

  test('result comment carries a marker and each finding', () => {
    const body = formatResultComment({ pull: pull(7), sha: 'abcdef123', passed: false,
      outcomes: [{ label: 'Correctness', verdict: parseReviewerVerdict(FAIL) }] });
    assert.match(body, /changes requested/);
    assert.match(body, /src\/a\.js:3/);
    assert.match(body, /minnow-pr-review:result:7:abcdef123/);
  });
});

describe('choosing a PR', () => {
  test('oldest first, skipping drafts, commented and claimed PRs', async () => {
    const pulls = [pull(3), pull(1, { isDraft: true }), pull(2)];
    const comments = { 2: [{ id: 1, body: 'LGTM?' }] };
    const { pull: chosen, skipped } = await choosePull({ pulls, ledger: { pulls: [] }, config: { skipDrafts: true, skipCommented: true },
      listComments: async (n) => comments[n] ?? [] });
    assert.equal(chosen.number, 3);
    assert.deepEqual(skipped.map((s) => s.pull.number), [2]);
  });

  test('a reviewed commit is not reviewed again until new commits land', async () => {
    const ledger = { pulls: [{ number: 1, headSha: 'sha1', phase: 'queued' }] };
    const first = await choosePull({ pulls: [pull(1)], ledger, config: {}, listComments: async () => [] });
    assert.equal(first.pull, null);
    const moved = await choosePull({ pulls: [pull(1, { headSha: 'new' })], ledger, config: {}, listComments: async () => [] });
    assert.equal(moved.pull.number, 1);
  });
});

describe('pollPrReview', () => {
  test('claims, reviews in parallel, reports and queues a passing PR', async () => {
    const h = harness();
    const result = await pollPrReview(h.job, 'run-1', h.deps);
    assert.equal(result.changed, true);
    assert.equal(h.posted.length, 2);
    assert.match(h.posted[0].body, /Review in progress/);
    assert.match(h.posted[1].body, /passed/);
    assert.deepEqual(h.merges, [{ n: 1, auto: true }]);
    assert.equal(h.ledger.pulls[0].phase, 'queued');
    assert.deepEqual(h.ledger.pulls[0].reviewers.map((r) => r.role), ['correctness', 'tests']);
  });

  test('backs off and deletes its claim when another agent claimed first', async () => {
    const h = harness({ rival: true });
    const result = await pollPrReview(h.job, 'run-1', h.deps);
    assert.match(result.summary, /claimed by another reviewer/);
    assert.deepEqual(h.deleted, [100]);
    assert.equal(h.merges.length, 0);
    assert.equal(h.ledger.pulls[0].phase, 'skipped');
  });

  test('requests changes when any reviewer finds a blocking issue', async () => {
    const h = harness({ verdicts: { tests: FAIL } });
    await pollPrReview(h.job, 'run-1', h.deps);
    assert.deepEqual(h.reviews, [{ n: 1, event: 'request-changes' }]);
    assert.equal(h.merges.length, 0);
    assert.equal(h.ledger.pulls[0].phase, 'changes_requested');
  });

  test('a reviewer without a verdict blocks the PR and takes no action', async () => {
    const h = harness({ verdicts: { tests: 'I ran out of time.' } });
    const result = await pollPrReview(h.job, 'run-1', h.deps);
    assert.equal(result.blocked, true);
    assert.equal(h.merges.length, 0);
    assert.equal(h.ledger.pulls[0].phase, 'blocked');
    await retryPrReview(h.job, 1, h.deps);
    assert.equal(h.ledger.pulls.length, 0);
  });

  test('without claiming it reviews directly and approve-only never merges', async () => {
    const h = harness({ config: { claim: false, onPass: 'approve' } });
    await pollPrReview(h.job, 'run-1', h.deps);
    assert.equal(h.posted.length, 1);
    assert.deepEqual(h.reviews, [{ n: 1, event: 'approve' }]);
    assert.equal(h.merges.length, 0);
  });

  test('quiet when there is nothing to review', async () => {
    const h = harness({ pulls: [] });
    const result = await pollPrReview(h.job, 'run-1', h.deps);
    assert.equal(result.changed, false);
  });
});
