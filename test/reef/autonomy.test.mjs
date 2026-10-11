import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reef-autonomy-')));
process.env.MINNOW_HOME = home;
const { createApp, appRoot } = await import('../../server/reef/store.js');
const { buildApp, needsUser, retryDelay, MAX_RETRIES, MAX_REPAIRS, MAX_CONTINUATIONS } = await import('../../server/reef/pipeline.js');
after(async () => { await fs.rm(home, { recursive: true, force: true }); });

async function writeApp(workspace) {
  await fs.writeFile(path.join(workspace, 'src/main.ts'), 'export const ready = true;');
  await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'test/core.test.mjs'), "import test from 'node:test'; test('ready', () => {});");
}

/** Drive the real pipeline with a scripted agent and host commands; waits resolve at once. */
async function harness({ agent, execute = async () => '', stallMs, run: runPatch = {} }) {
  const app = await createApp({ prompt: 'A self-healing timer', modelId: 'fixture' });
  const run = { id: crypto.randomUUID(), prompt: 'A self-healing timer', state: 'queued', progress: 0, log: '', attempt: 0, chatIds: [], ...runPatch };
  const delays = [], retries = [], phases = [], prompts = [];
  let logText = '';
  const controller = new AbortController();
  const input = {
    app, run, baseUrl: 'http://unused', signal: controller.signal,
    stage: async phase => { phases.push(phase); },
    log: text => { logText += text; },
    retrying: async retry => { retries.push(retry); },
    wait: async ms => { delays.push(ms); },
    stallMs,
    toolchain: async () => ({ node: process.execPath, npm: 'fixture-npm' }),
    browserTools: async () => ({ entry: 'fixture-browser', env: {} }),
    runtimeHost: async () => ({ url: 'http://unused', stop: async () => {} }),
    agent: async options => { prompts.push(options.prompt); return agent(options); },
    execute: async (bin, args, options) => {
      options.signal.throwIfAborted();
      const result = await execute(args, options);
      if (args.includes('install')) await fs.writeFile(path.join(options.cwd, 'package-lock.json'), '{"packages":{}}');
      if (args.includes('build')) {
        await fs.mkdir(path.join(options.cwd, 'dist'), { recursive: true });
        await fs.writeFile(path.join(options.cwd, 'dist/index.html'), '<h1>Ready</h1>');
      }
      return args.includes('--test') ? '# tests 1' : result;
    },
  };
  const checkpoint = async () => JSON.parse(await fs.readFile(path.join(appRoot(app.id), 'runs', run.id, 'checkpoint.json'), 'utf8'));
  return { app, run, input, controller, delays, retries, phases, prompts, checkpoint, log: () => logText };
}

test('provider failures in planning and building retry with backoff and continue from saved files', async () => {
  let plans = 0, builds = 0;
  const h = await harness({ agent: async ({ phase, workspace }) => {
    if (phase === 'plan') {
      if (++plans === 1) throw new Error('RetriableError: [resource_exhausted] Error');
      return { text: 'Plan.' };
    }
    builds++;
    if (builds === 1) { await fs.writeFile(path.join(workspace, 'partial.txt'), 'kept'); throw new Error('Agent CLI exited with code 3221225477 without a completion event.'); }
    if (builds === 2) throw new Error('CLI process limit reached; finish or stop a pending chat.');
    assert.equal(await fs.readFile(path.join(workspace, 'partial.txt'), 'utf8'), 'kept');
    await writeApp(workspace);
    return { text: 'Done.' };
  } });
  const release = await buildApp(h.input);
  assert.equal(release.id, h.run.id);
  // A phase advance refills the retry budget, so the builder's first retry waits the shortest time again.
  assert.deepEqual(h.delays, [retryDelay(1), retryDelay(1), retryDelay(2)]);
  assert.deepEqual(h.retries.map(retry => retry.reason), ['The model provider is busy.', 'The agent stopped unexpectedly.', 'The model provider is busy.']);
  assert.ok(h.retries.every(retry => retry.max === MAX_RETRIES && retry.at > Date.now() - 60000));
  const builderPrompts = h.prompts.filter(prompt => prompt.includes('You are the Builder'));
  assert.doesNotMatch(builderPrompts[0], /Inspect the existing files first/);
  assert.ok(builderPrompts.slice(1).every(prompt => /Inspect the existing files first/.test(prompt)), 'retries continue in a fresh context');
  assert.match(h.log(), /Retrying automatically in 15s \(1\/8\)/);
});

test('backoff doubles to a five-minute ceiling', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(retryDelay), [15000, 30000, 60000, 120000, 240000, 300000, 300000]);
});

