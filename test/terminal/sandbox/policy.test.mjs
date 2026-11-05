/**
 * Pure policy + Seatbelt profile unit tests (MIN-553). Run on every platform.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyAgentShellSandbox,
  buildWorkspacePolicy,
  probeSandbox,
  resetSandboxProbeCache,
  resolveSandbox,
  shouldApplyShellSandbox,
  wrapSandbox,
  SANDBOX_EXEC_PATH,
  SANDBOX_UNAVAILABLE_REASON,
} from '../../../server/terminal/sandbox/index.js';
import {
  detectWorktreeRoot,
  packageCacheWriteRoots,
} from '../../../server/terminal/sandbox/policy.js';
import {
  partitionDenyReadPaths,
  renderSeatbeltProfile,
  seatbeltEscape,
} from '../../../server/terminal/sandbox/seatbelt.js';
import { resolveOneShotSpawn } from '../../../server/terminal/one-shot-spawn.js';

const FAKE_HOME = '/Users/dev';
const FAKE_MINNOW = '/Users/dev/.minnow';
const FAKE_WORKSPACE = '/Users/dev/Projects/app';
const FAKE_WORKTREE = '/Users/dev/.minnow/worktrees/app-deadbeef/board1/task-T1';

describe('sandbox policy (workspace profile)', () => {
  it('allows write under workspace, temp, and package caches', () => {
    const policy = buildWorkspacePolicy({
      home: FAKE_HOME,
      minnowHome: FAKE_MINNOW,
      workspaceRoot: FAKE_WORKSPACE,
      cwd: FAKE_WORKSPACE,
      platform: 'darwin',
    });

    assert.equal(policy.profile, 'workspace');
    assert.equal(policy.networkAllow, true);
    assert.ok(policy.writeRoots.includes(path.resolve(FAKE_WORKSPACE)));
    for (const cache of packageCacheWriteRoots(path.resolve(FAKE_HOME), 'darwin')) {
      assert.ok(
        policy.writeRoots.includes(cache),
        `expected write root ${cache}`,
      );
    }
  });

  it('denies ~/.minnow but re-allows active worktree + terminal logs', () => {
    const policy = buildWorkspacePolicy({
      home: FAKE_HOME,
      minnowHome: FAKE_MINNOW,
      workspaceRoot: FAKE_WORKSPACE,
      worktreeRoot: FAKE_WORKTREE,
      cwd: FAKE_WORKTREE,
      platform: 'darwin',
    });

    assert.ok(policy.denyReadRoots.includes(path.resolve(FAKE_MINNOW)));
    assert.ok(policy.allowReadExceptions.includes(path.resolve(FAKE_WORKTREE)));
    assert.ok(
      policy.allowReadExceptions.some((p) => p.endsWith(path.join('logs', 'terminal'))),
    );
    assert.ok(policy.writeRoots.includes(path.resolve(FAKE_WORKTREE)));
  });

  it('includes credential denylist under home', () => {
    const policy = buildWorkspacePolicy({
      home: FAKE_HOME,
      minnowHome: FAKE_MINNOW,
      workspaceRoot: FAKE_WORKSPACE,
      platform: 'darwin',
    });

    assert.ok(policy.denyReadRoots.some((p) => p.endsWith(`${path.sep}.ssh`)));
    assert.ok(policy.denyReadRoots.some((p) => p.endsWith(`${path.sep}.aws`)));
    assert.ok(policy.denyReadRoots.some((p) => p.includes(`${path.sep}.config${path.sep}gh`)));
    assert.ok(policy.denyReadRoots.some((p) => p.endsWith(`${path.sep}.npmrc`)));
  });

  it('detectWorktreeRoot only matches paths under worktrees root', () => {
    const worktreesRoot = path.join(FAKE_MINNOW, 'worktrees');
    assert.equal(
      detectWorktreeRoot(FAKE_WORKTREE, worktreesRoot),
      path.resolve(FAKE_WORKTREE),
    );
    assert.equal(detectWorktreeRoot(FAKE_WORKSPACE, worktreesRoot), null);
  });
});

describe('seatbelt profile rendering', () => {
  it('escapes quotes in paths', () => {
    assert.equal(seatbeltEscape('/tmp/a"b'), '/tmp/a\\"b');
  });

  it('emits write require-not filters and minnow deny with worktree re-allow', () => {
    const policy = buildWorkspacePolicy({
      home: FAKE_HOME,
      minnowHome: FAKE_MINNOW,
      workspaceRoot: FAKE_WORKSPACE,
      worktreeRoot: FAKE_WORKTREE,
      platform: 'darwin',
    });
    const text = renderSeatbeltProfile(policy);

    assert.match(text, /\(version 1\)/);
    assert.match(text, /\(allow default\)/);
    assert.match(text, /\(deny file-write\*/);
    assert.match(text, /\(require-not \(subpath "/);
    assert.match(text, /\(deny file-read\*/);
    assert.ok(text.includes(`(subpath "${seatbeltEscape(path.resolve(FAKE_MINNOW))}"`));
    assert.ok(text.includes(`(subpath "${seatbeltEscape(path.resolve(FAKE_WORKTREE))}"`));
    assert.match(text, /\(allow network\*\)/);
  });

  it('partitions credential files as literals', () => {
    const { dirs, files } = partitionDenyReadPaths(
      [
        path.join(FAKE_HOME, '.ssh'),
        path.join(FAKE_HOME, '.npmrc'),
        path.join(FAKE_HOME, '.docker', 'config.json'),
      ],
      FAKE_HOME,
    );
    assert.ok(dirs.some((p) => p.endsWith('.ssh')));
    assert.ok(files.some((p) => p.endsWith('.npmrc')));
    assert.ok(files.some((p) => p.endsWith(`config.json`)));
  });
});

