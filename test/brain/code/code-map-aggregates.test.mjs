/**
 * Code map aggregates — file graph roll-up, architecture grouping, folder view, path search,
 * header comments and package import scanning (server/brain/code/map.js).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  buildArchitecture,
  buildFolderView,
  clearCodeMapCache,
  extractHeaderComment,
  fileLinks,
  firstParagraph,
  isTestPath,
  loadFileGraph,
  packageNameFromSpecifier,
  pickArchitectureBase,
  scanImports,
  searchMapPaths,
} from '../../../server/brain/code/map.js';
import { docCommentAbove } from '../../../server/brain/code/query.js';

/** In-memory index with just the columns the map reads. */
function seedDb(symbols, edges) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE symbols (id TEXT PRIMARY KEY, repo TEXT, kind TEXT, name TEXT, file TEXT,
      line_start INTEGER, line_end INTEGER, signature TEXT DEFAULT '', doc TEXT DEFAULT '',
      pagerank REAL DEFAULT 0, usage_count INTEGER DEFAULT 0);
    CREATE TABLE edges (src_symbol TEXT, dst_symbol TEXT, kind TEXT);
    CREATE TABLE file_hashes (repo TEXT, file TEXT, sha256 TEXT, mtime_ms INTEGER);
  `);
  const insert = db.prepare(
    'INSERT INTO symbols (id, repo, kind, name, file, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [id, name, file, start = 1, end = 10] of symbols) insert.run(id, 'r', 'function', name, file, start, end);
  const edge = db.prepare("INSERT INTO edges VALUES (?, ?, 'calls')");
  for (const [a, b] of edges) edge.run(a, b);
  const files = new Set(symbols.map((s) => s[2]));
  const hash = db.prepare("INSERT INTO file_hashes VALUES ('r', ?, 'x', 1)");
  for (const f of files) hash.run(f);
  return db;
}

describe('code map file graph', () => {
  it('rolls symbol calls up to file pairs and drops same-file calls', () => {
    clearCodeMapCache();
    const db = seedDb(
      [
        ['a1', 'runTurn', 'src/chat/run.ts'],
        ['a2', 'helper', 'src/chat/run.ts', 20, 30],
        ['b1', 'buildPrompt', 'src/chat/prompt.ts'],
        ['c1', 'sendTool', 'src/tools/send.ts'],
      ],
      [
        ['a1', 'a2'],
        ['a1', 'b1'],
        ['a2', 'b1'],
        ['a1', 'c1'],
      ],
    );
    const graph = loadFileGraph(db, 'r');
    assert.equal(graph.files.size, 3);
    assert.deepEqual(graph.files.get('src/chat/run.ts'), { symbols: 2, lines: 30 });
    const pairs = graph.edges.map((e) => `${e.src}>${e.dst}:${e.n}`).sort();
    assert.deepEqual(pairs, ['src/chat/run.ts>src/chat/prompt.ts:2', 'src/chat/run.ts>src/tools/send.ts:1']);
  });

  it('ignores built-in method names, widely defined names, and production calls into tests', () => {
    clearCodeMapCache();
    const symbols = [
      ['ui', 'render2', 'src/ui/view.ts'],
      ['map', 'map', 'scripts/map-imports.mjs'],
      ['helper', 'testHelper', 'test/helpers.mjs'],
      ['real', 'formatDate', 'src/lib/date.ts'],
      ['t1', 'runSpec', 'test/date.test.mjs'],
    ];
    // `init` defined in 10 files is too ambiguous to trust.
    for (let i = 0; i < 10; i += 1) symbols.push([`init${i}`, 'initThing', `src/m${i}/index.ts`]);
    const db = seedDb(symbols, [
      ['ui', 'map'],
      ['ui', 'helper'],
      ['ui', 'real'],
      ['ui', 'init3'],
      ['t1', 'real'],
    ]);
    const pairs = loadFileGraph(db, 'r')
      .edges.map((e) => `${e.src}>${e.dst}`)
      .sort();
    assert.deepEqual(pairs, ['src/ui/view.ts>src/lib/date.ts', 'test/date.test.mjs>src/lib/date.ts']);
  });
});

describe('code map architecture', () => {
  const graph = {
    files: new Map(
      [
        'src/ui/a.ts',
        'src/ui/b.ts',
        'src/chat/run.ts',
        'src/main.ts',
        'server/tools/x.js',
        'test/ui/a.test.ts',
        'README.md',
      ].map((f) => [f, { symbols: 2, lines: 20 }]),
    ),
    edges: [
      { src: 'src/ui/a.ts', dst: 'src/chat/run.ts', n: 3 },
      { src: 'src/ui/b.ts', dst: 'src/chat/run.ts', n: 2 },
      { src: 'src/chat/run.ts', dst: 'server/tools/x.js', n: 1 },
      { src: 'src/ui/a.ts', dst: 'src/ui/b.ts', n: 4 },
      { src: 'test/ui/a.test.ts', dst: 'src/ui/a.ts', n: 5 },
    ],
  };

  it('groups top-level folders into layers and their children into modules', () => {
    const arch = buildArchitecture(graph);
    assert.equal(arch.base, '');
    assert.deepEqual(
      arch.groups.map((g) => [g.id, g.test]),
      [
        ['src', false],
        ['server', false],
        ['test', true],
        ['.', false],
      ],
    );
    const ids = arch.modules.map((m) => m.id).sort();
    assert.deepEqual(ids, ['.#files', 'server/tools', 'src#files', 'src/chat', 'src/ui', 'test/ui']);
    assert.equal(arch.modules.find((m) => m.id === 'src#files')?.loose, true);
    assert.equal(arch.modules.find((m) => m.id === 'test/ui')?.test, true);
  });

  it('sums file calls into module links and drops calls inside a module', () => {
    const arch = buildArchitecture(graph);
    const links = arch.edges.map((e) => `${e.src}>${e.dst}:${e.n}`).sort();
    assert.deepEqual(links, ['src/chat>server/tools:1', 'src/ui>src/chat:5', 'test/ui>src/ui:5']);
  });

  it('descends into a folder that holds nearly every file', () => {
    const files = ['src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts', 'src/c/w.ts', 'vite.config.ts'];
    assert.equal(pickArchitectureBase(files), 'src');
    assert.equal(pickArchitectureBase(['src/x.ts', 'src/y.ts']), '');
    assert.equal(pickArchitectureBase(['src/a/x.ts', 'lib/b/y.ts']), '');
  });
});

describe('code map folder view', () => {
  const graph = {
    files: new Map(
      ['pkg/a.js', 'pkg/b.js', 'pkg/sub/c.js', 'pkg/sub/deep/d.js', 'other/e.js'].map((f) => [f, { symbols: 1, lines: 5 }]),
    ),
    edges: [
      { src: 'pkg/a.js', dst: 'pkg/b.js', n: 2 },
      { src: 'pkg/a.js', dst: 'pkg/sub/c.js', n: 1 },
      { src: 'pkg/sub/c.js', dst: 'pkg/sub/deep/d.js', n: 7 },
      { src: 'other/e.js', dst: 'pkg/b.js', n: 4 },
      { src: 'pkg/b.js', dst: 'other/e.js', n: 1 },
    ],
  };

  it('shows direct files and collapses subfolders into one node each', () => {
    const view = buildFolderView(graph, 'pkg');
    assert.deepEqual(
      view.nodes.map((n) => `${n.kind}:${n.id}`),
      ['file:pkg/a.js', 'file:pkg/b.js', 'folder:pkg/sub/'],
    );
    assert.equal(view.nodes.find((n) => n.id === 'pkg/sub/')?.files, 2);
    assert.deepEqual(
      view.edges.map((e) => `${e.src}>${e.dst}:${e.n}`).sort(),
      ['pkg/a.js>pkg/b.js:2', 'pkg/a.js>pkg/sub/:1'],
    );
    assert.equal(view.nodes.find((n) => n.id === 'pkg/b.js')?.outside, 4);
    assert.deepEqual(view.calledFrom, [{ path: 'other', n: 4 }]);
    assert.deepEqual(view.callsInto, [{ path: 'other', n: 1 }]);
  });

  it('lists file callers and callees by count', () => {
    const links = fileLinks(graph, 'pkg/b.js');
    assert.deepEqual(links.callers, [
      { path: 'other/e.js', n: 4 },
      { path: 'pkg/a.js', n: 2 },
    ]);
    assert.deepEqual(links.callees, [{ path: 'other/e.js', n: 1 }]);
  });

  it('finds files and folders by path, basename matches first', () => {
    const hits = searchMapPaths(graph, 'sub');
    assert.equal(hits[0]?.path, 'pkg/sub');
    assert.equal(hits[0]?.kind, 'folder');
    assert.deepEqual(searchMapPaths(graph, ''), []);
    assert.deepEqual(
      searchMapPaths(graph, 'deep d.js').map((h) => h.path),
      ['pkg/sub/deep/d.js'],
    );
  });
});

describe('code map text helpers', () => {
  it('reads the first paragraph of a header comment and skips licence blocks', () => {
    const js = `/**\n * Copyright 2026 Someone. Licensed under MIT.\n */\n/**\n * Builds the repo map.\n * Ranks symbols.\n *\n * @param x\n */\nexport function f() {}`;
    assert.equal(extractHeaderComment(js), 'Builds the repo map. Ranks symbols.');
    assert.equal(extractHeaderComment('#!/usr/bin/env node\n// Line one\n// line two\n\ncode()'), 'Line one line two');
    assert.equal(extractHeaderComment('"""Python module doc.\n\nMore."""\nimport os'), 'Python module doc.');
    assert.equal(extractHeaderComment('const x = 1;'), '');
  });

  it('takes a detached module comment after the imports, not a symbol doc', () => {
    const detached = "import a from 'a';\nimport {\n  b,\n} from './b';\n\n/** Streaming state for chats. */\n\nexport const x = 1;";
    assert.equal(extractHeaderComment(detached), 'Streaming state for chats.');
    const attached = "import a from 'a';\n/** Register a listener. */\nexport function f() {}";
    assert.equal(extractHeaderComment(attached), '');
  });

  it('reads the doc comment written above a declaration', () => {
    const lines = ['/**', ' * Token-budgeted signature map.', ' *', ' * More.', ' * @param {object} opts', ' */', 'export async function repoMap(opts = {}) {'];
    assert.equal(docCommentAbove(lines, 7), 'Token-budgeted signature map.');
    assert.equal(docCommentAbove(['// Adds two', '// numbers', '@memo', 'function add() {}'], 4), 'Adds two numbers');
    assert.equal(docCommentAbove(['const a = 1;', 'function f() {}'], 2), '');
  });

  it('takes prose from markdown and skips headings', () => {
    assert.equal(firstParagraph('# Title\n\nThe chat engine.\nRuns turns.\n\nSecond.'), 'The chat engine. Runs turns.');
  });

  it('maps import specifiers to package names', () => {
    assert.equal(packageNameFromSpecifier('react'), 'react');
    assert.equal(packageNameFromSpecifier('@xterm/xterm/css/xterm.css'), '@xterm/xterm');
    assert.equal(packageNameFromSpecifier('highlight.js/lib/core'), 'highlight.js');
    assert.equal(packageNameFromSpecifier('./local'), null);
    assert.equal(packageNameFromSpecifier('node:fs'), null);
    assert.equal(packageNameFromSpecifier('fs/promises'), null);
    assert.equal(packageNameFromSpecifier('virtual:pwa'), null);
  });

  it('scans JS and Python imports', () => {
    const js = `import Database from 'better-sqlite3';\nimport { x } from "./x.js";\nconst pty = require('node-pty');\nawait import('openai');\nimport 'side-effect';`;
    assert.deepEqual([...scanImports(js, 'a.ts')].sort(), ['better-sqlite3', 'node-pty', 'openai', 'side-effect']);
    const py = 'import os\nfrom fastapi import FastAPI\nimport numpy as np\nfrom . import local';
    assert.deepEqual([...scanImports(py, 'a.py')].sort(), ['fastapi', 'numpy']);
  });

  it('recognises test files and folders', () => {
    assert.equal(isTestPath('test/ui/a.mjs'), true);
    assert.equal(isTestPath('src/__tests__/a.ts'), true);
    assert.equal(isTestPath('src/ui/a.test.ts'), true);
    assert.equal(isTestPath('src/ui/testing-library.ts'), false);
    assert.equal(isTestPath('src/latest/a.ts'), false);
  });
});