test('errors only the user can clear stop at once with a plain reason', async () => {
  for (const [message, reason] of [
    ['Upstream HTTP 402: Insufficient Balance (request_id: 1)', /out of credit/],
    ['You exceeded your current quota, please check your plan', /out of credit/],
    ['Upstream HTTP 401: invalid api key', /sign-in/],
    ['No model configured. Set --model or configure a work agent / active provider model.', /model is unavailable/],
  ]) {
    const h = await harness({ agent: async () => { throw new Error(message); } });
    await assert.rejects(buildApp(h.input), error => reason.test(error.stopReason) && error.message === message);
    assert.deepEqual(h.delays, [], message);
  }
  assert.equal(needsUser(new Error('RetriableError: [resource_exhausted] Error')), '');
  assert.equal(needsUser(new Error('Upstream HTTP 429: rate limit')), '', 'backpressure is not a spent allowance');
});

test('retries are bounded, and the budget survives an automatic resume', async () => {
  const h = await harness({ agent: async ({ phase }) => { if (phase === 'plan') throw new Error('fetch failed'); } });
  h.input.wait = async ms => { h.delays.push(ms); if (h.delays.length === 3) h.controller.abort(Object.assign(new Error('Minnow stopped'), { interrupted: true })); };
  await assert.rejects(buildApp(h.input), /Minnow stopped/);
  assert.equal((await h.checkpoint()).retries, 3);
  // The restarted host resumes the same run with a fresh signal and the saved budget.
  const controller = new AbortController(), delays = [];
  await assert.rejects(buildApp({ ...h.input, run: { ...h.run, recovery: 'resume' }, signal: controller.signal, wait: async ms => { delays.push(ms); } }),
    error => /kept happening after 8 automatic retries/.test(error.stopReason) && /network dropped out/.test(error.stopReason));
  assert.equal(delays.length, MAX_RETRIES - 3);
});

test('context exhaustion keeps continuing, then lets verification direct the rest', async () => {
  let builds = 0;
  const h = await harness({ agent: async ({ phase, workspace, prompt }) => {
    if (phase === 'plan') return { text: 'Plan.' };
    builds++;
    if (prompt.includes('Repair these verification failures')) { await writeApp(workspace); return { text: 'Fixed.' }; }
    await fs.writeFile(path.join(workspace, `part-${builds}.txt`), 'saved');
    throw new Error('context budget exceeded');
  } });
  await buildApp(h.input);
  assert.equal(builds, MAX_CONTINUATIONS + 2, 'every continuation, then one repair after verification');
  assert.deepEqual(h.delays, [], 'a continuation needs no backoff');
  assert.match(h.log(), new RegExp(`Builder context exhausted ${MAX_CONTINUATIONS} times`));
  assert.match(h.prompts.at(-1), /Repair these verification failures:\n.*test/);
});

test('verification failures repair up to the budget; network trouble never spends a repair', async () => {
  let checks = 0, installs = 0;
  const h = await harness({
    agent: async ({ phase, workspace }) => { if (phase === 'plan') return { text: 'Plan.' }; await writeApp(workspace); return { text: 'Done.' }; },
    execute: async args => {
      if (args.includes('ci') && ++installs === 1) throw new Error('Command failed (1): npm error network request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND');
      if (args.includes('--noEmit')) { checks++; throw new Error(`Command failed (2): src/main.ts(1,1): error TS2322 (${checks})`); }
      return '';
    },
  });
  await assert.rejects(buildApp(h.input), error => error.stopReason === `Your app still failed its checks after ${MAX_REPAIRS} automatic fixes.`);
  assert.equal(checks, MAX_REPAIRS + 1);
  assert.equal(h.delays.length, 1, 'the dropped registry connection was retried, not repaired');
  assert.equal(h.phases.filter(phase => phase === 'repairing').length, MAX_REPAIRS);
  assert.equal((await h.checkpoint()).attempt, MAX_REPAIRS, 'the repair count is durable');
});

test('a silent agent is stopped by the stall watchdog and retried', async () => {
  let builds = 0;
  const h = await harness({ stallMs: 1000, agent: async ({ phase, workspace, signal, log }) => {
    if (phase === 'plan') return { text: 'Plan.' };
    if (++builds === 1) {
      // Output keeps the watchdog quiet for longer than its window; only silence trips it.
      for (let tick = 0; tick < 6; tick++) { log('working\n'); await new Promise(resolve => setTimeout(resolve, 300)); }
      assert.equal(signal.aborted, false);
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    await writeApp(workspace);
    return { text: 'Done.' };
  } });
  await buildApp(h.input);
  assert.equal(builds, 2);
  assert.ok(h.retries.some(retry => retry.reason === 'The agent went quiet.'));
  assert.match(h.log(), /No build activity for/);
});

test('cancellation is never retried', async () => {
  const h = await harness({ agent: async () => { h.controller.abort(new Error('Build cancelled')); throw new Error('Command failed (1): process killed'); } });
  await assert.rejects(buildApp(h.input), /process killed/);
  assert.deepEqual(h.delays, []);
});
