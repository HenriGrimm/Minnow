import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reef-recovery-')));
process.env.MINNOW_HOME = home;
const { createApp, readApp, updateApp, appRoot } = await import('../../server/reef/store.js');
const { ReefSupervisor } = await import('../../server/reef/supervisor.js');
const { buildApp } = await import('../../server/reef/pipeline.js');
after(async () => { await fs.rm(home, { recursive: true, force: true }); });

async function until(check) {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for recovery');
}

async function fixture(stopPhase) {
  const app = await createApp({ prompt: 'A saved timer', modelId: 'fixture' });
  const phases = [], agents = [];
  let stop = true;
  let expectPartial = true;
  const supervisor = new ReefSupervisor({ build: input => buildApp({
    ...input,
    stage: async (...args) => { phases.push(args[0]); await input.stage(...args); },
    toolchain: async () => ({ node: process.execPath, npm: 'fixture-npm' }),
    browserTools: async () => ({ entry: 'fixture-browser', env: {} }),
    runtimeHost: async () => ({ url: 'http://unused', stop: async () => {} }),
    agent: async ({ phase, workspace, prompt }) => {
      agents.push(phase);
      if (phase === 'plan') return { text: 'Plan saved once.' };
      if (stopPhase === 'building' && stop) {
        await fs.writeFile(path.join(workspace, 'partial.txt'), 'Completed work');
        stop = false;
        throw new Error('Provider disconnected');
      }
      if (stopPhase === 'building') {
        assert.match(prompt, /Continue from the saved work/);
        if (expectPartial) assert.equal(await fs.readFile(path.join(workspace, 'partial.txt'), 'utf8'), 'Completed work');
        else await assert.rejects(fs.access(path.join(workspace, 'partial.txt')), { code: 'ENOENT' });
      }
      await fs.writeFile(path.join(workspace, 'src/main.ts'), 'export const ready = true;');
      await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
      await fs.writeFile(path.join(workspace, 'test/core.test.mjs'), "import test from 'node:test'; test('ready', () => {});");
      return { text: 'Finished.' };
    },
    execute: async (bin, args, options) => {
      options.signal.throwIfAborted();
      if (stop && phases.at(-1) === stopPhase) {
        stop = false;
        await fs.writeFile(path.join(options.cwd, 'during-phase.txt'), 'Incomplete phase output');
        supervisor.active.controller.abort(new Error('Build cancelled'));
        options.signal.throwIfAborted();
      }
      if (args.includes('install')) await fs.writeFile(path.join(options.cwd, 'package-lock.json'), '{"packages":{}}');
      if (args.includes('build')) {
        await fs.mkdir(path.join(options.cwd, 'dist'), { recursive: true });
        await fs.writeFile(path.join(options.cwd, 'dist/index.html'), '<h1>Ready</h1>');
      }
      return args.includes('--test') ? '# tests 1' : '';
    },
  }) });
  await supervisor.start('http://unused');
  const run = await supervisor.enqueue(app.id, app.description);
  await until(async () => ['failed', 'cancelled'].includes((await readApp(app.id)).status) && !supervisor.active);
  return { app, run, supervisor, phases, agents, expectReset: () => { expectPartial = false; }, workspace: path.join(appRoot(app.id), 'worktrees', run.id) };
}

test('retry continues partial implementation in the same worktree without repeating the plan', async () => {
  const { app, run, supervisor, agents, phases, workspace } = await fixture('building');
  try {
    const before = await readApp(app.id);
    assert.equal(before.runs[0].failedStage, 'building');
    const resumed = await supervisor.recover(app.id, run.id);
    assert.equal(resumed.id, run.id);
    await assert.rejects(supervisor.recover(app.id, run.id), /stopped build/);
    await until(async () => { const current = await readApp(app.id); if (current.status === 'failed') throw new Error(current.runs[0].error); return current.status === 'ready'; });
    assert.deepEqual(agents, ['plan', 'build', 'build']);
    assert.equal(phases.filter(phase => phase === 'scaffolding').length, 1);
    assert.equal((await readApp(app.id)).runs.length, 1);
    assert.ok((await readApp(app.id)).runs[0].log.startsWith(before.runs[0].log));
    assert.equal(await fs.readFile(path.join(workspace, 'partial.txt'), 'utf8'), 'Completed work');
  } finally { supervisor.stop(); }
});

