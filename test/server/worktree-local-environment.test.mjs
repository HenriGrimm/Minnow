import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mock, test } from 'node:test';
import { prepareWorktreeEnvironment } from '../../server/worktree/local-environment.js';
import { createChatWorktree, enableChatWorktree, ensureIntegration, createWorktree } from '../../server/worktree/worktree-ops.js';
import { worktreeAdd } from '../../server/git/git-ops.js';
import { handleWorktreeRequest } from '../../server/worktree/middleware.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { runWithToolContext } from '../../server/runtime/path-access.js';

const exec = promisify(execFile);
const names = ['.env', '.env.local', '.env.development', '.env.development.local',
  '.env.dev', '.env.dev.local', '.env.test', '.env.test.local', '.env.testing', '.env.testing.local'];
const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const write = async (root, file, bytes) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), bytes);
};

async function fixture(run) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-dotenv-')));
  const repo = path.join(root, 'source'), target = path.join(root, 'target');
  const home = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = path.join(root, 'home'); resetMinnowHomeCache();
  const git = (args, cwd = repo) => exec('git', args, { cwd, windowsHide: true });
  const scoped = action => runWithToolContext(action, { workspaceRoot: repo });
  try {
    await fs.mkdir(repo);
    await git(['init', '-b', 'main']);
    await git(['config', 'core.autocrlf', 'false']);
    await git(['config', 'user.name', 'Fixture']);
    await git(['config', 'user.email', 'fixture@example.invalid']);
    await write(repo, '.gitignore', '.env*\n!.env.example\nnode_modules/\nvendor/\ndist/\n.worktrees/\n');
    await write(repo, '.env.example', 'FIXTURE=template\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'fixture']);
    await git(['worktree', 'add', '-b', 'fixture-target', target]);
    await run({ root, repo, target, git, scoped });
  } finally {
    mock.restoreAll();
    if (home === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = home;
    resetMinnowHomeCache();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

test('copies only ignored local dev/test files at root and nested paths as independent private bytes', async () => {
  await fixture(async f => {
    const bytes = Buffer.from('\uFEFFFIXTURE=local-only\r\nMULTILINE="one\r\ntwo"\r\n');
    for (const name of names) await write(f.repo, name, bytes);
    await write(f.repo, 'apps/web package/配置/.env.local', bytes);
    for (const file of ['.env.production', '.env.production.local', '.env.staging', '.env.signing',
      '.env.custom', 'node_modules/pkg/.env', 'vendor/pkg/.env', 'dist/.env', 'build/.env', '.worktrees/old/.env']) {
      await write(f.repo, file, 'FIXTURE=must-not-copy');
    }
    const result = await prepareWorktreeEnvironment(f.repo, f.target);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.copied.length, names.length + 1);
    assert.equal(JSON.stringify(result).includes('local-only'), false);
    for (const file of result.copied) {
      assert.deepEqual(await fs.readFile(path.join(f.target, file)), bytes);
      assert.equal((await fs.lstat(path.join(f.target, file))).isSymbolicLink(), false);
      if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.target, file))).mode & 0o777, 0o600);
    }
    assert.equal((await f.git(['status', '--porcelain'], f.target)).stdout, '');
    assert.equal(await exists(path.join(f.target, '.env.production')), false);
    assert.equal(await exists(path.join(f.target, 'node_modules')), false);
    assert.equal(await fs.readFile(path.join(f.target, '.env.example'), 'utf8'), 'FIXTURE=template\n');
    await fs.writeFile(path.join(f.target, '.env'), 'worktree edit');
    assert.deepEqual(await fs.readFile(path.join(f.repo, '.env')), bytes);
    await fs.writeFile(path.join(f.repo, '.env.local'), 'source edit');
    assert.deepEqual(await fs.readFile(path.join(f.target, '.env.local')), bytes);
  });
});

