/**
 * MIN-B9 — symbol anchors, the read_symbol bridge, anchor drift, cross-repo resolve.
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
  explainSymbol,
  resolveAnchorsToCode,
} from '../../../server/brain/code/anchors.js';
import {
  normalizeIndexableRelPath,
  reindexCode,
} from '../../../server/brain/code/indexer.js';
import { closeCodeDbForTests, getCodeDb, upsertSymbol } from '../../../server/brain/code/schema.js';
import { brainWorkspaceKeyFromPath } from '../../../server/brain/paths.js';
import { lintBrainWiki } from '../../../server/brain/lint.js';
import { createPage, ensureBrainStore, readPage, rebuildCatalog } from '../../../server/brain/store.js';
import { executeServerTool } from '../../../server/runtime/tools-middleware.js';
import { setWorkspaceRoot } from '../../../server/workspace/root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SAMPLE_PATH = 'sample.fake';
const PAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
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
    JSON.stringify({ brain: { code: { enabled: true } } }, null, 2),
    'utf8',
  );
}

describe('MIN-B9 bridge anchors', () => {
  let homeDir;
  let workspaceDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-b9-bridge-'));
    workspaceDir = path.join(homeDir, 'ws');
    await seedFakeLspHome(homeDir);
    await ensureBrainStore();
    await fs.mkdir(workspaceDir, { recursive: true });
    await setWorkspaceRoot(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, SAMPLE_PATH), SAMPLE_TEXT, 'utf8');
    await reindexCode({ files: [SAMPLE_PATH] });
  });

  after(async () => {
    shutdownAllLsp();
    // Let fake-lsp child handles close on Windows before temp dir removal (UV_HANDLE_CLOSING).
    await new Promise((resolve) => setTimeout(resolve, 200));
    closeCodeDbForTests();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('read_symbol names the wiki pages that anchor the symbol', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const symbolId = `${repo}:MY_EXPORT.callee`;

    await createPage({
      relPath: 'facts/callee-design.md',
      id: PAGE_ID,
      title: 'Callee design note',
      summary: 'Why callee exists.',
      anchors: [symbolId],
      body: 'Design rationale for callee.',
      skipVectorSync: true,
    });

    const { pages, symbolId: resolved } = await explainSymbol(symbolId);
    assert.equal(resolved, symbolId);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].path, 'facts/callee-design.md');
    assert.equal(pages[0].title, 'Callee design note');

    // The anchor bridge is no longer its own tool: read_symbol carries it.
    const toolOut = await executeServerTool('read_symbol', { symbol: 'callee' });
    assert.match(toolOut.result, /Explained in Brain/);
    assert.match(toolOut.result, /facts\/callee-design\.md/);
  });

  it('anchor drift flags page stale after symbol content_hash changes', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const symbolId = `${repo}:caller`;
    const db = getCodeDb(repo);

    await createPage({
      relPath: 'facts/caller-design.md',
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      title: 'Caller drift test',
      anchors: [symbolId],
      body: 'Anchored before drift.',
      skipVectorSync: true,
    });

    const anchorRow = db
      .prepare('SELECT symbol_hash_at_synth FROM anchors WHERE page_id = ? AND symbol_id = ?')
      .get('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', symbolId);
    assert.ok(anchorRow?.symbol_hash_at_synth);

    db.prepare('UPDATE symbols SET content_hash = ? WHERE id = ?').run('deadbeef'.repeat(8), symbolId);

    const report = await lintBrainWiki({ includeLlm: false });
    assert.ok(report.anchorDrift?.length >= 1);
    assert.ok(report.stale.some((p) => p.path === 'facts/caller-design.md'));

    const page = await readPage('facts/caller-design.md');
    assert.equal(page.meta.status, 'stale');
  });

  it('cross-repo anchors resolve via read_symbol', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const db = getCodeDb(repo);
    const tsId = 'frontend:dispatchTelemetry';
    const pyId = 'backend:telemetry.dispatch';

    upsertSymbol(db, {
      id: tsId,
      repo: 'frontend',
      kind: 'function',
      name: 'dispatchTelemetry',
      file: 'src/telemetry.ts',
      line_start: 1,
      line_end: 2,
      signature: 'function dispatchTelemetry()',
      doc: '',
      content_hash: 'abc',
      pagerank: 0,
      usage_count: 0,
    });
    upsertSymbol(db, {
      id: pyId,
      repo: 'backend',
      kind: 'function',
      name: 'dispatch',
      file: 'telemetry/dispatch.py',
      line_start: 1,
      line_end: 3,
      signature: 'def dispatch()',
      doc: '',
      content_hash: 'def',
      pagerank: 0,
      usage_count: 0,
    });

    const tsRel = 'cross-repo-ts.fake';
    const pyRel = 'cross-repo-py.fake';
    await fs.writeFile(path.join(workspaceDir, tsRel), 'export function dispatchTelemetry() {}\n', 'utf8');
    await fs.writeFile(path.join(workspaceDir, pyRel), 'def dispatch():\n    return 1\n', 'utf8');

    db.prepare('UPDATE symbols SET file = ? WHERE id = ?').run(tsRel, tsId);
    db.prepare('UPDATE symbols SET file = ? WHERE id = ?').run(pyRel, pyId);

    const resolved = await resolveAnchorsToCode([tsId, pyId]);
    assert.equal(resolved.length, 2);
    assert.match(resolved[0].text ?? '', /dispatchTelemetry/);
    assert.match(resolved[1].text ?? '', /def dispatch/);
  });

  it('moving a page keeps anchors keyed by stable page_id', async () => {
    const repo = brainWorkspaceKeyFromPath(workspaceDir);
    const symbolId = `${repo}:MY_EXPORT`;
    const moveId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    await createPage({
      relPath: 'facts/move-me.md',
      id: moveId,
      title: 'Move anchor test',
      anchors: [symbolId],
      body: 'Will move.',
      skipVectorSync: true,
    });

    const pagesDir = path.join(homeDir, 'brain', 'pages');
    await fs.rename(
      path.join(pagesDir, 'facts', 'move-me.md'),
      path.join(pagesDir, 'facts', 'moved-anchor.md'),
    );
    await rebuildCatalog();

    const { pages } = await explainSymbol(symbolId);
    assert.ok(pages.some((p) => p.pageId === moveId));
  });

  it('normalizeIndexableRelPath strips duplicated Windows root prefixes', () => {
    const root = path.resolve('C:/proj/minnow');
    const doubled = `${root.replace(/\\/g, '/')}/${root.replace(/\\/g, '/')}/src/foo.ts`;
    const rel = normalizeIndexableRelPath(root, doubled);
    assert.equal(rel, 'src/foo.ts');
  });
});
