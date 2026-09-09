/**
 * Code index integration — LSP fake server, SQLite, queries (MIN-B7).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resetMinnowHomeCache } from '../../../server/config/home.js';
import { invalidateLspConfigCache } from '../../../server/lsp/config-loader.js';
import { shutdownAllLsp } from '../../../server/lsp/manager.js';
import { closeCodeDbForTests, codeDbPath, getCodeDb } from '../../../server/brain/code/schema.js';
import { brainWorkspaceKeyFromPath } from '../../../server/brain/paths.js';
import { reindexCode } from '../../../server/brain/code/indexer.js';
import { findSymbol, readSymbol, whoCalls } from '../../../server/brain/code/query.js';
import { executeServerTool } from '../../../server/runtime/tools-middleware.js';
import { setWorkspaceRoot } from '../../../server/workspace/root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SAMPLE_PATH = 'test/fixtures/sample.fake';
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

describe('code index integration', () => {
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-code-index-'));
    await seedFakeLspHome(homeDir);
    await setWorkspaceRoot(PROJECT_ROOT);
    const abs = path.join(PROJECT_ROOT, SAMPLE_PATH);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, SAMPLE_TEXT, 'utf8');
  });

  after(async () => {
    shutdownAllLsp();
    closeCodeDbForTests();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('reindex stores symbols with stable ids', async () => {
    const result = await reindexCode({ files: [SAMPLE_PATH] });
    assert.ok(result.indexedFiles >= 1);
    const repo = brainWorkspaceKeyFromPath(PROJECT_ROOT);
    const { matches } = await findSymbol('callee', 5);
    const hit = matches.find((m) => m.name === 'callee');
    assert.ok(hit, 'expected callee in index');
    assert.equal(hit.id, `${repo}:MY_EXPORT.callee`);
    assert.equal(hit.file, SAMPLE_PATH);
  });

  it('who_calls returns graph callers for callee', async () => {
    const { callers, symbol } = await whoCalls('callee');
    assert.ok(symbol);
    assert.ok(callers.length >= 1);
    assert.ok(callers.some((c) => c.name === 'caller'));
  });

  it('who_calls groups call sites under one file heading, without repo-prefixed ids', async () => {
    const out = await executeServerTool('who_calls', { symbol: 'callee' });
    assert.match(out.result, /^1 caller\(s\) of MY_EXPORT\.callee:$/m);
    // The path appears once as a heading; call sites under it are line + name.
    const pathHits = out.result.split(SAMPLE_PATH).length - 1;
    assert.equal(pathHits, 1, 'the file path must not repeat per caller');
    assert.match(out.result, /^ {2}\d+ caller$/m, 'call sites are indented line + name');
    assert.doesNotMatch(out.result, /workspace:|ws:/, 'the constant repo prefix is dropped');
  });

  it('read_symbol returns live source lines', async () => {
    const { text, symbol } = await readSymbol('caller');
    assert.ok(symbol);
    assert.match(text, /caller/);
    assert.match(text, /callee\(\)/);
  });

  it('incremental reindex updates file hash after content change', async () => {
    const repo = brainWorkspaceKeyFromPath(PROJECT_ROOT);
    const db = getCodeDb(repo);
    const before = db
      .prepare('SELECT sha256 FROM file_hashes WHERE repo = ? AND file = ?')
      .get(repo, SAMPLE_PATH);

    const abs = path.join(PROJECT_ROOT, SAMPLE_PATH);
    const edited = `${SAMPLE_TEXT}\n// edited marker\n`;
    await fs.writeFile(abs, edited, 'utf8');

    await reindexCode({ files: [SAMPLE_PATH] });
    const after = db
      .prepare('SELECT sha256 FROM file_hashes WHERE repo = ? AND file = ?')
      .get(repo, SAMPLE_PATH);

    assert.notEqual(before?.sha256, after?.sha256);
    await fs.writeFile(abs, SAMPLE_TEXT, 'utf8');
  });

  it('find_symbol formats one anchored line per match, no repo prefix', async () => {
    await reindexCode({ files: [SAMPLE_PATH] });
    const out = await executeServerTool('find_symbol', { query: 'MY_EXPORT' });
    assert.match(out.result, /MY_EXPORT/);
    assert.match(out.result, new RegExp(`^${SAMPLE_PATH.replace(/[.]/g, '\\.')}:\\d+ `, 'm'));
    assert.doesNotMatch(out.result, /workspace:|ws:/, 'the constant repo prefix is dropped');
    assert.doesNotMatch(out.result, /\*\*/, 'no markdown bolding to pay for');
  });

  it('find_symbol matches file-path fragments on warm index', async () => {
    await reindexCode({ files: [SAMPLE_PATH] });
    const { matches, indexCold } = await findSymbol('fixtures/sample.fake', 10);
    assert.equal(indexCold, false);
    assert.ok(matches.length >= 1, 'expected file-path fragment match');
    assert.ok(matches.some((m) => m.file === SAMPLE_PATH));
  });

  it('find_symbol matches signature tokens on warm index (SQLite only)', async () => {
    await reindexCode({ files: [SAMPLE_PATH] });
    const { matches, indexCold } = await findSymbol('function caller', 10);
    assert.equal(indexCold, false);
    assert.ok(matches.length >= 1, 'expected signature token match');
    assert.ok(matches.some((m) => m.name === 'caller'));
    for (const m of matches) {
      assert.equal(m.source, 'index');
    }
  });

  it('find_symbol warm index with no match does not claim cold or No Project', async () => {
    await reindexCode({ files: [SAMPLE_PATH] });
    const out = await executeServerTool('find_symbol', {
      query: 'zzznomatchsymbol999xyz',
    });
    assert.match(out.result, /No symbols matched/i);
    assert.doesNotMatch(out.result, /cold/i);
    assert.doesNotMatch(out.result, /No Project/i);
  });

  it('read_symbol resolves a file path to the top symbol in that file', async () => {
    await reindexCode({ files: [SAMPLE_PATH] });
    const { symbol, text } = await readSymbol(SAMPLE_PATH);
    assert.ok(symbol);
    assert.equal(symbol.file, SAMPLE_PATH);
    assert.match(text, /MY_EXPORT|callee|caller/);
  });

  it('migrates legacy 2-column symbols_fts to searchable file and signature columns', async () => {
    const migHome = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-fts-migrate-'));
    const prevHome = process.env.MINNOW_HOME;
    process.env.MINNOW_HOME = migHome;
    resetMinnowHomeCache();
    closeCodeDbForTests();

    const repo = 'legacy-fts-migration';
    const dbFile = codeDbPath(repo);
    await fs.mkdir(path.dirname(dbFile), { recursive: true });

    const seed = new Database(dbFile);
    seed.exec(`
      CREATE TABLE symbols (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        signature TEXT NOT NULL DEFAULT '',
        doc TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '',
        pagerank REAL NOT NULL DEFAULT 0,
        usage_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE symbols_fts USING fts5(
        symbol_id UNINDEXED,
        name,
        doc,
        tokenize='porter unicode61'
      );
    `);
    seed
      .prepare(
        `INSERT INTO symbols (
          id, repo, kind, name, file, line_start, line_end, signature, doc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${repo}:Widget`,
        repo,
        'class',
        'Widget',
        'src/widget.ts',
        1,
        5,
        'class Widget',
        '',
      );
    seed.prepare('INSERT INTO symbols_fts (symbol_id, name, doc) VALUES (?, ?, ?)').run(
      `${repo}:Widget`,
      'Widget',
      '',
    );
    seed.close();

    const db = getCodeDb(repo);
    const version = db.pragma('user_version', { simple: true });
    assert.ok(version >= 2);

    const byFile = db
      .prepare(
        `SELECT s.file FROM symbols_fts f
         JOIN symbols s ON s.rowid = f.rowid
         WHERE s.repo = ? AND symbols_fts MATCH ?
         LIMIT 5`,
      )
      .all(repo, 'widget OR ts');
    assert.ok(
      byFile.some((r) => r.file === 'src/widget.ts'),
      'file column searchable after migration',
    );

    const bySig = db
      .prepare(
        `SELECT s.name FROM symbols_fts f
         JOIN symbols s ON s.rowid = f.rowid
         WHERE s.repo = ? AND symbols_fts MATCH ?
         LIMIT 5`,
      )
      .all(repo, 'class OR Widget');
    assert.ok(bySig.some((r) => r.name === 'Widget'), 'signature column searchable after migration');

    closeCodeDbForTests();
    process.env.MINNOW_HOME = prevHome;
    resetMinnowHomeCache();
    await fs.rm(migHome, { recursive: true, force: true });
  });
});
