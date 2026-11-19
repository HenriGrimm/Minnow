import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

test('isolated launcher owns its checkout profile and uses its child’s bound URL on each launch', { timeout: 20_000 }, async (t) => {
  const tmp = path.resolve('test/tmp');
  await fs.mkdir(tmp, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmp, 'isolated-dev-'));
  const scripts = path.join(root, 'scripts');
  const home = path.join(root, 'home');
  const installed = path.join(home, '.minnow');
  await fs.mkdir(scripts);
  await fs.mkdir(installed, { recursive: true });
  const installedMarker = path.join(installed, 'fixture');
  await fs.writeFile(installedMarker, 'unchanged');
  for (const name of ['isolated-dev.mjs', 'runtime-process-log.mjs']) {
    await fs.copyFile(path.join('scripts', name), path.join(scripts, name));
  }
  await fs.writeFile(path.join(scripts, 'build-headless-runner.mjs'), 'export async function buildChatPreparation() {}');
  await fs.writeFile(path.join(scripts, 'spawn-electron.mjs'), `
    import { spawn } from 'node:child_process';
    export async function spawnElectronShell({ devUrl, port, supervised, env }) {
      const child = spawn(process.execPath, ['-e', "process.on('message', () => process.exit(0))"], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env,
      });
      console.log('SHELL ' + JSON.stringify({ devUrl, port, supervised, home: env.MINNOW_HOME, electron: env.MINNOW_DEV_USER_DATA, inheritedToken: Boolean(env.MINNOW_TOKEN) }));
      return child;
    }
  `);
  await fs.writeFile(path.join(root, 'server.js'), `
    const port = Number(process.env.PORT) + 2;
    process.on('message', () => process.exit(0));
    process.send({ type: 'minnow-dev-ready', localUrl: 'http://localhost:' + port + '/', port });
  `);
  const runs = [];
  function launch() {
    const child = spawn(process.execPath, [path.join(scripts, 'isolated-dev.mjs')], {
      cwd: root,
      env: {
        ...process.env, HOME: home, USERPROFILE: home, MINNOW_HOME: installed,
        MINNOW_TOKEN: 'fixture-only', PORT: '21000', BROWSER: '',
        MINNOW_HEADLESS: '0', MINNOW_BROWSER: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    let ready;
    const shell = new Promise(resolve => { ready = resolve; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/^SHELL (.+)$/m);
      if (match) ready(JSON.parse(match[1]));
    });
    const closed = new Promise(resolve => child.once('close', code => resolve({ code, output })));
    const run = { child, shell: Promise.race([shell, closed.then(({ output }) => assert.fail(output))]), closed };
    void run.shell.catch(() => {});
    runs.push(run);
    return run;
  }
  t.after(async () => {
    for (const { child } of runs) if (child.connected) child.send({ type: 'minnow-dev-stop' }, () => {});
    await Promise.all(runs.map(run => run.closed));
    await fs.rm(root, { recursive: true, force: true });
  });

  const first = launch();
  const { home: serverHome, electron, ...launchOptions } = await first.shell;
  assert.equal(path.dirname(serverHome), path.dirname(electron));
  assert.equal(path.dirname(path.dirname(serverHome)), path.join(home, '.minnow-dev'));
  assert.equal(path.basename(serverHome), 'server');
  assert.equal(path.basename(electron), 'electron');
  assert.deepEqual(launchOptions, {
    devUrl: 'http://localhost:21002/', port: 21002, supervised: true, inheritedToken: false,
  });
  const duplicate = await launch().closed;
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.output, /already has an isolated Minnow launch/);
  first.child.send({ type: 'minnow-dev-stop' });
  assert.equal((await first.closed).code, 0);

  const second = launch();
  assert.deepEqual(await second.shell, { ...launchOptions, home: serverHome, electron });
  second.child.send({ type: 'minnow-dev-stop' });
  assert.equal((await second.closed).code, 0);
  assert.equal(await fs.readFile(installedMarker, 'utf8'), 'unchanged');
});
