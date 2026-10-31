import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildChatPreparation } from '../../scripts/build-headless-runner.mjs';

test('shared chat composer bundle imports outside checkout with no modules, TS, browser state or CLI side effects', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-composer-bundle-'));
  try {
    const result = await buildChatPreparation({ outfile: path.join(dir, 'composer.mjs'), logLevel: 'error' });
    assert.deepEqual(result.externals, []);
    assert.ok(result.bytes < 200_000, `Export-only composer unexpectedly pulls runtime/UI: ${result.bytes}`);
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m=await import(${JSON.stringify(pathToFileURL(result.outfile).href)}); console.log(m.resolveChatModeTools({chat:{modeId:'super-plan',workAgentAuto:false},workAgents:[],toolNames:['read_file','git_commit','execute_command']}).allowedToolNames.join(','))`],
    { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, MINNOW_HOME: dir } });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout.trim(), 'read_file,execute_command');
    assert.equal(imported.stderr, '');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
