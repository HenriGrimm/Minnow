import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { applyRemoteToolSecurityMeta, resetToolSecurityMetaCache } from '../../src/config/tool-security-meta.ts';
import { maybeBlockHeadlessToolApproval, resolveHeadlessPermissionLevel, isHeadlessExternalCallApproved } from '../../src/headless/approval.ts';
import { executeHeadlessTool } from '../../src/headless/execute-tool.ts';
import { defaultToolConfig, setToolConfigForTests } from '../../src/tools/config.ts';

afterEach(() => { resetToolSecurityMetaCache(); setToolConfigForTests(defaultToolConfig()); });

test('legacy CLI flags and environment opt-ins never widen the saved global mode', () => {
  const previous = process.env.MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION;
  process.env.MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION = '1';
  try {
    for (const permissionLevel of ['manual', 'auto', 'full'] as const) {
      applyRemoteToolSecurityMeta({ permissionLevel });
      assert.equal(resolveHeadlessPermissionLevel({ noApproval: true }), permissionLevel);
      assert.equal(resolveHeadlessPermissionLevel({ noApproval: false, permissionLevel: 'full' }), permissionLevel);
      assert.equal(resolveHeadlessPermissionLevel({ noApproval: true, permissionLevel: 'manual' }), 'manual');
    }
  } finally {
    if (previous === undefined) delete process.env.MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION;
    else process.env.MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION = previous;
  }
});

test('all levels permit project reads; Manual blocks unattended writes and Full permits plugin calls', () => {
  for (const permissionLevel of ['manual', 'auto', 'full'] as const) {
    applyRemoteToolSecurityMeta({ permissionLevel });
    const options = { noApproval: true };
    const context = { workspaceRoot: '/tmp/project' };
    assert.equal(maybeBlockHeadlessToolApproval('read_file', { path: 'README.md' }, context, options), null);
    const edit = maybeBlockHeadlessToolApproval('save_file', { path: 'code.ts', content: 'x' }, context, options);
    if (permissionLevel === 'manual') assert.match(edit?.content ?? '', /needs approval/);
    else assert.equal(edit, null);
    const plugin = maybeBlockHeadlessToolApproval('plugin__example__run', {}, context, options);
    if (permissionLevel === 'full') assert.equal(plugin, null);
    else assert.match(plugin?.content ?? '', /needs approval/);
  }
});

test('global Auto authorizes outside reads for this call, but clamps and the secret floor always apply', () => {
  applyRemoteToolSecurityMeta({ permissionLevel: 'auto' });
  const outside = { path: '/tmp/outside/readme.txt' };
  const context = { workspaceRoot: '/tmp/project' };
  assert.equal(maybeBlockHeadlessToolApproval('read_file', outside, context, { noApproval: false }), null);
  assert.equal(isHeadlessExternalCallApproved(outside), true);
  assert.equal(isHeadlessExternalCallApproved({ ...outside }), false);
  applyRemoteToolSecurityMeta({ permissionLevel: 'full' });
  assert.match(maybeBlockHeadlessToolApproval('save_file', { path: 'code.ts', content: 'x' },
    { ...context, turnClamp: 'read-only' }, { noApproval: true })?.content ?? '', /Error:/);
  assert.match(maybeBlockHeadlessToolApproval('read_file', { path: '/tmp/project/.minnow/.key' }, context,
    { noApproval: true })?.content ?? '', /Error:/);
});

test('unattended questions and browser-only calls return errors without waiting', async () => {
  setToolConfigForTests(defaultToolConfig());
  const options = { modeId: 'build' as const, noApproval: false, autoRejectQuestions: true };
  assert.match((await executeHeadlessTool('ask_question', {}, {}, options)).content, /non-interactive/);
  assert.match((await executeHeadlessTool('browser_navigate', {}, {}, options)).content, /cannot run in headless/);
});