describe('wrapSandbox argv composition', () => {
  it('wraps after resolveOneShotSpawn on darwin (sandbox-exec parent)', () => {
    const prevShell = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const resolved = resolveOneShotSpawn({
        command: 'npm test',
        args: [],
        platform: 'darwin',
      });
      assert.equal(resolved.command, '/bin/zsh');

      const policy = buildWorkspacePolicy({
        home: FAKE_HOME,
        minnowHome: FAKE_MINNOW,
        workspaceRoot: FAKE_WORKSPACE,
        platform: 'darwin',
      });
      const wrapped = wrapSandbox(resolved, policy, { platform: 'darwin' });

      assert.equal(wrapped.command, SANDBOX_EXEC_PATH);
      assert.equal(wrapped.args[0], '-p');
      assert.equal(typeof wrapped.args[1], 'string');
      assert.match(wrapped.args[1], /\(version 1\)/);
      assert.equal(wrapped.args[2], '/bin/zsh');
      assert.deepEqual(wrapped.args.slice(3), ['-l', '-c', 'npm test']);
      assert.equal(wrapped.shell, false);
      assert.equal(wrapped.sandbox.applied, true);
      assert.equal(wrapped.sandbox.kind, 'seatbelt');
    } finally {
      if (prevShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = prevShell;
    }
  });

  it('does not claim sandbox on win32 without WSL+Landlock (never bare WSL)', () => {
    resetSandboxProbeCache();
    const resolved = resolveOneShotSpawn({
      command: 'echo hi',
      args: [],
      platform: 'win32',
    });
    const policy = buildWorkspacePolicy({
      home: FAKE_HOME,
      minnowHome: FAKE_MINNOW,
      workspaceRoot: FAKE_WORKSPACE,
      platform: 'win32',
    });
    // No WSL fixtures → honest unavailable; leave the spawn target untouched (do not rewrite to bare wsl).
    const wrapped = wrapSandbox(resolved, policy, {
      platform: 'win32',
      wsl: { skipLiveProbe: true, wslFixtures: { listOutput: '' } },
    });

    assert.equal(wrapped.command, 'echo hi');
    assert.equal(wrapped.sandbox.applied, false);
    assert.equal(wrapped.sandbox.kind, 'wsl-landlock');
    assert.equal(
      wrapped.sandbox.reason,
      SANDBOX_UNAVAILABLE_REASON.WSL_UNAVAILABLE,
    );
  });

  it('landlock adapter reports helper-missing when binary absent', async () => {
    resetSandboxProbeCache();
    const prev = process.env.MINNOW_SANDBOX_HELPER;
    // Point at a path that cannot exist so PATH / resources probes do not accidentally hit a real binary.
    process.env.MINNOW_SANDBOX_HELPER = path.join(FAKE_HOME, 'no-such-minnow-sandbox-binary');
    try {
      const adapter = resolveSandbox('linux');
      assert.equal(adapter.kind, 'landlock');
      const probe = await probeSandbox('linux');
      assert.equal(probe.ok, false);
      assert.equal(probe.reason, SANDBOX_UNAVAILABLE_REASON.LANDLOCK_HELPER_MISSING);

      const resolved = resolveOneShotSpawn({
        command: 'echo hi',
        args: [],
        platform: 'linux',
      });
      const policy = buildWorkspacePolicy({
        home: FAKE_HOME,
        minnowHome: FAKE_MINNOW,
        workspaceRoot: FAKE_WORKSPACE,
        platform: 'linux',
      });
      const wrapped = wrapSandbox(resolved, policy, { platform: 'linux' });
      assert.equal(wrapped.sandbox.applied, false);
      assert.equal(wrapped.sandbox.reason, SANDBOX_UNAVAILABLE_REASON.LANDLOCK_HELPER_MISSING);
    } finally {
      if (prev === undefined) delete process.env.MINNOW_SANDBOX_HELPER;
      else process.env.MINNOW_SANDBOX_HELPER = prev;
      resetSandboxProbeCache();
    }
  });

  it('wraps with minnow-sandbox parent on linux when helper path exists', () => {
    const prevShell = process.env.SHELL;
    const prevHelper = process.env.MINNOW_SANDBOX_HELPER;
    delete process.env.SHELL;
    // Use this test file itself as a stand-in "binary" that exists on disk.
    process.env.MINNOW_SANDBOX_HELPER = fileURLToPath(import.meta.url);
    try {
      const resolved = resolveOneShotSpawn({
        command: 'npm test',
        args: [],
        platform: 'linux',
      });
      const policy = buildWorkspacePolicy({
        home: FAKE_HOME,
        minnowHome: FAKE_MINNOW,
        workspaceRoot: FAKE_WORKSPACE,
        platform: 'linux',
      });
      const wrapped = wrapSandbox(resolved, policy, { platform: 'linux' });

      assert.equal(wrapped.command, process.env.MINNOW_SANDBOX_HELPER);
      assert.equal(wrapped.shell, false);
      assert.equal(wrapped.sandbox.applied, true);
      assert.equal(wrapped.sandbox.kind, 'landlock');
      assert.ok(wrapped.args.includes('--'));
      assert.ok(wrapped.args.includes('--write'));
      assert.ok(wrapped.args.includes('--read'));
      const dash = wrapped.args.indexOf('--');
      assert.equal(wrapped.args[dash + 1], resolved.command);
    } finally {
      if (prevShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = prevShell;
      if (prevHelper === undefined) delete process.env.MINNOW_SANDBOX_HELPER;
      else process.env.MINNOW_SANDBOX_HELPER = prevHelper;
    }
  });
});

describe('shouldApplyShellSandbox / applyAgentShellSandbox', () => {
  it('requires MINNOW_SHELL_SANDBOX=1 and agent source', () => {
    assert.equal(
      shouldApplyShellSandbox({ source: 'agent', env: {} }),
      false,
    );
    assert.equal(
      shouldApplyShellSandbox({
        source: 'agent',
        env: { MINNOW_SHELL_SANDBOX: '1' },
      }),
      true,
    );
    assert.equal(
      shouldApplyShellSandbox({
        source: 'user',
        env: { MINNOW_SHELL_SANDBOX: '1' },
      }),
      false,
    );
    assert.equal(
      shouldApplyShellSandbox({
        source: 'agent',
        sandbox: false,
        env: { MINNOW_SHELL_SANDBOX: '1' },
      }),
      false,
    );
  });

  it('applyAgentShellSandbox no-ops for user source even when env set', () => {
    const resolved = {
      command: '/bin/zsh',
      args: ['-l', '-c', 'echo hi'],
      shell: false,
    };
    const out = applyAgentShellSandbox(resolved, {
      source: 'user',
      cwd: FAKE_WORKSPACE,
      workspaceRoot: FAKE_WORKSPACE,
      env: { MINNOW_SHELL_SANDBOX: '1' },
      platform: 'darwin',
    });
    assert.equal(out.command, '/bin/zsh');
    assert.equal(out.sandbox.applied, false);
  });

  it('skips WSL Landlock wrap for git-bash without Ask', () => {
    const spawn = {
      command: 'C:\\Git\\bin\\bash.exe',
      args: ['--login', '-c', 'ls'],
      shell: false,
      env: { CHERE_INVOKING: '1' },
    };
    const out = applyAgentShellSandbox(spawn, {
      source: 'agent',
      mode: 'prefer',
      cwd: FAKE_WORKSPACE,
      workspaceRoot: FAKE_WORKSPACE,
      platform: 'win32',
      runtime: 'git-bash',
    });
    assert.equal(out.command, spawn.command);
    assert.deepEqual(out.args, spawn.args);
    assert.equal(out.sandbox.applied, false);
    assert.equal(out.sandbox.needsEscalation, undefined);
    assert.equal(out.sandbox.blocked, undefined);
    assert.equal(out.sandbox.reason, SANDBOX_UNAVAILABLE_REASON.NATIVE_WIN_SHELL);
    assert.equal(applyAgentShellSandbox(spawn, {
      source: 'agent', mode: 'require', cwd: FAKE_WORKSPACE, workspaceRoot: FAKE_WORKSPACE,
      platform: 'win32', runtime: 'git-bash', allowUnsandboxed: true,
    }).sandbox.blocked, true);
  });
});
