/**
 * P2-A — purity + uniqueness guard for `server/runner/`.
 *
 * The shared turn loop is imported by both Node (`node server.js`) and the Vite
 * renderer. A `src/` import, a browser global, or a board-shaped name would
 * make one of those hosts unloadable. Enforced here, not in review.
 *
 * Runs on the plain `node` runner with no loader flags — same contract as
 * `test/orchestrator/core-purity.test.mjs`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  ADAPTER_ENTRY,
  mapRunnerImports,
  SHARED_RUNNER_ENTRY,
} from '../../scripts/map-runner-imports.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER_DIR = path.join(PROJECT_ROOT, 'server', 'runner');

const BROWSER_GLOBALS = [
  { re: /\bdocument\s*\./, why: 'DOM; the runner also loads on the server' },
  { re: /\bwindow\s*\./, why: 'DOM; the runner also loads on the server' },
  { re: /\blocalStorage\b/, why: 'browser storage; sessions.ts is injected instead' },
  { re: /\bHTMLElement\b/, why: 'DOM; the runner also loads on the server' },
];

const BOARD_SHAPED = [
  { re: /\borchestrator\b/, why: 'the runner does not know what a board is' },
  { re: /\borchestrate-/, why: 'the runner does not know what a board is' },
  { re: /\bBoardState\b/, why: 'the runner does not know what a board is' },
  { re: /\bboardId\b/, why: 'the runner does not know what a board is' },
  { re: /\bboard\b/, why: 'executable JS must not mention a board (comments are stripped)' },
];

/** Strip comments so a rule cited in prose does not fail the file that cites it. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importSpecifiers(source) {
  const code = stripComments(source);
  /** @type {string[]} */
  const found = [];
  const statement = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(statement)) found.push(match[1]);
  const bare = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(bare)) found.push(match[1]);
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of code.matchAll(dynamic)) found.push(match[1]);
  return found;
}

/** Executable modules under server/runner/, relative, posix. */
function runnerModules() {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
        out.push(path.relative(RUNNER_DIR, full).split(path.sep).join('/'));
      }
    }
  };
  walk(RUNNER_DIR);
  return out.sort();
}

/**
 * @param {string} relPath
 * @param {string} source
 * @returns {string[]}
 */
function checkRunnerModule(relPath, source) {
  /** @type {string[]} */
  const violations = [];
  const code = stripComments(source);

  for (const { re, why } of BROWSER_GLOBALS) {
    if (re.test(code)) violations.push(`${relPath}: matches ${re} — ${why}`);
  }
  for (const { re, why } of BOARD_SHAPED) {
    if (re.test(code)) violations.push(`${relPath}: matches ${re} — ${why}`);
  }

  for (const specifier of importSpecifiers(source)) {
    if (specifier.includes('/src/') || specifier.startsWith('../../src/')) {
      violations.push(`${relPath}: imports '${specifier}' — server/runner may not import src/`);
    }
    if (
      /\borchestrator\b/.test(specifier) ||
      specifier.includes('orchestrate-') ||
      /board-testing/.test(specifier)
    ) {
      violations.push(`${relPath}: imports '${specifier}' — board-shaped import`);
    }
  }

  return violations;
}

const SKIP_LOOP_DIRS = new Set([
  'node_modules',
  'dist',
  'release',
  '.git',
  'coverage',
]);