test('preserves existing and tracked destination files; retries seed newly missing files only', async () => {
  await fixture(async f => {
    await write(f.repo, '.env', 'source');
    await write(f.repo, '.env.local', 'source-local');
    await write(f.target, '.env', 'worktree-specific');
    await write(f.target, '.env.local', 'tracked-branch-env');
    await f.git(['add', '-f', '.env.local'], f.target);
    await f.git(['commit', '-m', 'branch environment'], f.target);
    const first = await prepareWorktreeEnvironment(f.repo, f.target);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.copied.length, 0);
    assert.equal(await fs.readFile(path.join(f.target, '.env'), 'utf8'), 'worktree-specific');
    assert.equal(await fs.readFile(path.join(f.target, '.env.local'), 'utf8'), 'tracked-branch-env');
    await write(f.repo, 'services/new/.env.test', 'later');
    assert.equal((await prepareWorktreeEnvironment(f.repo, f.target)).ok, true);
    assert.equal(await fs.readFile(path.join(f.target, 'services/new/.env.test'), 'utf8'), 'later');
  });
});

test('does not copy nonignored files and does not expose dotenv values in unsafe-destination failures', async () => {
  await fixture(async f => {
    await write(f.repo, '.gitignore', '.env.local\n');
    await write(f.repo, '.env', 'not ignored');
    await write(f.repo, '.env.local', 'FIXTURE_SECRET=never-in-results');
    await write(f.target, '.gitignore', '');
    const failure = await prepareWorktreeEnvironment(f.repo, f.target);
    assert.equal(failure.ok, false);
    assert.match(failure.failed[0].reason, /does not ignore/);
    assert.equal(JSON.stringify(failure).includes('never-in-results'), false);
    assert.equal(await exists(path.join(f.target, '.env')), false);
    assert.equal(await exists(path.join(f.target, '.env.local')), false);
    await write(f.target, '.gitignore', '.env.local\n');
    assert.equal((await prepareWorktreeEnvironment(f.repo, f.target)).ok, true);
    assert.equal(await exists(path.join(f.target, '.env')), false);
  });
});

test('rejects unrelated repositories and self-copy without leaking or writing environment bytes', async () => {
  await fixture(async f => {
    await write(f.repo, '.env', 'fixture-secret');
    assert.equal((await prepareWorktreeEnvironment(f.repo, f.repo)).ok, false);
    const other = path.join(f.root, 'other');
    await fs.mkdir(other);
    await f.git(['init'], other);
    const failure = await prepareWorktreeEnvironment(f.repo, other);
    assert.equal(failure.ok, false);
    assert.match(failure.failed[0].reason, /same repository/);
    assert.equal(await exists(path.join(other, '.env')), false);
  });
});

test('concurrent preparation publishes a complete file exactly once and removes temporary files', async () => {
  await fixture(async f => {
    await write(f.repo, '.env', 'FIXTURE=concurrent\n'.repeat(1000));
    const results = await Promise.all(Array.from({ length: 5 }, () => prepareWorktreeEnvironment(f.repo, f.target)));
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    assert.equal(results.reduce((sum, result) => sum + result.copied.length, 0), 1);
    assert.deepEqual(await fs.readFile(path.join(f.repo, '.env')), await fs.readFile(path.join(f.target, '.env')));
    assert.equal((await fs.readdir(f.target)).some(name => name.startsWith('.minnow-env-')), false);
    const exclude = (await f.git(['rev-parse', '--git-path', 'info/exclude'], f.target)).stdout.trim();
    assert.match(await fs.readFile(path.resolve(f.target, exclude), 'utf8'), /\.minnow-env-\*\.tmp/);
  });
});

