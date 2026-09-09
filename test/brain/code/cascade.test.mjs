/**
 * MIN-B10 — cascade Merkle staleness, incremental reindex, triggers.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache } from '../../../server/config/home.js';
import { invalidateLspConfigCache } from '../../../server/lsp/config-loader.js';
import { shutdownAllLsp } from '../../../server/lsp/manager.js';
import {
  awaitReindexJobForTests,
  diffMerkleEntries,
  detectStaleFiles,
  ensureIndexFreshForQuery,
  LAZY_INLINE_REFRESH_MAX_FILES,
  getChangedFilesFromGit,
  installGitHook,
  isCascadeTriggerEnabled,
  merkleLeafHash,
  merkleRootFromEntries,
  propagateCodeChanges,
  runCascade,
  uninstallGitHook,
} from '../../../server/brain/code/cascade.js';
import { reindexCode } from '../../../server/brain/code/indexer.js';
import { findSymbol, repoMap } from '../../../server/brain/code/query.js';
import { closeCodeDbForTests, getCodeDb } from '../../../server/brain/code/schema.js';
import { brainWorkspaceKeyFromPath } from '../../../server/brain/paths.js';
import { setWorkspaceRoot } from '../../../server/workspace/root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SAMPLE_PATH = 'sample.fake';
const SAMPLE_TEXT = [
  'export const MY_EXPORT = 42;',
  'function callee() { return 1; }',
  'function caller() {',
  '  callee();',
  '}',
].join('\n');

async function seedFakeLspHome(homeDir) {
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  invalidateLspConfigCache();
  shutdownAllLsp();
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, 'lsp.json'),
    `${JSON.stringify(
      {
        enabled: true,
        servers: {
          fake: {
            command: 'node',
            args: [path.join(PROJECT_ROOT, 'test/fixtures/fake-lsp.mjs')],
            filetypes: ['fake'],
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(homeDir, 'config.json'),
    JSON.stringify({ brain: { code: { enabled: true, reindexCadence: 'git-hook' } } }, null, 2),
    'utf8',
  );
}

describe('MIN-B10 cascade', () => {
  let homeDir;
  let workspaceDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-b10-cascade-'));
    workspaceDir = path.join(homeDir, 'ws');
    await seedFakeLspHome(homeDir);
    await fs.mkdir(workspaceDir, { recursive: true });
    await setWorkspaceRoot(workspaceDir);
    const abs = path.join(workspaceDir, SAMPLE_PATH);
    await fs.writeFile(abs, SAMPLE_TEXT, 'utf8');
  });

  after(async () => {
    shutdownAllLsp();
    closeCodeDbForTests();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('merkle root changes only when a leaf hash changes', () => {
    const before = [
      { file: 'a.fake', hash: 'aaa' },
      { file: 'b.fake', hash: 'bbb' },
    ];
    const after = [
      { file: 'a.fake', hash: 'aaa' },
      { file: 'b.fake', hash: 'changed' },
    ];
    const rootBefore = merkleRootFromEntries(before);
    const rootAfter = merkleRootFromEntries(after);
    assert.notEqual(rootBefore, rootAfter);

    const beforeMap = new Map(before.map((row) => [row.file, row.hash]));
    const afterMap = new Map(after.map((row) => [row.file, row.hash]));
    assert.deepEqual(diffMerkleEntries(beforeMap, afterMap), ['b.fake']);
    assert.equal(merkleLeafHash('x.ts', 'deadbeef'), merkleLeafHash('x.ts', 'deadbeef'));
  });

  it('incremental reindex updates only the changed file branch', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const db = getCodeDb(repo);

    await reindexCode({ files: [SAMPLE_PATH] });
    const symbolCountAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM symbols').get().n;
    const hashAfterFirst = db
      .prepare('SELECT sha256 FROM file_hashes WHERE repo = ? AND file = ?')
      .get(repo, SAMPLE_PATH)?.sha256;

    const abs = path.join(workspaceDir, SAMPLE_PATH);
    await fs.writeFile(abs, `${SAMPLE_TEXT}\n// cascade marker\n`, 'utf8');

    const result = await propagateCodeChanges({
      files: [SAMPLE_PATH],
      focusFiles: [SAMPLE_PATH],
      trigger: 'manual',
    });

    assert.equal(result.indexedFiles, 1);
    assert.equal(result.results?.length, 1);
    assert.equal(result.results?.[0]?.file, SAMPLE_PATH);

    const hashAfterSecond = db
      .prepare('SELECT sha256 FROM file_hashes WHERE repo = ? AND file = ?')
      .get(repo, SAMPLE_PATH)?.sha256;
    assert.notEqual(hashAfterFirst, hashAfterSecond);
    assert.ok(symbolCountAfterFirst > 0);
    assert.ok(result.merkleRoot);

    await fs.writeFile(abs, SAMPLE_TEXT, 'utf8');
    await propagateCodeChanges({ files: [SAMPLE_PATH], trigger: 'manual' });
  });

  it('lazy hash-check refreshes stale slice before find_symbol answers', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const db = getCodeDb(repo);
    const abs = path.join(workspaceDir, SAMPLE_PATH);

    await reindexCode({ files: [SAMPLE_PATH] });
    const beforeHash = db
      .prepare('SELECT sha256 FROM file_hashes WHERE repo = ? AND file = ?')
      .get(repo, SAMPLE_PATH)?.sha256;

    await fs.writeFile(abs, `${SAMPLE_TEXT}\n// lazy query marker\n`, 'utf8');
    const stale = await detectStaleFiles();
    assert.ok(stale.changedFiles.includes(SAMPLE_PATH));

    const { matches } = await findSymbol('callee', 5);
    assert.ok(matches.some((m) => m.name === 'callee'));

    const afterHash = db
      .prepare('SELECT sha256 FROM file_hashes WHERE repo = ? AND file = ?')
      .get(repo, SAMPLE_PATH)?.sha256;
    assert.notEqual(beforeHash, afterHash);

    const staleAfter = await detectStaleFiles({ discoverNewFiles: false });
    assert.ok(!staleAfter.changedFiles.includes(SAMPLE_PATH));

    await fs.writeFile(abs, SAMPLE_TEXT, 'utf8');
    await propagateCodeChanges({ files: [SAMPLE_PATH], trigger: 'manual' });
  });

  /**
   * `git worktree add` — which every orchestrator board attempt runs — rewrites the mtime
   * of every file while the bytes stay identical. Treating that as a change marked the
   * whole tree stale and re-parsed it through the LSP, stalling the attempt's first tool
   * call for minutes. Content hash decides; mtime is only a fast path.
   */
  it('a fresh mtime with identical bytes is not a change', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const db = getCodeDb(repo);
    const abs = path.join(workspaceDir, SAMPLE_PATH);

    await fs.writeFile(abs, SAMPLE_TEXT, 'utf8');
    await reindexCode({ files: [SAMPLE_PATH] });
    const before = db
      .prepare('SELECT sha256, mtime_ms FROM file_hashes WHERE repo = ? AND file = ?')
      .get(repo, SAMPLE_PATH);

    const future = new Date(Date.now() + 60_000);
    await fs.utimes(abs, future, future);

    const stale = await detectStaleFiles({ discoverNewFiles: false });
    assert.ok(!stale.changedFiles.includes(SAMPLE_PATH));
    assert.ok(stale.mtimeOnlyFiles >= 1);

    const after = db
      .prepare('SELECT sha256, mtime_ms FROM file_hashes WHERE repo = ? AND file = ?')
      .get(repo, SAMPLE_PATH);
    assert.equal(after.sha256, before.sha256);
    assert.notEqual(after.mtime_ms, before.mtime_ms);

    // The re-stamped mtime must restore the cheap fast path, or every later query
    // re-hashes the whole tree forever.
    const again = await detectStaleFiles({ discoverNewFiles: false });
    assert.equal(again.mtimeOnlyFiles, 0);
    assert.ok(!again.changedFiles.includes(SAMPLE_PATH));
  });

  it('git-hook path reindexes exactly the provided changed files', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const db = getCodeDb(repo);
    const abs = path.join(workspaceDir, SAMPLE_PATH);

    await reindexCode({ files: [SAMPLE_PATH] });
    await fs.writeFile(abs, `${SAMPLE_TEXT}\n// git hook marker\n`, 'utf8');

    const result = await runCascade({
      trigger: 'git-hook',
      files: [SAMPLE_PATH],
      force: true,
    });

    assert.equal(result.skipped, false);
    assert.equal(result.indexedFiles, 1);
    assert.equal(result.results?.[0]?.file, SAMPLE_PATH);
    assert.ok(db.prepare('SELECT sha256 FROM file_hashes WHERE repo = ? AND file = ?').get(repo, SAMPLE_PATH));

    await fs.writeFile(abs, SAMPLE_TEXT, 'utf8');
    await propagateCodeChanges({ files: [SAMPLE_PATH], trigger: 'manual' });
  });

  it('purges index rows when a file is deleted and repo map omits the path', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const db = getCodeDb(repo);
    const abs = path.join(workspaceDir, SAMPLE_PATH);

    await fs.writeFile(abs, SAMPLE_TEXT, 'utf8');
    await reindexCode({ files: [SAMPLE_PATH] });
    assert.ok(
      db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE repo = ? AND file = ?').get(repo, SAMPLE_PATH).n > 0,
    );
    assert.ok(db.prepare('SELECT sha256 FROM file_hashes WHERE repo = ? AND file = ?').get(repo, SAMPLE_PATH));

    await fs.unlink(abs);
    await reindexCode({ files: [SAMPLE_PATH] });

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE repo = ? AND file = ?').get(repo, SAMPLE_PATH).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM file_hashes WHERE repo = ? AND file = ?').get(repo, SAMPLE_PATH).n,
      0,
    );

    const map = await repoMap({ focus: SAMPLE_PATH });
    assert.ok(!map.text.includes('## sample.fake'));
    assert.ok(!map.text.includes('callee'));
  });

  it('cadence gating skips automatic triggers when disabled', () => {
    const onDemand = { reindexCadence: 'on-demand', enabled: true };
    assert.equal(isCascadeTriggerEnabled('git-hook', onDemand), false);
    assert.equal(isCascadeTriggerEnabled('workspace-switch', onDemand), false);
    assert.equal(isCascadeTriggerEnabled('manual', onDemand), true);
    assert.equal(isCascadeTriggerEnabled('lazy-query', onDemand), true);

    const gitHook = { reindexCadence: 'git-hook', enabled: true };
    assert.equal(isCascadeTriggerEnabled('git-hook', gitHook), true);
  });

  it('installs and removes the post-commit hook block', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init'], { cwd: workspaceDir, windowsHide: true });

    const gitDir = path.join(workspaceDir, '.git');
    const hooksDir = path.join(gitDir, 'hooks');
    const hookPath = path.join(hooksDir, 'post-commit');
    let original = null;
    try {
      original = await fs.readFile(hookPath, 'utf8');
    } catch {
      original = null;
    }

    const installed = await installGitHook(workspaceDir);
    assert.equal(installed.installed, true);
    const content = await fs.readFile(hookPath, 'utf8');
    assert.match(content, /minnow-brain-cascade-hook/);

    const removed = await uninstallGitHook(workspaceDir);
    assert.equal(removed.removed, true);

    if (original != null) {
      await fs.writeFile(hookPath, original, 'utf8');
    } else {
      await fs.unlink(hookPath).catch(() => {});
    }
  });

  it('getChangedFilesFromGit returns paths from HEAD', async () => {
    const files = await getChangedFilesFromGit(PROJECT_ROOT);
    assert.ok(Array.isArray(files));
  });
  /**
   * A code tool is blocked on this call. A slice large enough to be a full reindex must go
   * to the detached job — holding the caller was how `repo_map` wedged a board attempt.
   */
  it('a large stale slice defers to the background job instead of blocking', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const previous = process.env.MINNOW_BRAIN_INDEX_IN_PROCESS;
    process.env.MINNOW_BRAIN_INDEX_IN_PROCESS = '1';

    const bulkDir = path.join(workspaceDir, 'bulk');
    await fs.mkdir(bulkDir, { recursive: true });
    const many = [];
    for (let i = 0; i < LAZY_INLINE_REFRESH_MAX_FILES + 5; i += 1) {
      const rel = `bulk/f${i}.fake`;
      many.push(rel);
      await fs.writeFile(path.join(workspaceDir, rel), `export const V${i} = ${i};
`, 'utf8');
    }

    try {
      await reindexCode({ files: many });
      for (let i = 0; i < many.length; i += 1) {
        await fs.writeFile(
          path.join(workspaceDir, many[i]),
          `export const V${i} = ${i};
// changed
`,
          'utf8',
        );
      }

      const stale = await detectStaleFiles({ discoverNewFiles: false });
      assert.ok(stale.changedFiles.length > LAZY_INLINE_REFRESH_MAX_FILES);

      const refresh = await ensureIndexFreshForQuery();
      assert.equal(refresh.deferred, true);
      assert.equal(refresh.refreshed, false);
      assert.equal(refresh.job?.started, true);

      await awaitReindexJobForTests(repo);
    } finally {
      if (previous === undefined) {
        delete process.env.MINNOW_BRAIN_INDEX_IN_PROCESS;
      } else {
        process.env.MINNOW_BRAIN_INDEX_IN_PROCESS = previous;
      }
      await fs.rm(bulkDir, { recursive: true, force: true });
      await reindexCode({ files: many }).catch(() => {});
    }
  });
});
