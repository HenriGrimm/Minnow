import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPrReview } from '../../server/scheduler/pr-review-runtime.js';
import { retryPrReview } from '../../server/scheduler/pr-review.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { runProcess } from '../../server/process-runner.js';

test('PR review copies local dotenv before checks and retains unsafe setup for a successful retry', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-pr-env-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = path.join(scratch, 'home'); resetMinnowHomeCache();
  const cwd = path.join(scratch, 'repo');
  const git = async args => {
    const result = await runProcess('git', args, { cwd });
    assert.equal(result.code, 0, result.stderr);
    return result;
  };
  try {
    await fs.mkdir(cwd);
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@example.invalid']);
    await fs.writeFile(path.join(cwd, '.gitignore'), '.env\n.worktrees/\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'fixture']);
    await git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const job = { id: 'review', label: 'Review', workspacePath: cwd, preset: { config: {
      repository: 'owner/repo', claim: false, reviewers: [], onPass: 'comment', onFail: 'comment',
    } } };
    const ok = stdout => ({ code: 0, stdout, stderr: '', timedOut: false });
    let reviews = 0;
    let stopOnCheckout = false;
    let cancelled = false;
    const input = {
      job, runId: 'environment-review',
      isCancelled: () => cancelled,
      processRun: async (command, args, options) => {
        if (args[0] === 'fetch') {
          await git(['update-ref', 'refs/minnow/pr-review/1', head]);
          await git(['update-ref', 'refs/minnow/pr-review/base-1', head]);
          return ok('');
        }
        const result = await runProcess(command, args, options);
        if (stopOnCheckout && args[0] === '-C' && args[2] === 'checkout') cancelled = true;
        return result;
      },
      gh: async args => {
        if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify([{
          number: 1, title: 'Fixture', url: 'https://github.com/owner/repo/pull/1',
          headRefOid: head, baseRefName: 'main', headRefName: 'feature', author: { login: 'fixture' },
          createdAt: '2026-01-01T00:00:00Z',
        }]));
        if (args[0] === 'api' && args.includes('POST')) return ok('{"id":1}');
        if (args[0] === 'api') return ok('[[]]');
        assert.fail('Unexpected GitHub effect in runtime fixture');
      },
      runReviewer: async ({ workspacePath }) => {
        reviews++;
        assert.notEqual(workspacePath, cwd);
        assert.equal(await fs.readFile(path.join(workspacePath, '.env'), 'utf8'), 'FIXTURE=review\n');
        return { runId: 'review-result', status: 'completed',
          assistantFinal: '{"verdict":"pass","summary":"Fixture checked","findings":[]}' };
      },
    };
    await fs.writeFile(path.join(cwd, '.env'), Buffer.alloc(1024 * 1024 + 1, 65));
    const failure = await runPrReview(input);
    assert.equal(failure.blocked, true);
    assert.match(failure.summary, /1 MiB/);
    assert.equal(reviews, 0);
    await fs.access(path.join(cwd, '.worktrees/pr-review-1/.git'));

    // If Stop arrives during preparation, even a late environment rejection
    // must release the worktree rather than retain it for diagnosis.
    await retryPrReview(job, 1);
    stopOnCheckout = true;
    const stopped = await runPrReview({ ...input, runId: 'environment-stop' });
    assert.match(stopped.summary, /Stopped/);
    assert.equal(reviews, 0);
    await assert.rejects(fs.access(path.join(cwd, '.worktrees/pr-review-1')), { code: 'ENOENT' });

    stopOnCheckout = false;
    cancelled = false;
    await fs.writeFile(path.join(cwd, '.env'), 'FIXTURE=review\n');
    await retryPrReview(job, 1);
    const retried = await runPrReview({ ...input, runId: 'environment-retry' });
    assert.equal(retried.blocked, undefined, JSON.stringify(retried));
    assert.match(retried.summary, /passed review/);
    assert.equal(reviews, 1);
    assert.equal(await fs.readFile(path.join(cwd, '.env'), 'utf8'), 'FIXTURE=review\n');
  } finally {
    if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