/** Source files that may contain a turn-loop copy. */
function sourceFilesForLoopScan() {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_LOOP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.map')) continue;
      if (/\.(?:js|mjs|cjs|ts|mts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(PROJECT_ROOT, 'server'));
  walk(path.join(PROJECT_ROOT, 'src'));
  walk(path.join(PROJECT_ROOT, 'scripts'));
  return out;
}

describe('server/runner package guard', () => {
  it('finds runner modules to check', () => {
    const modules = runnerModules();
    assert.ok(modules.length > 0, 'no .js modules found under server/runner');
    assert.ok(modules.includes('index.js'), 'server/runner/index.js barrel is missing');
    assert.ok(modules.includes('node.js'), 'server/runner/node.js Node barrel is missing');
    assert.ok(modules.includes('turn-runner.js'), 'the turn loop module is missing');
    assert.ok(modules.includes('run-turn.js'), 'the runTurn entry is missing');
    assert.ok(modules.includes('tool-dispatch.js'), 'in-process tool dispatch is missing');
    assert.ok(modules.includes('generation-binding.js'), 'in-process generation binding is missing');
  });

  it('every runner module has a .d.ts companion', () => {
    for (const relPath of runnerModules()) {
      const companion = path.join(RUNNER_DIR, relPath.replace(/\.js$/, '.d.ts'));
      assert.ok(fs.existsSync(companion), `missing type companion for server/runner/${relPath}`);
    }
  });

  it('the runner directory contains no TypeScript sources', () => {
    const ts = fs
      .readdirSync(RUNNER_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
    assert.deepEqual(ts, [], 'the runner ships untranspiled; author .js + .d.ts');
  });

  it('no src/ imports, browser globals, or board-shaped names', () => {
    /** @type {string[]} */
    const violations = [];
    for (const relPath of runnerModules()) {
      const source = fs.readFileSync(path.join(RUNNER_DIR, relPath), 'utf8');
      violations.push(...checkRunnerModule(relPath, source));
    }
    assert.deepEqual(violations, []);
  });

  it('the mapped closure stays off src/ and off boards', () => {
    const map = mapRunnerImports(SHARED_RUNNER_ENTRY);
    const srcHits = map.runtimeClosure.filter((rel) => rel.startsWith('src/'));
    assert.deepEqual(srcHits, [], 'shared runner still imports src/');
    assert.ok(
      map.runtimeClosure.every((rel) => rel.startsWith('server/runner/')),
      'runtime closure escaped server/runner/',
    );
    const boardHits = map.runtimeClosure.filter(
      (rel) => /orchestrat|board-testing|boardId/.test(rel),
    );
    assert.deepEqual(boardHits, [], 'shared runner import graph is board-shaped');
    assert.equal(map.entry, SHARED_RUNNER_ENTRY);
  });

  it('runTurn stays inside server/runner/ and off product modules', () => {
    const map = mapRunnerImports('server/runner/run-turn.js');
    const srcHits = map.runtimeClosure.filter((rel) => rel.startsWith('src/'));
    assert.deepEqual(srcHits, [], 'runTurn still imports src/');
    assert.ok(
      map.runtimeClosure.every((rel) => rel.startsWith('server/runner/')),
      'runTurn runtime closure escaped server/runner/',
    );
    const boardHits = map.runtimeClosure.filter(
      (rel) => /orchestrat|board-testing|boardId/.test(rel),
    );
    assert.deepEqual(boardHits, [], 'runTurn import graph is board-shaped');
    const source = fs.readFileSync(path.join(RUNNER_DIR, 'run-turn.js'), 'utf8');
    assert.equal(
      source.includes('tryParseStructuredOutcomeFromAssistantProse'),
      false,
      'runTurn must not scrape assistant prose for pass/fail/blocked',
    );
  });

  it('the renderer sub-agent adapter is deleted (P8-G)', () => {
    assert.equal(
      fs.existsSync(path.join(PROJECT_ROOT, 'src', 'agents', 'sub-agent-runner.ts')),
      false,
      'src/agents/sub-agent-runner.ts must not exist',
    );
    assert.equal(
      fs.existsSync(path.join(PROJECT_ROOT, 'src', 'agents', 'controller')),
      false,
      'src/agents/controller/ must not exist',
    );
  });

  // P10-J: the one-shot extract pointed SRC at the deleted .ts and would ENOENT.
  // server/runner/turn-runner.js is hand-maintained — do not resurrect this.
  it('the one-shot runner extractor is gone (P10-J)', () => {
    assert.equal(
      fs.existsSync(path.join(PROJECT_ROOT, 'scripts', 'extract-sub-agent-runner.mjs')),
      false,
      'scripts/extract-sub-agent-runner.mjs must not exist',
    );
  });

  it('renderer RunnerDeps does not contain the turn loop', () => {
    const deps = fs.readFileSync(path.join(PROJECT_ROOT, ADAPTER_ENTRY), 'utf8');
    assert.equal(
      deps.includes('streamTurnOnce'),
      false,
      'src/agents/renderer-runner-deps.ts must not contain the loop',
    );
  });

  it('renderer RunnerDeps does not import in-process tool dispatch', () => {
    const deps = fs.readFileSync(path.join(PROJECT_ROOT, ADAPTER_ENTRY), 'utf8');
    const specifiers = importSpecifiers(deps);
    assert.equal(
      specifiers.some((s) => s.includes('tool-dispatch')),
      false,
      'renderer RunnerDeps must not import server/runner/tool-dispatch (tools-middleware into Vite)',
    );
    assert.equal(
      specifiers.some((s) => s.includes('tools-middleware')),
      false,
      'renderer RunnerDeps must not import tools-middleware',
    );
    assert.ok(
      specifiers.some((s) => s.includes('headless-tool-batch')),
      'renderer RunnerDeps must keep src/tools/headless-tool-batch.ts',
    );
    assert.equal(
      specifiers.some((s) => s.includes('runner/node')),
      false,
      'renderer RunnerDeps must not import server/runner/node.js (Node adapters into Vite)',
    );
  });

  it('the isomorphic barrel does not re-export Node-only adapters', () => {
    const source = fs.readFileSync(path.join(RUNNER_DIR, 'index.js'), 'utf8');
    const specifiers = importSpecifiers(source);
    assert.equal(
      specifiers.some((s) => s.includes('generation-binding')),
      false,
      'index.js must not re-export generation-binding (Vite follows unused named exports)',
    );
    assert.equal(
      specifiers.some((s) => s.includes('tool-dispatch')),
      false,
      'index.js must not re-export tool-dispatch (Vite follows unused named exports)',
    );
    const nodeSource = fs.readFileSync(path.join(RUNNER_DIR, 'node.js'), 'utf8');
    const nodeSpecifiers = importSpecifiers(nodeSource);
    assert.ok(
      nodeSpecifiers.some((s) => s.includes('generation-binding')),
      'node.js must re-export generation-binding for server callers',
    );
    assert.ok(
      nodeSpecifiers.some((s) => s.includes('tool-dispatch')),
      'node.js must re-export tool-dispatch for server callers',
    );
  });

  it('the isomorphic barrel uses named re-exports (no star)', () => {
    const source = fs.readFileSync(path.join(RUNNER_DIR, 'index.js'), 'utf8');
    assert.equal(
      /\bexport\s+\*\s+from\b/.test(source),
      false,
      'star re-exports from index.js would pull every named module into Vite',
    );
  });

  it('exactly one streamTurnOnce implementation exists', () => {
    /** @type {string[]} */
    const hits = [];
    for (const abs of sourceFilesForLoopScan()) {
      const source = fs.readFileSync(abs, 'utf8');
      if (!source.includes('function streamTurnOnce')) continue;
      hits.push(path.relative(PROJECT_ROOT, abs).split(path.sep).join('/'));
    }
    assert.deepEqual(hits, ['server/runner/turn-runner.js']);
  });
});
