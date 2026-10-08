import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';
import { runGithubWatch, githubRepositoryFromRemote, PLAN_EXAMPLE } from '../../server/scheduler/github-watch-runtime.js';
import { readWatchLedger } from '../../server/scheduler/github-watch-store.js';
import { retryGithubWatchIssue } from '../../server/scheduler/github-watch.js';
import { createJob, updateJob, deleteJob } from '../../server/scheduler/store.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { runProcess } from '../../server/process-runner.js';
import { parsePlan, isParseErrors } from '../../server/orchestrator/core/parse-plan.js';
import { stateToJSON } from '../../server/orchestrator/core/snapshot.js';
import { integrationBranch } from '../../server/orchestrator/worktree-lifecycle.js';

let scratch;
const oldHome = process.env.MINNOW_HOME;
beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-watch-runtime-'));
  process.env.MINNOW_HOME = path.join(scratch, 'home');
  resetMinnowHomeCache();
});
afterEach(async () => {
  if (oldHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = oldHome;
  resetMinnowHomeCache();
  await fs.rm(scratch, { recursive: true, force: true });
});

const ok = stdout => ({ code: 0, stdout, stderr: '', timedOut: false });
async function setup({ losePrResponse = false } = {}) {
  const cwd = path.join(scratch, 'repo');
  await fs.mkdir(cwd);
  const git = async args => {
    const result = await runProcess('git', args, { cwd });
    assert.equal(result.code, 0, result.stderr);
    return result;
  };
  await git(['init', '-b', 'main']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial']);
  await git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  const job = { id: 'watch', workspacePath: cwd, githubWatch: { repository: 'owner/repo' }, prompt: '', providerId: 'test', modelId: 'model' };
  const calls = [];
  const comments = [];
  let prUrl;
  let state;
  let planningRuns = 0;
  const effects = {
    job, baseUrl: 'http://localhost:9473',
    processRun: async (command, args, options) => {
      assert.equal(command, 'git');
      calls.push(args);
      if (args[0] === 'fetch') {
        const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        await fs.writeFile(path.join(cwd, '.git', 'FETCH_HEAD'), `${head}\n`);
        return ok('');
      }
      if (args[0] === 'push') return ok('');
      return runProcess(command, args, options);
    },
    gh: async args => {
      calls.push(args);
      if (args[0] === 'repo') return ok(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      if (args[0] === 'api' && args.at(-1).includes('/comments?')) return ok(JSON.stringify([comments]));
      if (args[0] === 'api') return ok(JSON.stringify([[{ number: 19, title: 'Fix `quotes` and $values', html_url: 'https://github.com/owner/repo/issues/19' }]]));
      if (args[0] === 'issue' && args[1] === 'view') return ok(JSON.stringify({ number: 19, state: 'OPEN', title: 'Fix', body: 'Fix it', labels: [{ name: 'minnow' }] }));
      if (args[0] === 'issue' && args[1] === 'comment') {
        comments.push({ body: await fs.readFile(args.at(-1), 'utf8') });
        return ok('');
      }
      if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(prUrl ? [{ url: prUrl, baseRefName: 'main' }] : []));
      if (args[0] === 'pr' && args[1] === 'create') {
        assert.match(await fs.readFile(args.at(-1), 'utf8'), /Fixes #19.*Validation/s);
        prUrl = 'https://github.com/owner/repo/pull/20';
        if (losePrResponse) throw new Error('Lost PR response');
        return ok(prUrl);
      }
      assert.fail(`Unexpected gh call: ${JSON.stringify(args)}`);
    },
    runPlanner: async options => {
      planningRuns++;
      assert.equal(options.modeId, 'plan');
      assert.notEqual(options.workspacePath, cwd);
      const planDir = path.join(options.workspacePath, 'documentation', 'plans');
      await fs.mkdir(planDir, { recursive: true });
      await fs.writeFile(path.join(planDir, 'github-issue.md'), PLAN_EXAMPLE);
      return { exitCode: 0, parsedResult: { ok: true, chatId: 'planning-chat' } };
    },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers['X-Minnow-Workspace'], cwd);
      const route = new URL(url).pathname;
      if (route === '/api/boards') {
        const body = JSON.parse(options.body);
        const plan = parsePlan(body.markdown);
        assert.equal(isParseErrors(plan), false, JSON.stringify(plan));
        assert.equal(body.providerId, 'test');
        assert.equal(body.id, 'model');
        state = { boardId: body.boardId, status: 'created', finished: false, tasks: new Map(plan.tasks.map(task => [task.id, { ...task, phase: 'idle' }])) };
        return Response.json({ ok: true, state: stateToJSON(state) });
      }
      if (route.endsWith('/start')) {
        await git(['branch', integrationBranch(state.boardId), 'HEAD']);
        state.status = 'running';
        return Response.json({ ok: true });
      }
      if (route.endsWith('/report')) return Response.json({ ok: true, markdown: 'Implementation details.\n\nValidation passed.' });
      return Response.json({ ok: true, state: stateToJSON(state) });
    },
  };
  return { effects, calls, comments, git, job, planningRuns: () => planningRuns, finish: () => {
    state.finished = true;
    state.status = 'stopped';
    state.finalTest = { outcome: 'pass' };
    for (const task of state.tasks.values()) task.phase = 'merged';
  } };
}

test('supports GitHub HTTPS/SSH remotes and rejects lookalike hosts', () => {
  for (const url of ['https://github.com/Owner/Repo.git', 'git@github.com:Owner/Repo.git', 'ssh://git@github.com/Owner/Repo.git']) {
    assert.equal(githubRepositoryFromRemote(url), 'owner/repo');
  }
  for (const url of ['https://github.com.evil/owner/repo', 'https://evil/owner/repo', '/local/repo']) assert.equal(githubRepositoryFromRemote(url), null);
});

test('production effects isolate planning and carry its plan through board APIs to a PR', async () => {
  const h = await setup();
  await runGithubWatch(h.effects);
  h.finish();
  await runGithubWatch(h.effects);
  await runGithubWatch(h.effects);
  const row = (await readWatchLedger('owner/repo')).issues[0];
  assert.equal(row.phase, 'complete');
  assert.equal(row.chatId, 'planning-chat');
  assert.equal(h.planningRuns(), 1);
  assert.equal(h.calls.filter(args => args[0] === 'push').length, 1);
  assert.equal(h.calls.filter(args => args[0] === 'pr' && args[1] === 'create').length, 1);
  assert.equal(h.comments.length, 3);
  assert.match(h.comments.at(-1).body, /pull\/20.*Implementation details/s);
  assert.equal((await h.git(['status', '--porcelain', '--untracked-files=no'])).stdout.trim(), '');
  assert.equal((await h.git(['branch', '--show-current'])).stdout.trim(), 'main');
});

test('lost PR response retries by discovering the existing PR, without pushing or creating twice', async () => {
  const h = await setup({ losePrResponse: true });
  await runGithubWatch(h.effects);
  h.finish();
  assert.equal((await runGithubWatch(h.effects)).blocked, true);
  await retryGithubWatchIssue(h.job, 19);
  await runGithubWatch(h.effects);
  assert.equal((await readWatchLedger('owner/repo')).issues[0].phase, 'complete');
  assert.equal(h.calls.filter(args => args[0] === 'pr' && args[1] === 'create').length, 1);
  assert.equal(h.calls.filter(args => args[0] === 'push').length, 1);
});

test('mismatched push URL prevents planning or GitHub writes', async () => {
  const h = await setup();
  await h.git(['remote', 'set-url', '--push', 'origin', 'https://github.com/other/repo.git']);
  await assert.rejects(runGithubWatch(h.effects), /must match/);
  assert.equal(h.planningRuns(), 0);
  assert.equal(h.comments.length, 0);
});

test('watcher config persists through edits and cannot silently switch repositories', async () => {
  const job = await createJob({ label: 'Watcher', workspacePath: scratch, schedule: { kind: 'interval', value: '5m' }, githubWatch: { repository: 'Owner/Repo' } });
  assert.equal(job.githubWatch.repository, 'owner/repo');
  assert.ok(job.prompt);
  const edited = await updateJob(job.id, { enabled: false, githubWatch: { repository: 'owner/repo', issues: [{ number: 1 }] } });
  assert.deepEqual(edited.githubWatch, { repository: 'owner/repo', label: 'minnow' });
  await assert.rejects(updateJob(job.id, { githubWatch: null }), /new watcher/);
  await assert.rejects(updateJob(job.id, { workspacePath: '/other' }), /new watcher/);
  await deleteJob(job.id);
});
