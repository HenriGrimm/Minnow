/**
 * Headless approval policy — ask permission blocks without env opt-in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNSAFE_AUTOMATION_ENV,
  headlessWouldBlockPermission,
  maybeBlockHeadlessToolApproval,
} from '../../src/headless/approval.ts';
import { setToolConfigForTests } from '../../src/tools/config.ts';
import { executeHeadlessTool } from '../../src/headless/execute-tool.ts';

describe('headless approval policy', () => {
  it('Scheduler automation still denies Off and returns question/browser errors without waiting', async () => {
    const previous = process.env[UNSAFE_AUTOMATION_ENV];
    process.env[UNSAFE_AUTOMATION_ENV] = '1';
    try {
      setToolConfigForTests({
        enabled: { read_file: true }, permissions: { default: { read_file: 'off' } },
        keys: { braveApiKey: '', tavilyApiKey: '' }, webSearchProvider: 'duckduckgo',
      });
      const denied = maybeBlockHeadlessToolApproval('read_file', {}, {}, { noApproval: true }, 'read_file');
      assert.match(denied?.content ?? '', /disabled|off/i);
      const options = { modeId: 'build' as const, noApproval: true, autoRejectQuestions: true };
      assert.match((await executeHeadlessTool('ask_question', {}, {}, options)).content, /non-interactive/);
      assert.match((await executeHeadlessTool('browser_navigate', {}, {}, options)).content, /cannot run in headless/);
    } finally {
      if (previous === undefined) delete process.env[UNSAFE_AUTOMATION_ENV];
      else process.env[UNSAFE_AUTOMATION_ENV] = previous;
    }
  });
  it('headlessWouldBlockPermission treats ask and off as blocking by default', () => {
    assert.equal(headlessWouldBlockPermission('ask'), true);
    assert.equal(headlessWouldBlockPermission('off'), true);
    assert.equal(headlessWouldBlockPermission('full'), false);
  });

  it('blocks ask permission without --no-approval', () => {
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
      { noApproval: false },
      'read_file',
    );
    assert.ok(blocked);
    assert.match(blocked!.content, /non-interactive/i);
  });

  it('--no-approval without env var still blocks', () => {
    const prev = process.env[UNSAFE_AUTOMATION_ENV];
    delete process.env[UNSAFE_AUTOMATION_ENV];
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
    assert.ok(blocked);
    assert.match(blocked!.content, new RegExp(UNSAFE_AUTOMATION_ENV));
    if (prev !== undefined) process.env[UNSAFE_AUTOMATION_ENV] = prev;
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
