/**
 * Profile activate applies tools.json permissions.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache, ensureMinnowLayout, getMinnowHome } from '../../server/config/home.js';
import { readConfigJson, writeConfigJson } from '../../server/config/store.js';
import { activateProfile, saveProfileFile } from '../../server/profiles/handlers.js';

function setTestHome(env) {
  resetMinnowHomeCache();
  const dir = path.join(os.tmpdir(), `minnow-profiles-activate-${process.pid}`);
  env.MINNOW_HOME = dir;
  return dir;
}

describe('profile activate', () => {
  before(async () => {
    setTestHome(process.env);
    await ensureMinnowLayout();
  });

  after(() => {
    resetMinnowHomeCache();
  });

  test('activate ignores retired per-tool permissions in legacy bundles', async () => {
    const tools = (await readConfigJson('tools.json')) ?? {};
    const def = tools.permissions?.default ?? {};
    def.execute_command = 'full';
    def.save_file = 'full';
    tools.permissions = { ...tools.permissions, default: def };
    await writeConfigJson('tools.json', tools);

    await saveProfileFile({
      id: 'restore-me',
      label: 'Restore',
      schemaVersion: 1,
      prompt: {
        promptProfile: 'lite',
        activePromptConfigId: null,
        activeInfoPresetId: 'general-assistant',
        source: 'lite',
      },
      agents: { workAgents: {}, subAgents: {} },
      tools: {
        permissions: { execute_command: 'off', save_file: 'ask' },
        replaceAll: false,
      },
    });

    const result = await activateProfile('restore-me', { saveRollback: false });
    assert.equal(result.ok, true);

    const after = await readConfigJson('tools.json');
    assert.equal('permissions' in after, false);
    assert.equal('enabled' in after, false);

    const meta = await readConfigJson('config.json');
    assert.equal(meta.activeSetupProfileId, 'restore-me');
    assert.equal(meta.activePromptProfile, 'lite');
  });
});
