/**
 * Dependency dir symlinks into board worktrees.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import {
  ensureDependencyDirs,
  inspectDepDir,
  symlinkDependencyDirs,
  materializeDepDirs,
  unlinkSharedDepsBeforeInstall,
} from '../../server/worktree/dep-symlinks.js';
import { createWorktree, ensureIntegration } from '../../server/worktree/worktree-ops.js';
import { getWorktreeSlotPath } from '../../server/worktree/paths.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';

const execFileAsync = promisify(execFile);
const BOARD_ID = 'dep-symlink-board-22222222';

describe('dep-symlinks', () => {
  let repoDir;
  let minnowHome;

  before(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-dep-symlink-'));
    repoDir = path.join(root, 'repo');
    minnowHome = path.join(root, 'minnow-home');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(minnowHome, { recursive: true });
    process.env.MINNOW_HOME = minnowHome;
    await setWorkspaceRoot(repoDir);

    await execFileAsync('git', ['init'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await fs.writeFile(path.join(repoDir, 'package.json'), '{"name":"dep-symlink-test"}\n', 'utf8');
    await fs.mkdir(path.join(repoDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'node_modules', 'pkg.txt'), 'installed\n', 'utf8');
    await execFileAsync('git', ['add', 'package.json'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true });
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
  });

  test('symlinkDependencyDirs links node_modules when package.json exists', async () => {
    const wtDir = path.join(path.dirname(repoDir), 'manual-wt');
    await fs.mkdir(wtDir, { recursive: true });

    await symlinkDependencyDirs(repoDir, wtDir);

    const linkPath = path.join(wtDir, 'node_modules');
    const st = await fs.lstat(linkPath);
    assert.ok(st.isSymbolicLink() || st.isDirectory());

    const resolved = await fs.realpath(linkPath);
    const sourceResolved = await fs.realpath(path.join(repoDir, 'node_modules'));
    assert.equal(resolved, sourceResolved);

    const content = await fs.readFile(path.join(linkPath, 'pkg.txt'), 'utf8');
    assert.equal(content, 'installed\n');

    await fs.rm(wtDir, { recursive: true, force: true });
  });

  test('createWorktree links node_modules from integration worktree (seed resolves to main)', async () => {
    const integrationBranch = `minnow/board/${BOARD_ID}/integration`;
    const taskBranch = `minnow/board/${BOARD_ID}/task/W1-A`;

    const ensured = await ensureIntegration({
      boardId: BOARD_ID,
      branch: integrationBranch,
    });
    assert.equal(ensured.ok, true);

    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration');
    const intNm = path.join(intPath, 'node_modules');
    assert.ok(await fs.stat(intNm).then((s) => s.isDirectory() || s.isSymbolicLink()));

    const created = await createWorktree({
      boardId: BOARD_ID,
      slotId: 'task-W1-A',
      branch: taskBranch,
      baseRef: integrationBranch,
    });
    assert.equal(created.ok, true);

    const wtPath = getWorktreeSlotPath(BOARD_ID, 'task-W1-A');
    const wtNm = path.join(wtPath, 'node_modules');
    const resolved = await fs.realpath(wtNm);
    // Integration seeds node_modules from main; realpath collapse still lands on main.
    const sourceResolved = await fs.realpath(path.join(repoDir, 'node_modules'));
    assert.equal(resolved, sourceResolved);
  });

  test('createWorktree sees integration-layer installs in node_modules', async () => {
    const boardId = 'dep-symlink-board-33333333';
    const integrationBranch = `minnow/board/${boardId}/integration`;
    const taskBranch = `minnow/board/${boardId}/task/W2-A`;

    assert.equal(
      (await ensureIntegration({ boardId, branch: integrationBranch })).ok,
      true,
    );

    const intPath = getWorktreeSlotPath(boardId, 'integration');
    const intNm = path.join(intPath, 'node_modules');
    await fs.rm(intNm);
    await fs.mkdir(intNm, { recursive: true });
    await fs.writeFile(path.join(intNm, 'integration-marker.txt'), 'from-integration\n', 'utf8');

    const created = await createWorktree({
      boardId,
      slotId: 'task-W2-A',
      branch: taskBranch,
      baseRef: integrationBranch,
    });
    assert.equal(created.ok, true);

    const wtPath = getWorktreeSlotPath(boardId, 'task-W2-A');
    const wtNm = path.join(wtPath, 'node_modules');
    const resolved = await fs.realpath(wtNm);
    const intResolved = await fs.realpath(intNm);
    assert.equal(resolved, intResolved);

    const marker = await fs.readFile(path.join(wtNm, 'integration-marker.txt'), 'utf8');
    assert.equal(marker, 'from-integration\n');
  });

  // ── repair (the ELOOP class) ─────────────────────────────────────────────

  const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

  /** Fresh empty worktree-ish dir next to the repo. */
  async function makeWorkDir(name) {
    const dir = path.join(path.dirname(repoDir), name);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Replace `linkPath` with a link/junction cycle (`link → other → link`) — the state
   * that makes every npm script in the worktree die with `spawn ELOOP`.
   * Each symlink is created while its target exists, so junctions work on Windows.
   */
  async function makeBrokenCycle(linkPath) {
    const other = `${linkPath}.cycle`;
    await fs.rm(linkPath, { force: true });
    await fs.rm(other, { recursive: true, force: true });
    await fs.mkdir(other);
    await fs.symlink(other, linkPath, LINK_TYPE);
    await fs.rm(other, { recursive: true, force: true });
    await fs.symlink(linkPath, other, LINK_TYPE);
  }

  test('inspectDepDir reports a dangling link as broken, not present', async () => {
    const wtDir = await makeWorkDir('inspect-wt');
    const deadTarget = path.join(wtDir, 'gone');
    await fs.mkdir(deadTarget);
    const linkPath = path.join(wtDir, 'node_modules');
    await fs.symlink(deadTarget, linkPath, LINK_TYPE);
    await fs.rm(deadTarget, { recursive: true, force: true });

    // lstat-based checks still see it — that is the bug this replaces.
    await fs.lstat(linkPath);
    assert.equal(await inspectDepDir(linkPath), 'broken');
    assert.equal(await inspectDepDir(path.join(wtDir, 'nope')), 'missing');
    assert.equal(await inspectDepDir(repoDir), 'real-dir');

    await fs.rm(wtDir, { recursive: true, force: true });
  });

  test('ensureDependencyDirs repairs a dangling node_modules link', async () => {
    const wtDir = await makeWorkDir('dangling-wt');
    const deadTarget = path.join(wtDir, 'deleted-deps');
    await fs.mkdir(deadTarget);
    const linkPath = path.join(wtDir, 'node_modules');
    await fs.symlink(deadTarget, linkPath, LINK_TYPE);
    await fs.rm(deadTarget, { recursive: true, force: true });

    const res = await ensureDependencyDirs(repoDir, wtDir);

    assert.equal(res.ok, true, JSON.stringify(res.failed));
    assert.deepEqual(res.repaired, ['node_modules']);
    assert.equal(await inspectDepDir(linkPath), 'link-ok');
    assert.equal(
      await fs.realpath(linkPath),
      await fs.realpath(path.join(repoDir, 'node_modules')),
    );
    assert.equal(await fs.readFile(path.join(linkPath, 'pkg.txt'), 'utf8'), 'installed\n');

    await fs.rm(wtDir, { recursive: true, force: true });
  });

  test('ensureDependencyDirs repairs a cyclic link (the reported spawn ELOOP)', async () => {
    const wtDir = await makeWorkDir('cyclic-wt');
    const linkPath = path.join(wtDir, 'node_modules');
    await makeBrokenCycle(linkPath);

    assert.equal(await inspectDepDir(linkPath), 'broken');

    const res = await ensureDependencyDirs(repoDir, wtDir);

    assert.equal(res.ok, true, JSON.stringify(res.failed));
    assert.deepEqual(res.repaired, ['node_modules']);
    assert.equal(
      await fs.realpath(linkPath),
      await fs.realpath(path.join(repoDir, 'node_modules')),
    );

    await fs.rm(wtDir, { recursive: true, force: true });
  });

  test('ensureDependencyDirs leaves a healthy link alone', async () => {
    const wtDir = await makeWorkDir('healthy-wt');
    const first = await ensureDependencyDirs(repoDir, wtDir);
    assert.deepEqual(first.linked, ['node_modules']);

    const second = await ensureDependencyDirs(repoDir, wtDir);
    assert.equal(second.ok, true);
    assert.deepEqual(second.linked, []);
    assert.deepEqual(second.repaired, []);

    await fs.rm(wtDir, { recursive: true, force: true });
  });

  test('ensureDependencyDirs refuses a self-link', async () => {
    const res = await ensureDependencyDirs(repoDir, repoDir);

    assert.equal(res.ok, false);
    assert.deepEqual(res.linked, []);
    assert.deepEqual(res.repaired, []);
    const reason = res.failed.find((f) => f.dir === 'node_modules')?.reason ?? '';
    assert.match(reason, /itself/);

    // The real dir is untouched.
    assert.equal(await inspectDepDir(path.join(repoDir, 'node_modules')), 'real-dir');
    assert.equal(
      await fs.readFile(path.join(repoDir, 'node_modules', 'pkg.txt'), 'utf8'),
      'installed\n',
    );
  });

  test('ensureDependencyDirs relinks when the source drifted', async () => {
    const wtDir = await makeWorkDir('drift-wt');
    const otherSource = await makeWorkDir('drift-source');
    await fs.writeFile(path.join(otherSource, 'package.json'), '{"name":"other"}\n', 'utf8');
    await fs.mkdir(path.join(otherSource, 'node_modules'), { recursive: true });

    assert.equal((await ensureDependencyDirs(otherSource, wtDir)).ok, true);
    const res = await ensureDependencyDirs(repoDir, wtDir);

    assert.deepEqual(res.repaired, ['node_modules']);
    assert.equal(
      await fs.realpath(path.join(wtDir, 'node_modules')),
      await fs.realpath(path.join(repoDir, 'node_modules')),
    );

    await fs.rm(wtDir, { recursive: true, force: true });
    await fs.rm(otherSource, { recursive: true, force: true });
  });

  test('a broken integration link does not propagate to tasks in the wave', async () => {
    const boardId = 'dep-symlink-board-55555555';
    const integrationBranch = `minnow/board/${boardId}/integration`;
    const taskBranch = `minnow/board/${boardId}/task/W3-A`;

    assert.equal((await ensureIntegration({ boardId, branch: integrationBranch })).ok, true);

    // Corrupt the integration link the way the reported worktree was corrupt.
    const intPath = getWorktreeSlotPath(boardId, 'integration');
    const intNm = path.join(intPath, 'node_modules');
    await makeBrokenCycle(intNm);
    assert.equal(await inspectDepDir(intNm), 'broken');

    // The next board pass re-runs ensureIntegration, which repairs before any task chains on.
    const reused = await ensureIntegration({ boardId, branch: integrationBranch });
    assert.equal(reused.created, false);
    assert.equal(reused.deps.ok, true, JSON.stringify(reused.deps.failed));
    assert.equal(await inspectDepDir(intNm), 'link-ok');

    const created = await createWorktree({
      boardId,
      slotId: 'task-W3-A',
      branch: taskBranch,
      baseRef: integrationBranch,
    });
    assert.equal(created.ok, true, created.output);

    const wtNm = path.join(getWorktreeSlotPath(boardId, 'task-W3-A'), 'node_modules');
    assert.equal(await inspectDepDir(wtNm), 'link-ok');
    assert.equal(await fs.readFile(path.join(wtNm, 'pkg.txt'), 'utf8'), 'installed\n');
  });

  test('ensureDependencyDirs removes a broken target when the source is also broken', async () => {
    const srcDir = await makeWorkDir('broken-src');
    await fs.writeFile(path.join(srcDir, 'package.json'), '{"name":"broken-src"}\n', 'utf8');
    const srcNm = path.join(srcDir, 'node_modules');
    await makeBrokenCycle(srcNm);

    const wtDir = await makeWorkDir('broken-src-wt');
    const wtNm = path.join(wtDir, 'node_modules');
    await makeBrokenCycle(wtNm);
    assert.equal(await inspectDepDir(wtNm), 'broken');

    const res = await ensureDependencyDirs(srcDir, wtDir);

    assert.equal(res.ok, false);
    assert.match(res.failed.find((f) => f.dir === 'node_modules')?.reason ?? '', /does not resolve/);
    // Target ELOOP is gone even though there was nothing healthy to copy.
    assert.equal(await inspectDepDir(wtNm), 'missing');

    await fs.rm(srcDir, { recursive: true, force: true });
    await fs.rm(wtDir, { recursive: true, force: true });
  });

  test('createWorktree falls back to the workspace when integration node_modules is broken', async () => {
    const boardId = 'dep-symlink-board-77777777';
    const integrationBranch = `minnow/board/${boardId}/integration`;
    const taskBranch = `minnow/board/${boardId}/task/W5-A`;

    assert.equal((await ensureIntegration({ boardId, branch: integrationBranch })).ok, true);

    const intNm = path.join(getWorktreeSlotPath(boardId, 'integration'), 'node_modules');
    await makeBrokenCycle(intNm);
    assert.equal(await inspectDepDir(intNm), 'broken');

    // Do not re-run ensureIntegration — that is the V2 allocate cache hole.
    const created = await createWorktree({
      boardId,
      slotId: 'task-W5-A',
      branch: taskBranch,
      baseRef: integrationBranch,
    });
    assert.equal(created.ok, true, created.output);

    const wtNm = path.join(getWorktreeSlotPath(boardId, 'task-W5-A'), 'node_modules');
    assert.equal(await inspectDepDir(wtNm), 'link-ok');
    assert.equal(
      await fs.realpath(wtNm),
      await fs.realpath(path.join(repoDir, 'node_modules')),
    );
    assert.equal(await fs.readFile(path.join(wtNm, 'pkg.txt'), 'utf8'), 'installed\n');
  });

  test('createWorktree repairs a broken link in a reused slot', async () => {
    const boardId = 'dep-symlink-board-66666666';
    const integrationBranch = `minnow/board/${boardId}/integration`;
    const taskBranch = `minnow/board/${boardId}/task/W4-A`;

    assert.equal((await ensureIntegration({ boardId, branch: integrationBranch })).ok, true);
    const first = await createWorktree({
      boardId,
      slotId: 'task-W4-A',
      branch: taskBranch,
      baseRef: integrationBranch,
    });
    assert.equal(first.ok, true, first.output);

    const wtNm = path.join(getWorktreeSlotPath(boardId, 'task-W4-A'), 'node_modules');
    await makeBrokenCycle(wtNm);
    assert.equal(await inspectDepDir(wtNm), 'broken');

    const reused = await createWorktree({
      boardId,
      slotId: 'task-W4-A',
      branch: taskBranch,
      baseRef: integrationBranch,
    });

    assert.equal(reused.ok, true, reused.output);
    assert.equal(reused.created, false);
    assert.deepEqual(reused.deps.repaired, ['node_modules']);
    assert.equal(await inspectDepDir(wtNm), 'link-ok');
    assert.equal(await fs.readFile(path.join(wtNm, 'pkg.txt'), 'utf8'), 'installed\n');
  });

  test('materializeDepDirs converts seed junction to absent dir without deleting main target', async () => {
    const boardId = 'dep-symlink-board-44444444';
    const integrationBranch = `minnow/board/${boardId}/integration`;

    assert.equal(
      (await ensureIntegration({ boardId, branch: integrationBranch })).ok,
      true,
    );

    const intPath = getWorktreeSlotPath(boardId, 'integration');
    const intNm = path.join(intPath, 'node_modules');
    const mainNm = path.join(repoDir, 'node_modules');

    const beforeInt = await fs.lstat(intNm);
    assert.ok(beforeInt.isSymbolicLink() || beforeInt.isDirectory());

    const res = await materializeDepDirs(intPath, ['node_modules']);
    assert.deepEqual(res, { removed: ['node_modules'], failed: [] });

    await assert.rejects(() => fs.lstat(intNm));

    // A real dir (a materialized install) is left alone and not reported as removed.
    await fs.mkdir(intNm, { recursive: true });
    assert.deepEqual(await materializeDepDirs(intPath, ['node_modules']), {
      removed: [],
      failed: [],
    });
    assert.equal(await inspectDepDir(intNm), 'real-dir');

    const mainContent = await fs.readFile(path.join(mainNm, 'pkg.txt'), 'utf8');
    assert.equal(mainContent, 'installed\n');
  });

  /** A pnpm-workspace source with its own `node_modules`, plus an empty worktree dir. */
  async function pnpmFixture(name) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), `minnow-pnpm-${name}-`));
    const source = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    for (const dir of [source, wt]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'package.json'), '{"name":"ws"}\n', 'utf8');
      await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');
      await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
    }
    await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(source, 'node_modules', 'pkg.txt'), 'main\n', 'utf8');
    return { base, source, wt };
  }

  test('a pnpm workspace gets a real install, not a link into the main checkout', async () => {
    const { base, source, wt } = await pnpmFixture('install');
    const calls = [];
    const res = await ensureDependencyDirs(source, wt, {
      installPnpm: async (dir) => {
        calls.push(dir);
        await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
        return { ok: true };
      },
    });
    assert.deepEqual(calls, [wt]);
    assert.deepEqual(res.installed, ['node_modules']);
    assert.deepEqual(res.linked, []);
    assert.equal(await inspectDepDir(path.join(wt, 'node_modules')), 'real-dir');

    // Installed already: no second install.
    const again = await ensureDependencyDirs(source, wt, {
      installPnpm: async () => assert.fail('must not reinstall over a real node_modules'),
    });
    assert.deepEqual(again.installed, []);
    await fs.rm(base, { recursive: true, force: true });
  });

  test('a failed pnpm workspace install falls back to the shared link', async () => {
    const { base, source, wt } = await pnpmFixture('fallback');
    const res = await ensureDependencyDirs(source, wt, {
      installPnpm: async () => ({ ok: false, reason: 'offline' }),
    });
    assert.deepEqual(res.linked, ['node_modules']);
    assert.equal(await inspectDepDir(path.join(wt, 'node_modules')), 'link-ok');
    await fs.rm(base, { recursive: true, force: true });
  });

  test('an agent install in a linked worktree drops the shared node_modules link first', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-install-guard-'));
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    await fs.mkdir(path.join(main, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(main, 'node_modules', 'pkg.txt'), 'main\n', 'utf8');
    await fs.mkdir(path.join(main, '.git'), { recursive: true });
    await fs.mkdir(wt, { recursive: true });
    await fs.writeFile(path.join(wt, '.git'), 'gitdir: ../main/.git/worktrees/wt\n', 'utf8');
    const link = () => fs.symlink(path.join(main, 'node_modules'), path.join(wt, 'node_modules'), 'dir');
    await link();

    assert.deepEqual(await unlinkSharedDepsBeforeInstall('pnpm exec tsc --noEmit', wt), { unlinked: false });
    assert.deepEqual(await unlinkSharedDepsBeforeInstall('npm run install-hooks', wt), { unlinked: false });
    assert.equal(await inspectDepDir(path.join(wt, 'node_modules')), 'link-ok');

    // The main checkout (`.git` is a directory) is never touched.
    assert.deepEqual(await unlinkSharedDepsBeforeInstall('pnpm install', main), { unlinked: false });

    assert.deepEqual(
      await unlinkSharedDepsBeforeInstall('cd packages/core && CI=true pnpm install 2>&1 | tail -8', wt),
      { unlinked: true },
    );
    assert.equal(await inspectDepDir(path.join(wt, 'node_modules')), 'missing');
    assert.equal(await fs.readFile(path.join(main, 'node_modules', 'pkg.txt'), 'utf8'), 'main\n');

    for (const command of ['npm ci', 'yarn add left-pad', 'npm --prefix app i', 'pnpm --filter @gitbox/core install', 'pnpm -C packages/core add zod', 'bun install']) {
      await link();
      assert.deepEqual(await unlinkSharedDepsBeforeInstall(command, wt), { unlinked: true }, command);
    }
    await fs.rm(base, { recursive: true, force: true });
  });
});
