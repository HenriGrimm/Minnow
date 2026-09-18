/**
 * Agent-scoped LSP diagnostics — event-driven settling, disk-only analysis.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { invalidateLspConfigCache } from '../../server/lsp/config-loader.js';
import {
  getLspDiagnostics,
  getLspDocumentSyncForTest,
  resetLspDiagnosticWaitForTest,
  setLspDiagnosticWaitForTest,
  shutdownAllLsp,
} from '../../server/lsp/manager.js';
import { getCachePolicyForTool } from '../../src/tools/tool-cache-policy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
/**
 * Own file, not the shared sample.fake: other LSP suites run concurrently and
 * rewrite that one mid-test. The fake server still errors on any `*sample.fake`.
 */
const SAMPLE_PATH = 'test/fixtures/agent-diag-disk-sample.fake';

async function seedFakeLspHome(homeDir) {
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  invalidateLspConfigCache();
  shutdownAllLsp();
  resetLspDiagnosticWaitForTest();
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, 'lsp.json'),
    `${JSON.stringify(
      {
        enabled: true,
        lsp: {
          fake: {
            disabled: false,
            command: ['node', 'test/fixtures/fake-lsp.mjs'],
            extensions: ['.fake'],
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

describe('agent LSP diagnostics', () => {
  let homeDir;

  before(async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;
    homeDir = path.join(__dirname, '../fixtures/lsp-agent-diag-home');
    await seedFakeLspHome(homeDir);
    setLspDiagnosticWaitForTest({ quietPeriodMs: 80, totalTimeoutMs: 2_000 });
  });

  after(() => {
    shutdownAllLsp();
    resetLspDiagnosticWaitForTest();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
  });

  test('get_lsp_diagnostics is excluded from generic tool cache', () => {
    const policy = getCachePolicyForTool('get_lsp_diagnostics');
    assert.equal(policy.cacheable, false);
    assert.equal(policy.ttlMs, 0);
  });

  test('missing file returns friendly message without ENOENT stack', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;

    shutdownAllLsp();
    const rel = 'test/fixtures/agent-diag-missing-file.fake';
    const result = await getLspDiagnostics(rel);
    assert.match(result, /Error: File not found: test\/fixtures\/agent-diag-missing-file\.fake/);
    assert.doesNotMatch(result, /ENOENT/);
  });

  test('waits for delayed empty then error publications (>200ms)', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;

    shutdownAllLsp();
    const rel = 'test/fixtures/delayed-empty-then-error.fake';
    const result = await getLspDiagnostics(rel);
    assert.match(result, /Delayed semantic error/);
    assert.match(result, /fake/);
  });

  test('confirmed clean after empty publication settles', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;

    shutdownAllLsp();
    const rel = 'test/fixtures/confirmed-clean.fake';
    const result = await getLspDiagnostics(rel);
    assert.match(result, /No LSP diagnostics for test\/fixtures\/confirmed-clean\.fake \(fake\)/);
  });

  test('timeout when server never publishes diagnostics', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;

    shutdownAllLsp();
    setLspDiagnosticWaitForTest({ quietPeriodMs: 50, totalTimeoutMs: 400 });
    const rel = 'test/fixtures/never-publishes.fake';
    const result = await getLspDiagnostics(rel);
    assert.match(result, /No LSP diagnostics for test\/fixtures\/never-publishes\.fake \(fake\)/);
    assert.doesNotMatch(result, /Diagnostics unavailable/);
  });

  test('cold init does not consume diagnostic total timeout before document sync', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;

    shutdownAllLsp();
    setLspDiagnosticWaitForTest({ quietPeriodMs: 50, totalTimeoutMs: 900 });
    const rel = 'test/fixtures/cold-init-ordering.fake';
    const result = await getLspDiagnostics(rel);
    assert.match(result, /Cold init ordering ok/);
    assert.doesNotMatch(result, /Diagnostics unavailable/);
  });

  test('reads saved disk without perturbing editor-scoped sync', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;

    shutdownAllLsp();
    const abs = path.join(PROJECT_ROOT, SAMPLE_PATH);
    await fs.writeFile(abs, 'DISK_CONTENT_FOR_AGENT\n', 'utf8');

    const { notifyLspDocument } = await import('../../server/lsp/manager.js');
    const editorText = 'EDITOR_UNSAVED_BUFFER\n';
    await notifyLspDocument(SAMPLE_PATH, 'open', editorText);

    try {
      const result = await getLspDiagnostics(SAMPLE_PATH);
      assert.match(result, /';' expected/);

      assert.equal(getLspDocumentSyncForTest(SAMPLE_PATH)?.text, editorText);
      assert.equal(
        getLspDocumentSyncForTest(SAMPLE_PATH, 'agent')?.text,
        'DISK_CONTENT_FOR_AGENT\n',
      );
    } finally {
      await fs.rm(abs, { force: true });
    }
  });

  test('reuses revision-matched snapshot on unchanged disk content', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;

    shutdownAllLsp();
    const rel = 'test/fixtures/confirmed-clean.fake';
    const first = await getLspDiagnostics(rel);
    const second = await getLspDiagnostics(rel);
    assert.equal(first, second);
    assert.match(second, /No LSP diagnostics/);
  });
});
