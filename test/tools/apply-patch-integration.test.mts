import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPathLikeArgs } from '../../src/tools/path-args.ts';
import { affectedDirsFromTool } from '../../src/ui/file-tree-invalidation.ts';
import { blockPlanModeWrite } from '../../src/chat/modes/plan-write-guard.ts';
import { normalizeToolConfig } from '../../src/tools/config.ts';

const patch = '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: lib/new.ts\n@@\n-old\n+new\n*** Add File: test/new.ts\n+test\n*** End Patch';
test('patch paths feed approvals and directory refresh, including move destinations', () => {
  assert.deepEqual(extractPathLikeArgs('apply_patch', { patch }), ['src/old.ts', 'lib/new.ts', 'test/new.ts']);
  assert.deepEqual(affectedDirsFromTool('apply_patch', { patch }), ['src', 'lib', 'test']);
  assert.ok(blockPlanModeWrite('plan', 'apply_patch', { patch }));
});
test('chat permission migration agrees with the server and respects explicit choices', () => {
  assert.equal(normalizeToolConfig({ permissions: { default: { save_file: 'full' } } }).permissions.default.apply_patch, 'ask');
  assert.equal(normalizeToolConfig({ permissions: { default: { save_file: 'full', apply_patch: 'off' } } }).permissions.default.apply_patch, 'off');
});
