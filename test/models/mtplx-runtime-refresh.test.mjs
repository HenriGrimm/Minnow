import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let binary = '/fixture/old/mtplx';
let resolutions = 0;
mock.module('../../server/process-runner.js', { namedExports: {
  runProcess: async (_command, args) => {
    if (args[0] === 'mtplx') {
      resolutions++;
      return { code: 0, stdout: binary, stderr: '' };
    }
    if (args[0] === '--version') return { code: 0, stdout: '2.12.3', stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  },
} });
const { discoverMtplxInstallations, getMtplxStatus, refreshMtplxStatus } = await import('../../server/models/mtplx-runtime.js');

test('explicit MTPLX refresh bypasses cached external installation detection', async () => {
  assert.equal((await getMtplxStatus()).path, '/fixture/old/mtplx');
  binary = '/fixture/updated/mtplx';
  assert.equal((await getMtplxStatus()).path, '/fixture/old/mtplx');
  assert.equal(resolutions, 1);
  assert.equal((await refreshMtplxStatus()).path, '/fixture/updated/mtplx');
  assert.equal(resolutions, 2);
  assert.equal((await getMtplxStatus()).path, '/fixture/updated/mtplx');
  assert.equal(resolutions, 2);
});

test('discovery recognizes the Mac app launcher and retains a separate PATH CLI', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-mtplx-discovery-'));
  const applications = path.join(home, 'Applications');
  const app = path.join(applications, 'MTPLX.app');
  const cli = path.join(home, '.mtplx', 'bin', 'mtplx');
  const appRuntime = path.join(home, 'Library', 'Application Support', 'MTPLX', 'runtime-venv', 'bin', 'mtplx');
  const writeExecutable = async (file, contents) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, { mode: 0o755 });
  };
  try {
    await fs.mkdir(path.join(app, 'Contents'), { recursive: true });
    await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), '');
    await writeExecutable(appRuntime, '');
    await writeExecutable(cli, `#!/bin/sh\nexec '${appRuntime}' "$@"\n`);
    binary = cli;
    let discovered = await discoverMtplxInstallations(home, applications);
    assert.equal(discovered.appPath, app);
    assert.deepEqual(discovered.candidates[0], { path: cli, source: 'app' });
    binary = '/opt/homebrew/bin/mtplx';
    discovered = await discoverMtplxInstallations(home, applications);
    assert.deepEqual(discovered.candidates.slice(0, 2), [
      { path: binary, source: 'path' }, { path: cli, source: 'app' },
    ]);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