test('publication errors are sanitized, clean up private temporary bytes, and allow retry', async () => {
  await fixture(async f => {
    await write(f.repo, '.env', 'FIXTURE=never-in-errors');
    mock.method(fs, 'link', async () => { throw Object.assign(new Error('FIXTURE=never-in-errors'), { code: 'EIO' }); });
    const failure = await prepareWorktreeEnvironment(f.repo, f.target);
    assert.equal(failure.ok, false);
    assert.match(failure.failed[0].reason, /EIO/);
    assert.equal(JSON.stringify(failure).includes('never-in-errors'), false);
    assert.equal(await exists(path.join(f.target, '.env')), false);
    assert.equal((await fs.readdir(f.target)).some(name => name.startsWith('.minnow-env-')), false);
    mock.restoreAll();
    assert.equal((await prepareWorktreeEnvironment(f.repo, f.target)).ok, true);
  });
});

test('cancellation before and during publication leaves no destination or temporary file', async () => {
  await fixture(async f => {
    await write(f.repo, '.env', 'FIXTURE=cancelled');
    const controller = new AbortController(), reason = new Error('fixture cancellation');
    const open = fs.open.bind(fs);
    mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (path.basename(file).startsWith('.minnow-env-')) {
        const sync = handle.sync.bind(handle);
        mock.method(handle, 'sync', async () => { await sync(); controller.abort(reason); });
      }
      return handle;
    });
    await assert.rejects(prepareWorktreeEnvironment(f.repo, f.target, { signal: controller.signal }), error => error === reason);
    assert.equal(await exists(path.join(f.target, '.env')), false);
    assert.equal((await fs.readdir(f.target)).some(name => name.startsWith('.minnow-env-')), false);
    await assert.rejects(prepareWorktreeEnvironment(f.repo, f.target, { signal: controller.signal }), error => error === reason);
  });
});

test('oversize files fail before publication', async () => {
  await fixture(async f => {
    await write(f.repo, '.env', Buffer.alloc(1024 * 1024 + 1, 65));
    const failure = await prepareWorktreeEnvironment(f.repo, f.target);
    assert.equal(failure.ok, false);
    assert.match(failure.failed[0].reason, /1 MiB/);
    assert.equal(await exists(path.join(f.target, '.env')), false);
  });
});

