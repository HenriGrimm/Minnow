/**
 * Headless approval policy — ask permission blocks without env opt-in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNSAFE_AUTOMATION_ENV,
  maybeBlockHeadlessToolApproval,
  resolveHeadlessPermissionLevel,
} from '../../src/headless/approval.ts';
import { setToolConfigForTests } from '../../src/tools/config.ts';
import { executeHeadlessTool } from '../../src/headless/execute-tool.ts';

describe('headless approval policy', () => {
  it('Scheduler automation ignores legacy Off and returns question/browser errors without waiting', async () => {
    const previous = process.env[UNSAFE_AUTOMATION_ENV];
    process.env[UNSAFE_AUTOMATION_ENV] = '1';
    try {
      setToolConfigForTests({
        enabled: { read_file: true }, permissions: { default: { read_file: 'off' } },
        keys: { braveApiKey: '', tavilyApiKey: '' }, webSearchProvider: 'duckduckgo',
      });
      const denied = maybeBlockHeadlessToolApproval('read_file', {}, {}, { noApproval: true }, 'read_file');
      assert.equal(denied, null);
      const options = { modeId: 'build' as const, noApproval: true, autoRejectQuestions: true };
      assert.match((await executeHeadlessTool('ask_question', {}, {}, options)).content, /non-interactive/);
      assert.match((await executeHeadlessTool('browser_navigate', {}, {}, options)).content, /cannot run in headless/);
    } finally {
      if (previous === undefined) delete process.env[UNSAFE_AUTOMATION_ENV];
      else process.env[UNSAFE_AUTOMATION_ENV] = previous;
    }
  });
  it('--no-approval with the env opt-in runs as Full access', () => {
    const prev = process.env[UNSAFE_AUTOMATION_ENV];
    process.env[UNSAFE_AUTOMATION_ENV] = '1';
    try {
      assert.equal(resolveHeadlessPermissionLevel({ noApproval: true, permissionLevel: 'manual' }), 'full');
      assert.equal(resolveHeadlessPermissionLevel({ noApproval: false, permissionLevel: 'manual' }), 'manual');
    } finally {
      if (prev === undefined) delete process.env[UNSAFE_AUTOMATION_ENV];
      else process.env[UNSAFE_AUTOMATION_ENV] = prev;
    }
  });

  it('reads inside the project run at any level', () => {
    setToolConfigForTests({
      enabled: { read_file: true },
      permissions: { default: { read_file: 'ask' } },
      keys: { braveApiKey: '', tavilyApiKey: '' },
      webSearchProvider: 'duckduckgo',
    });
    const result = maybeBlockHeadlessToolApproval(
      'read_file', { path: 'README.md' }, { workspaceRoot: '/tmp/ws' },
      { noApproval: false, permissionLevel: 'manual' }, 'read_file',
    );
    assert.equal(result, null);
  });

  it('an action that needs approval fails without --no-approval', () => {
    setToolConfigForTests({
      enabled: { save_file: true },
      permissions: { default: { save_file: 'ask' } },
      keys: { braveApiKey: '', tavilyApiKey: '' },
      webSearchProvider: 'duckduckgo',
    });
    const blocked = maybeBlockHeadlessToolApproval(
      'save_file', { path: 'src/a.ts', content: 'x' }, { workspaceRoot: '/tmp/ws' },
      { noApproval: false, permissionLevel: 'manual' }, 'save_file',
    );
    assert.ok(blocked);
    assert.match(blocked!.content, /non-interactive/i);
  });

  it('--no-approval without env opt-in keeps the saved global restrictions', () => {
    const previous = process.env[UNSAFE_AUTOMATION_ENV];
    delete process.env[UNSAFE_AUTOMATION_ENV];
    try {
      const blocked = maybeBlockHeadlessToolApproval('save_file', { path: 'file.ts', content: 'x' },
        { workspaceRoot: '/tmp/ws' }, { noApproval: true, permissionLevel: 'manual' });
      assert.match(blocked?.content ?? '', /needs approval/);
    } finally {
      if (previous !== undefined) process.env[UNSAFE_AUTOMATION_ENV] = previous;
    }
  });

  it('--no-approval with env allows ask tools', () => {
    const prev = process.env[UNSAFE_AUTOMATION_ENV];
    process.env[UNSAFE_AUTOMATION_ENV] = '1';
    setToolConfigForTests({
      enabled: { read_file: true },
      permissions: {
        default: { read_file: 'ask' },
      },
      keys: { braveApiKey: '', tavilyApiKey: '' },
      webSearchProvider: 'duckduckgo',
    });
    const blocked = maybeBlockHeadlessToolApproval(
      'read_file',
      { path: 'README.md' },
      {},
      { noApproval: true },
      'read_file',
    );
    assert.equal(blocked, null);
    if (prev !== undefined) {
      process.env[UNSAFE_AUTOMATION_ENV] = prev;
    } else {
      delete process.env[UNSAFE_AUTOMATION_ENV];
    }
  });
});
