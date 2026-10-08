import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-actions-test-'));
process.env.MINNOW_HOME = path.join(scratch, 'home');
const { openWorkspace } = await import('../../server/workspace/open-workspaces.js');
const { commandSave, commandList, actionSecrets } = await import(
  '../../server/git/action-config.js'
);
const {
  localRunStart,
  localRunList,
  localRunView,
  localRunCancel,
  cleanActionEnv,
  createRedactor,
} = await import('../../server/git/local-action-ops.js');
const { inside } = await import('../../server/git/action-common.js');
const { assertActionWorktreeIdle } = await import('../../server/git/action-run-lock.js');
const root = path.join(scratch, 'repo');
await fs.mkdir(root);
execFileSync('git', ['init', root], { stdio: 'ignore' });
openWorkspace(root);
after(async () => {
  for (const run of (await localRunList({ cwd: root })).runs)
    if (run.status === 'running') await localRunCancel({ cwd: root, id: run.id });
  await fs.rm(scratch, { recursive: true, force: true });
});

test('command config is versioned, package manager aware, and rejects escaping paths', async () => {
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { test: 'node test.js' } }),
  );
  await commandSave({
    cwd: root,
    command: { id: 'hello', label: 'Hello', command: 'node --version', cwd: '.' },
  });
  const result = await commandList({ cwd: root });
  assert.equal(result.commands[0].manager, 'pnpm');
  assert.equal(result.commands[1].id, 'hello');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, '.minnow/actions.json'), 'utf8')).version,
    1,
  );
  await assert.rejects(
    commandSave({
      cwd: root,
      command: { id: 'bad', label: 'Bad', command: 'echo bad', cwd: '..' },
    }),
    /outside/,
  );
  await assert.rejects(inside(root, '../outside', false), /outside/);
});
test('stream redaction handles secrets crossing chunk boundaries', () => {
  let output = '';
  const redact = createRedactor(['secret-value'], (text) => {
    output += text;
  });
  redact('before sec');
  redact('ret-value after');
  redact('', true);
  assert.equal(output, 'before [REDACTED] after');
  process.env.GH_TOKEN = 'do-not-forward';
  process.env.ACTION_TEST_SECRET = 'do-not-forward';
  assert.equal(cleanActionEnv().GH_TOKEN, undefined);
  assert.equal(cleanActionEnv().ACTION_TEST_SECRET, undefined);
  delete process.env.GH_TOKEN;
  delete process.env.ACTION_TEST_SECRET;
});
test('local run captures logs, masks selected secrets, holds checkout lock and releases it', async () => {
  await fs.writeFile(
    path.join(root, 'run.cjs'),
    'process.stdout.write(process.env.TEST_VALUE); setTimeout(() => process.stdout.write(" done"), 200);',
  );
  await actionSecrets({ cwd: root, name: 'TEST_SECRET', value: 'hidden-value' });
  await commandSave({
    cwd: root,
    command: {
      id: 'run',
      label: 'Run',
      command: 'node run.cjs',
      secrets: { TEST_VALUE: 'TEST_SECRET' },
    },
  });
  const { run } = await localRunStart({ cwd: root, kind: 'command', commandId: 'run' });
  assert.throws(() => assertActionWorktreeIdle(root), /local action/);
  let result;
  for (let i = 0; i < 100; i++) {
    result = await localRunView({ cwd: root, id: run.id });
    if (result.run.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(result.run.status, 'success', result.run.error);
  assert.equal(result.log, '[REDACTED] done');
  assert.doesNotThrow(() => assertActionWorktreeIdle(root));
  const other = path.join(scratch, 'other');
  await fs.mkdir(other);
  execFileSync('git', ['init', other], { stdio: 'ignore' });
  openWorkspace(other);
  await assert.rejects(localRunView({ cwd: other, id: run.id }), /another worktree/);
});
test('cancel terminates the run and permits a later run', async () => {
  await fs.writeFile(path.join(root, 'wait.cjs'), 'setInterval(() => {}, 1000);');
  await commandSave({
    cwd: root,
    command: { id: 'wait', label: 'Wait', command: 'node wait.cjs' },
  });
  const { run } = await localRunStart({ cwd: root, kind: 'command', commandId: 'wait' });
  await localRunCancel({ cwd: root, id: run.id });
  assert.equal((await localRunView({ cwd: root, id: run.id })).run.status, 'cancelled');
  assert.doesNotThrow(() => assertActionWorktreeIdle(root));
});

test('concurrent secret updates retain both values and require a name', async () => {
  await Promise.all([
    actionSecrets({ cwd: root, name: 'FIRST', value: 'one' }),
    actionSecrets({ cwd: root, name: 'SECOND', value: 'two' }),
  ]);
  const result = await actionSecrets({ cwd: root });
  assert.ok(result.names.includes('FIRST'));
  assert.ok(result.names.includes('SECOND'));
  await assert.rejects(actionSecrets({ cwd: root, value: 'unnamed' }), /name is required/);
});

test(
  'worker terminates its command when the server IPC connection disappears',
  { timeout: 15000 },
  async () => {
    const worker = fork(new URL('../../server/git/action-worker.js', import.meta.url), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
    });
    let pid;
    try {
      const output = once(worker.stdout, 'data');
      const closed = once(worker, 'exit');
      worker.send({
        kind: 'command',
        cwd: root,
        env: process.env,
        target: {
          command: process.execPath,
          args: ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'],
        },
      });
      pid = Number(String((await output)[0]).trim());
      assert.ok(pid > 0);
      worker.disconnect();
      await closed;
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      if (worker.exitCode === null) worker.kill();
      if (pid) {
        try {
          process.kill(pid);
        } catch {}
      }
    }
  },
);
