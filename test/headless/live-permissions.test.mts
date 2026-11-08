import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { defaultToolConfig, setToolConfigForTests } from '../../src/tools/config.ts';
import { applyRemoteToolSecurityMeta, resetToolSecurityMetaCache, getToolSecurityMetaCached } from '../../src/config/tool-security-meta.ts';
import { executeHeadlessTool } from '../../src/headless/execute-tool.ts';

let level: 'manual' | 'auto' | 'full';
let metadataAvailable: boolean;
let calls: Array<Record<string, any>>;
beforeEach(() => {
  level = 'full'; metadataAvailable = true; calls = [];
  setToolConfigForTests(defaultToolConfig());
  resetToolSecurityMetaCache();
  applyRemoteToolSecurityMeta({ permissionLevel: 'full' });
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/api/config/meta')) {
      return metadataAvailable ? Response.json({ toolSecurity: { permissionLevel: level } }) : new Response('', { status: 503 });
    }
    assert.ok(String(url).endsWith('/api/tools'), String(url));
    calls.push(JSON.parse(options?.body as string));
    return Response.json({ result: 'executed' });
  });
});
afterEach(() => { mock.restoreAll(); resetToolSecurityMetaCache(); setToolConfigForTests(defaultToolConfig()); });

const options = { modeId: 'general' as const, noApproval: true, permissionLevel: 'full' as const, autoRejectQuestions: true };
const context = { workspaceRoot: '/tmp/workspace' };

test('unattended plugin calls re-read live global revocations despite a startup Full cache and legacy flags', async () => {
  assert.equal((await executeHeadlessTool('plugin__test__run', {}, context, options)).content, 'executed');
  level = 'manual';
  assert.match((await executeHeadlessTool('plugin__test__run', {}, context, options)).content, /needs approval/);
  assert.match((await executeHeadlessTool('save_file', { path: 'code.ts', content: 'x' }, context, options)).content, /needs approval/);
  assert.equal(calls.length, 1);
});

test('a failed live authority read never reuses cached Full access for a write', async () => {
  metadataAvailable = false;
  applyRemoteToolSecurityMeta({ permissionLevel: 'full', shellSandbox: 'require' });
  assert.match((await executeHeadlessTool('save_file', { path: 'code.ts', content: 'x' }, context, options)).content, /needs approval/);
  assert.equal(calls.length, 0);
  assert.equal(getToolSecurityMetaCached().shellSandbox, 'require');
});

test('authorized outside reads carry a per-call admission; unrelated project reads do not', async () => {
  level = 'auto';
  assert.equal((await executeHeadlessTool('read_file', { path: '/tmp/external/file.txt' }, context, options)).content, 'executed');
  assert.equal(calls[0].approvedOutsideWorkspace, true);
  assert.equal((await executeHeadlessTool('read_file', { path: 'file.txt' }, context, options)).content, 'executed');
  assert.equal(calls[1].approvedOutsideWorkspace, undefined);
});