test('does not follow environment-file symlinks or destination directory junctions', async t => {
  await fixture(async f => {
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await write(outside, 'private', 'outside-fixture');
    try { await fs.symlink(path.join(outside, 'private'), path.join(f.repo, '.env'), 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) t.diagnostic('File symlink unavailable; directory-junction boundary still checked below.');
      else throw error;
    }
    if (await exists(path.join(f.repo, '.env'))) {
      const linked = await prepareWorktreeEnvironment(f.repo, f.target);
      assert.equal(linked.ok, false);
      assert.equal(await exists(path.join(f.target, '.env')), false);
      await fs.unlink(path.join(f.repo, '.env'));
    }
    await write(f.repo, 'apps/web/.env.local', 'nested');
    await fs.mkdir(path.join(f.target, 'apps'));
    await fs.symlink(outside, path.join(f.target, 'apps/web'), process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = await prepareWorktreeEnvironment(f.repo, f.target);
    assert.equal(escaped.ok, false);
    assert.equal(await exists(path.join(outside, '.env.local')), false);
    assert.equal(await fs.readFile(path.join(outside, 'private'), 'utf8'), 'outside-fixture');
  });
});

test('chat, canonical, direct, existing-branch, board, and Source Control creation inherit environments', async () => {
  await fixture(async f => {
    await write(f.repo, '.env', 'FIXTURE=source');
    await write(f.repo, 'apps/web/.env.local', 'FIXTURE=nested');
    let bound = false;
    const canonical = await f.scoped(() => enableChatWorktree({ chatId: 'canonical', title: 'Canonical fixture',
      onCheckout: async checkout => {
        assert.equal(await exists(path.join(checkout.path, '.env')), false, 'bind before copying or installers');
        bound = true;
      } }));
    assert.ok(bound);
    const automatic = await f.scoped(() => enableChatWorktree({ chatId: 'automatic', title: 'Automatic fixture' }));
    const direct = await f.scoped(() => createChatWorktree({ chatId: 'direct', branch: 'fixture-direct' }));
    await f.git(['branch', 'fixture-existing']);
    const existing = await f.scoped(() => createChatWorktree({ chatId: 'existing', branch: 'fixture-existing', checkoutExisting: true }));
    const integration = await f.scoped(() => ensureIntegration({ boardId: 'fixture-board', branch: 'fixture-integration' }));
    const task = await f.scoped(() => createWorktree({ boardId: 'fixture-board', slotId: 'task', branch: 'fixture-task', baseRef: 'fixture-integration' }));
    const scc = await worktreeAdd({ cwd: f.repo, branch: 'fixture-scc', path: path.join(f.root, 'source-control') });
    for (const result of [canonical, automatic, direct, existing, integration, task, scc]) {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(await fs.readFile(path.join(result.path, '.env'), 'utf8'), 'FIXTURE=source');
      assert.equal(await fs.readFile(path.join(result.path, 'apps/web/.env.local'), 'utf8'), 'FIXTURE=nested');
      assert.equal((await f.git(['status', '--porcelain'], result.path)).stdout, '');
    }
    await fs.writeFile(path.join(direct.path, '.env'), 'direct-specific');
    const reused = await f.scoped(() => createChatWorktree({ chatId: 'direct', branch: 'fixture-direct' }));
    assert.equal(reused.ok, true);
    assert.equal(await fs.readFile(path.join(direct.path, '.env'), 'utf8'), 'direct-specific');
  });
});

test('canonical setup copies dotenv before package lifecycle scripts and retries preserve local edits', async () => {
  await fixture(async f => {
    await write(f.repo, 'package.json', JSON.stringify({ name: 'env-install-fixture', version: '1.0.0', private: true,
      scripts: { install: 'node --env-file=.env install.cjs' } }));
    await write(f.repo, 'install.cjs', "if (process.env.FIXTURE !== 'installer') process.exit(1); require('node:fs').writeFileSync('install-proof', 'ok');");
    await f.git(['add', 'package.json', 'install.cjs']);
    await f.git(['commit', '-m', 'installer']);
    await write(f.repo, '.env', 'FIXTURE=installer\n');
    const result = await f.scoped(() => enableChatWorktree({ chatId: 'install', title: 'Install fixture', onCheckout: async () => {} }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(result.path, 'install-proof'), 'utf8'), 'ok');
    await fs.writeFile(path.join(result.path, '.env'), 'FIXTURE=installer\nWORKTREE_ONLY=yes\n');
    const reused = await f.scoped(() => enableChatWorktree({ chatId: 'install', title: 'Install fixture', onCheckout: async () => {} }));
    assert.equal(reused.ok, true, JSON.stringify(reused));
    assert.match(await fs.readFile(path.join(result.path, '.env'), 'utf8'), /WORKTREE_ONLY/);
    assert.equal(await fs.readFile(path.join(f.repo, '.env'), 'utf8'), 'FIXTURE=installer\n');
  });
});

test('explicit prepare_chat repairs older worktrees and environment failure blocks installers until retry', async () => {
  await fixture(async f => {
    await write(f.repo, 'package.json', JSON.stringify({ name: 'blocked-install-fixture', version: '1.0.0', private: true,
      scripts: { install: 'node --env-file=.env install.cjs' } }));
    await write(f.repo, 'install.cjs', "require('node:fs').writeFileSync('install-proof', 'ok');");
    await f.git(['add', 'package.json', 'install.cjs']);
    await f.git(['commit', '-m', 'installer']);
    const allocated = await f.scoped(() => createChatWorktree({ chatId: 'repair', branch: 'fixture-repair', prepareDependencies: false }));
    await write(f.repo, '.env', 'FIXTURE=repair');
    await write(allocated.path, '.gitignore', '');
    const failed = await f.scoped(() => enableChatWorktree({ chatId: 'repair', title: 'Repair', onCheckout: async () => {} }));
    assert.equal(failed.ok, false);
    assert.match(failed.error, /environment/);
    assert.equal(await exists(path.join(allocated.path, 'install-proof')), false);
    await write(allocated.path, '.gitignore', '.env*\n');
    const server = http.createServer((req, res) => {
      void f.scoped(() => handleWorktreeRequest(req, res, '/api/worktree'));
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/worktree', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'prepare_chat', chatId: 'repair' }),
      });
      const prepared = await response.json();
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      assert.equal(await fs.readFile(path.join(allocated.path, 'install-proof'), 'utf8'), 'ok');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

test('empty environments are a no-op and Git failures do not expose diagnostic output', async () => {
  await fixture(async f => {
    assert.deepEqual(await prepareWorktreeEnvironment(f.repo, f.target), { ok: true, copied: [], skipped: [], failed: [] });
    const nonrepo = path.join(f.root, 'not-a-repository');
    await fs.mkdir(nonrepo);
    const failure = await prepareWorktreeEnvironment(nonrepo, f.target);
    assert.equal(failure.ok, false);
    assert.equal(failure.failed[0].reason, 'Cannot inspect local environment files with Git.');
  });
});

test('environment count limits fail without publishing a partial setup', async () => {
  await fixture(async f => {
    for (let index = 0; index < 513; index++) await write(f.repo, 'packages/p' + index + '/.env', 'FIXTURE=count');
    const failure = await prepareWorktreeEnvironment(f.repo, f.target);
    assert.equal(failure.ok, false);
    assert.match(failure.failed[0].reason, /512/);
    assert.deepEqual(failure.copied, []);
    assert.equal(await exists(path.join(f.target, 'packages')), false);
  });
});

test('a source modified during reading is rejected without publishing it', async () => {
  await fixture(async f => {
    await write(f.repo, '.env', 'FIXTURE=before');
    const open = fs.open.bind(fs);
    mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === path.join(f.repo, '.env')) {
        const read = handle.read.bind(handle);
        let changed = false;
        mock.method(handle, 'read', async (...readArgs) => {
          const result = await read(...readArgs);
          if (!changed) { changed = true; await fs.writeFile(file, 'FIXTURE=changed-and-longer'); }
          return result;
        });
      }
      return handle;
    });
    const failure = await prepareWorktreeEnvironment(f.repo, f.target);
    assert.equal(failure.ok, false);
    assert.match(failure.failed[0].reason, /changed during setup/);
    assert.equal(await exists(path.join(f.target, '.env')), false);
  });
});

test('private staging stays ignored even when a source repository ignores only the exact dotenv name', async () => {
  await fixture(async f => {
    await write(f.repo, '.gitignore', '.env\n');
    await write(f.target, '.gitignore', '.env\n');
    await write(f.repo, '.env', 'FIXTURE=staging');
    const link = fs.link.bind(fs);
    mock.method(fs, 'link', async (temporary, destination) => {
      assert.equal((await f.git(['check-ignore', '--', path.basename(temporary)], f.target)).stdout.trim(), path.basename(temporary));
      assert.equal((await f.git(['ls-files', '--others', '--exclude-standard'], f.target)).stdout, '');
      return link(temporary, destination);
    });
    assert.equal((await prepareWorktreeEnvironment(f.repo, f.target)).ok, true);
    const exclude = (await f.git(['rev-parse', '--git-path', 'info/exclude'], f.target)).stdout.trim();
    assert.match(await fs.readFile(path.resolve(f.target, exclude), 'utf8'), /\.minnow-env-\*\.tmp/);
  });
});

test('board task environment failures do not fall back to a different checkout configuration', async () => {
  await fixture(async f => {
    await write(f.repo, '.env', 'FIXTURE=workspace');
    const integration = await f.scoped(() => ensureIntegration({ boardId: 'failure-board', branch: 'fixture-failure-integration' }));
    assert.equal(integration.ok, true);
    await write(integration.path, '.env', Buffer.alloc(1024 * 1024 + 1, 65));
    const input = { boardId: 'failure-board', slotId: 'failure-task', branch: 'fixture-failure-task', baseRef: 'fixture-failure-integration' };
    const failed = await f.scoped(() => createWorktree(input));
    assert.equal(failed.ok, false);
    assert.match(failed.output, /1 MiB/);
    assert.equal(await exists(path.join(failed.path, '.env')), false, 'source fallback would conceal integration configuration failure');
    await write(integration.path, '.env', 'FIXTURE=integration');
    const retried = await f.scoped(() => createWorktree(input));
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(await fs.readFile(path.join(retried.path, '.env'), 'utf8'), 'FIXTURE=integration');
  });
});

test('task base synchronization checks the final ignore rules before copying local credentials', async () => {
  await fixture(async f => {
    const existing = { boardId: 'sync-board', slotId: 'existing-slot', branch: 'fixture-existing-slot' };
    assert.equal((await f.scoped(() => createWorktree(existing))).ok, true);
    await f.git(['branch', 'fixture-reopened-branch']);
    await f.git(['checkout', '-b', 'unignored-base']);
    await write(f.repo, '.gitignore', '');
    await f.git(['add', '.gitignore']);
    await f.git(['commit', '-m', 'different environment policy']);
    await f.git(['checkout', 'main']);
    await write(f.repo, '.env', 'FIXTURE=must-stay-ignored');
    const reopened = { boardId: 'sync-board', slotId: 'new-slot', branch: 'fixture-reopened-branch' };
    for (const input of [existing, reopened]) {
      const failure = await f.scoped(() => createWorktree({ ...input, baseRef: 'unignored-base' }));
      assert.equal(failure.ok, false, JSON.stringify(failure));
      assert.match(failure.output, /does not ignore/);
      assert.equal(await exists(path.join(failure.path, '.env')), false);
    }
  });
});

test('nested ignore overrides cannot expose private staging bytes to Git', async () => {
  await fixture(async f => {
    await write(f.repo, 'apps/web/.env', 'FIXTURE=nested-private');
    await write(f.target, 'apps/web/.gitignore', '.env\n!.minnow-env-*.tmp\n');
    const failure = await prepareWorktreeEnvironment(f.repo, f.target);
    assert.equal(failure.ok, false);
    assert.match(failure.failed[0].reason, /protect private environment staging/);
    assert.equal(await exists(path.join(f.target, 'apps/web/.env')), false);
    assert.equal((await fs.readdir(path.join(f.target, 'apps/web'))).some(file => file.startsWith('.minnow-env-')), false);
  });
});

test('npm workspace installation sees inherited dotenv before its lifecycle script executes', async () => {
  await fixture(async f => {
    await write(f.repo, 'package.json', JSON.stringify({ name: 'env-workspace-fixture', private: true, version: '1.0.0',
      workspaces: ['packages/*'], scripts: { postinstall: 'node --env-file=.env install.cjs' } }));
    await write(f.repo, 'packages/core/package.json', JSON.stringify({ name: 'env-workspace-core', version: '1.0.0', private: true }));
    await write(f.repo, 'install.cjs', "if (process.env.FIXTURE !== 'workspace') process.exit(1); require('node:fs').writeFileSync('install-proof', 'ok');");
    await f.git(['add', 'package.json', 'packages', 'install.cjs']);
    await f.git(['commit', '-m', 'workspace installer']);
    await write(f.repo, '.env', 'FIXTURE=workspace\n');
    const result = await f.scoped(() => createChatWorktree({ chatId: 'workspace-install', branch: 'fixture-workspace-install' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(result.path, 'install-proof'), 'utf8'), 'ok');
    assert.equal(await exists(path.join(f.repo, 'install-proof')), false);
  });
});


