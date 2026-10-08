import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTION_READ_TOOLS, ACTION_WRITE_TOOLS } from '../../server/tools/action-catalog.js';
import { BUILT_IN_TOOLS } from '../../server/tools/builtin-catalog.js';
import { ALL_TOOL_IDS } from '../../server/config/tool-ids.js';
import { normalizeToolConfig } from '../../server/config/validators.js';
import { TOOL_GROUP_IDS } from '../../src/chat/modes/tool-groups.ts';
import fs from 'node:fs';
import { blockPlanModeWrite } from '../../server/tools/plan-write-guard.js';
import { defaultToolConfig } from '../../src/config/defaults.ts';

test('action tools are registered, permissioned and guarded on both sides', () => {
  const config = normalizeToolConfig({});
  const clientConfig = defaultToolConfig();
  for (const id of [...ACTION_READ_TOOLS, ...ACTION_WRITE_TOOLS]) {
    assert(ALL_TOOL_IDS.includes(id));
    assert(BUILT_IN_TOOLS.some((t) => t.id === id));
    assert.equal(config.enabled[id], true);
    assert.equal(
      config.permissions.default[id],
      ACTION_READ_TOOLS.includes(id as any) ? 'full' : 'ask',
    );
    assert.equal(clientConfig.permissions.default[id], config.permissions.default[id]);
  }
  for (const id of ACTION_READ_TOOLS) assert(TOOL_GROUP_IDS['git-read'].includes(id));
  for (const id of ACTION_WRITE_TOOLS) {
    assert(blockPlanModeWrite('plan', id, {}));
    assert(blockPlanModeWrite('super-plan', id, {}));
    assert.equal(blockPlanModeWrite('build', id, {}), null);
    assert(TOOL_GROUP_IDS['git-write'].includes(id));
    for (const file of ['server/tools/plan-write-guard.js', 'src/chat/modes/plan-write-guard.ts'])
      assert(fs.readFileSync(file, 'utf8').includes(`'${id}'`));
  }
});
