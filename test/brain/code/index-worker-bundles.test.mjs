import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { resetMinnowHomeCache } from '../../../server/config/home.js';
import { runBrainCodeReindexChild } from '../../../server/brain/code/index-host.js';
import {
  getAppRoot,
  getDefaultWorkspaceRoot,
  isAppRootPackaged,
  resetDefaultWorkspaceRootForTests,
  setAppRoot,
} from '../../../server/workspace/root.js';

const APP_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

it('indexes Python with the app bundle when launched outside the install directory', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-index-bundles-'));
  const home = path.join(temp, 'home');
  const workspace = path.join(temp, 'python-project');
  const launchDir = path.join(temp, 'launch-directory');
  const previous = {
    cwd: process.cwd(),
    home: process.env.MINNOW_HOME,
    appRoot: getAppRoot(),
    packaged: isAppRootPackaged(),
    workspace: getDefaultWorkspaceRoot(),
  };
  try {
    await Promise.all([home, workspace, launchDir].map((dir) => fs.mkdir(dir)));
    await fs.writeFile(path.join(workspace, 'sample.py'), 'def greet():\n    return "hello"\n');
    process.env.MINNOW_HOME = home;
    resetMinnowHomeCache();
    setAppRoot(APP_ROOT, { packaged: true });
    resetDefaultWorkspaceRootForTests(workspace);
    // Desktop shortcuts/Finder need not launch from the bundled app root. Neither
    // this directory nor the Python project has package.json or node_modules.
    process.chdir(launchDir);

    const result = await runBrainCodeReindexChild({
      files: ['sample.py'],
      force: true,
      codeConfig: { autoScaffoldIndexConfig: false },
    }, { timeoutMs: 30_000, silenceMs: 20_000 });
    assert.equal(result.indexedFiles, 1, JSON.stringify(result.errorSummary));
    assert.equal(result.failedFiles, 0);
    assert.ok(result.symbolsIndexed >= 1, 'Pyright should return the greet symbol');
  } finally {
    process.chdir(previous.cwd);
    setAppRoot(previous.appRoot, { packaged: previous.packaged });
    resetDefaultWorkspaceRootForTests(previous.workspace);
    if (previous.home === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previous.home;
    resetMinnowHomeCache();
    // The host receives done just before the worker exits and releases its cwd/DB.
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