test('reset building discards only partial implementation and retains the completed plan', async () => {
  const { app, run, supervisor, agents, expectReset, workspace } = await fixture('building');
  try {
    expectReset();
    await supervisor.recover(app.id, run.id, 'reset-phase');
    await until(async () => (await readApp(app.id)).status === 'ready');
    assert.deepEqual(agents, ['plan', 'build', 'build']);
    await assert.rejects(fs.access(path.join(workspace, 'partial.txt')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(appRoot(app.id), 'runs', run.id, 'plan.txt'), 'utf8'), 'Plan saved once.');
  } finally { supervisor.stop(); }
});

test('legacy cancelled builds resume from retained source and plan without a checkpoint or failedStage', async () => {
  const { app, run, supervisor, agents } = await fixture('building');
  try {
    await fs.rm(path.join(appRoot(app.id), 'runs', run.id, 'checkpoint.json'));
    await updateApp(app.id, current => { current.runs[0].state = 'cancelled'; delete current.runs[0].failedStage; });
    await supervisor.recover(app.id, run.id);
    await until(async () => (await readApp(app.id)).status === 'ready');
    assert.deepEqual(agents, ['plan', 'build', 'build']);
  } finally { supervisor.stop(); }
});

test('legacy phase reset reports missing checkpoints without losing the partial work', async () => {
  const { app, run, supervisor, workspace } = await fixture('building');
  try {
    await fs.rm(path.join(appRoot(app.id), 'runs', run.id, 'checkpoint.json'));
    await supervisor.recover(app.id, run.id, 'reset-phase');
    await until(async () => (await readApp(app.id)).status === 'failed' && !supervisor.active);
    assert.match((await readApp(app.id)).runs[0].error, /no phase checkpoint/);
    assert.equal(await fs.readFile(path.join(workspace, 'partial.txt'), 'utf8'), 'Completed work');
  } finally { supervisor.stop(); }
});

for (const phase of ['installing', 'checking', 'promoting']) {
  for (const action of ['resume', 'reset-phase']) {
    test(`${action} at ${phase} skips completed agents and ${action === 'resume' ? 'keeps' : 'discards'} phase output`, async () => {
      const { app, run, supervisor, agents, phases, workspace } = await fixture(phase);
      try {
        assert.equal((await readApp(app.id)).runs[0].failedStage, phase);
        const priorCount = phases.length;
        await supervisor.recover(app.id, run.id, action);
        await until(async () => (await readApp(app.id)).status === 'ready');
        assert.equal(phases[priorCount], phase);
        assert.deepEqual(agents, ['plan', 'build']);
        if (phase !== 'promoting') {
          if (action === 'resume') assert.equal(await fs.readFile(path.join(workspace, 'during-phase.txt'), 'utf8'), 'Incomplete phase output');
          else await assert.rejects(fs.access(path.join(workspace, 'during-phase.txt')), { code: 'ENOENT' });
        }
        else await assert.rejects(fs.access(path.join(appRoot(app.id), 'releases', run.id, 'during-phase.txt')), { code: 'ENOENT' });
        assert.equal((await readApp(app.id)).release.id, run.id);
      } finally { supervisor.stop(); }
    });
  }
}

test('reset whole build starts a new run and preserves the stopped workspace and previous release', async () => {
  const { app, run, supervisor, workspace } = await fixture('building');
  supervisor.stop();
  const release = { id: 'previous-release', commit: 'previous-commit', createdAt: 1 };
  await updateApp(app.id, current => { current.release = release; });
  await assert.rejects(supervisor.recover(app.id, 'stale-run', 'reset-build'), /stopped build/);
  const reset = await supervisor.recover(app.id, run.id, 'reset-build');
  assert.notEqual(reset.id, run.id);
  assert.equal(reset.prompt, run.prompt);
  const current = await readApp(app.id);
  assert.equal(current.runs.length, 2);
  assert.equal(current.runs[0].state, 'failed');
  assert.deepEqual(current.release, release);
  assert.equal(await fs.readFile(path.join(workspace, 'partial.txt'), 'utf8'), 'Completed work');
  await supervisor.cancel(app.id, reset.id);
});

test('host restart preserves the interrupted phase for recovery', async () => {
  const app = await createApp({ prompt: 'Interrupted' });
  await updateApp(app.id, current => { current.runs.push({ id: app.id, prompt: 'Interrupted', state: 'repairing', progress: 70, log: '', attempt: 1, chatIds: [] }); });
  const supervisor = new ReefSupervisor();
  await supervisor.start('http://unused'); supervisor.stop();
  const run = (await readApp(app.id)).runs[0];
  assert.equal(run.state, 'interrupted'); assert.equal(run.failedStage, 'repairing');
  await supervisor.recover(app.id, run.id);
  await supervisor.cancel(app.id, run.id);
  assert.equal((await readApp(app.id)).runs[0].failedStage, 'repairing');
});
