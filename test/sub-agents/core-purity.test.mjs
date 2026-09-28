/**
 * P8-C — purity guard for `server/sub-agents/`.
 *
 * Modeled on `test/orchestrator/core-purity.test.mjs`. Replay only recovers a
 * crashed run if this graph is a pure function of the event list, so purity
 * is load-bearing. Zero imports from `node:fs`, `node:path`, or anything
 * under `server/runner/`. Helpers are duplicated rather than imported from
 * the board test file, because importing that file would re-register its
 * suites.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GRAPH_DIR = path.join(PROJECT_ROOT, 'server', 'sub-agents');

/**
 * I/O modules added in P8-D (MIN-757) and P8-E (MIN-758). They live next to
 * the graph so the effector / delivery queue can import them, but they are
 * not the fold — purity still applies to events / derive / plan / policy /
 * graph / evidence / index.
 */
const IO_MODULES = new Set([
  'config.js',
  'journal.js',
  'prompts.js',
  'effector-runner.js',
  'delivery.js',
  'middleware.js',
  'runtime.js',
]);

const BANNED_PATTERNS = [
  { re: /\bDate\s*\./, why: 'reads the clock; take time as an argument instead' },
  { re: /\bnew\s+Date\b/, why: 'reads the clock; take time as an argument instead' },
  { re: /(?<![.\w])Date\s*\(/, why: 'reads the clock; take time as an argument instead' },
  { re: /\bperformance\s*\./, why: 'reads the clock' },
  { re: /\bhrtime\b/, why: 'reads the clock' },
  { re: /\bMath\.random\s*\(/, why: 'nondeterministic; replay would diverge' },
  { re: /\bcrypto\s*\./, why: 'nondeterministic; replay would diverge' },
  { re: /\bIntl\s*\./, why: 'locale-dependent' },
  { re: /\btoLocale[A-Z]\w*\s*\(/, why: 'locale-dependent' },
  { re: /\bprocess\s*\./, why: 'host access' },
  { re: /\bfs\s*\./, why: 'filesystem I/O is not allowed' },
  { re: /\bfetch\s*\(/, why: 'network I/O is not allowed' },
  { re: /\bXMLHttpRequest\b/, why: 'network I/O is not allowed' },
  { re: /\bWebSocket\b/, why: 'network I/O is not allowed' },
  { re: /\b(?:local|session)Storage\b/, why: 'host storage is not allowed' },
  { re: /\bindexedDB\b/, why: 'host storage is not allowed' },
  { re: /\bdocument\s*\./, why: 'the graph has no DOM' },
  { re: /\bwindow\s*\./, why: 'the graph has no DOM' },
  { re: /\bset(?:Timeout|Interval|Immediate)\s*\(/, why: 'the graph does not schedule work' },
  { re: /\bqueueMicrotask\s*\(/, why: 'the graph does not schedule work' },
  { re: /\brequire\s*\(/, why: 'the graph is ESM-only' },
  { re: /\bglobalThis\b/, why: 'reaching the global object bypasses every rule above' },
  { re: /\bnew\s+Function\b/, why: 'evaluated code cannot be checked by this guard' },
  { re: /(?<![.\w])eval\s*\(/, why: 'evaluated code cannot be checked by this guard' },
  { re: /\bimport\s*\.\s*meta\b/, why: 'module metadata is host-specific' },
];

/**
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * @param {string} source
 * @returns {string[]}
 */
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

/**
 * @param {string} source
 * @returns {boolean}
 */
function hasComputedImport(source) {
  const code = stripComments(source);
  for (const match of code.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    if (!/^\s*(['"])[^'"]*\1\s*$/.test(match[1])) return true;
  }
  return false;
}

/**
 * @returns {string[]}
 */
function graphModules() {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(path.relative(GRAPH_DIR, full).split(path.sep).join('/'));
      }
    }
  };
  walk(GRAPH_DIR);
  return out.sort();
}

/**
 * @param {string} relPath
 * @param {string} source
 * @returns {string[]}
 */
function checkGraphModule(relPath, source) {
  /** @type {string[]} */
  const violations = [];
  const code = stripComments(source);

  for (const { re, why } of BANNED_PATTERNS) {
    if (re.test(code)) violations.push(`${relPath}: matches ${re} — ${why}`);
  }

  if (hasComputedImport(source)) {
    violations.push(`${relPath}: has a computed dynamic import — the target cannot be checked`);
  }

  for (const specifier of importSpecifiers(source)) {
    if (specifier === 'node:fs' || specifier === 'node:path') {
      violations.push(`${relPath}: imports '${specifier}'`);
      continue;
    }
    if (specifier.includes('server/runner') || specifier.includes('../runner/')) {
      violations.push(`${relPath}: imports '${specifier}' — runner is I/O`);
      continue;
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      violations.push(`${relPath}: imports '${specifier}' — the graph may only import within sub-agents/`);
      continue;
    }
    const resolved = path.resolve(path.dirname(path.join(GRAPH_DIR, relPath)), specifier);
    const inside = path.relative(GRAPH_DIR, resolved);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      violations.push(`${relPath}: imports '${specifier}' — resolves outside sub-agents/`);
    }
  }

  return violations;
}

describe('sub-agent graph purity guard', () => {
  it('finds graph modules to check', () => {
    const modules = graphModules();
    assert.ok(modules.includes('index.js'));
    assert.ok(modules.includes('events.js'));
    assert.ok(modules.includes('derive.js'));
    assert.ok(modules.includes('plan.js'));
    assert.ok(modules.includes('policy.js'));
    assert.ok(modules.includes('graph.js'));
  });

  it('every graph module is pure', () => {
    /** @type {string[]} */
    const violations = [];
    for (const relPath of graphModules()) {
      if (IO_MODULES.has(relPath)) continue;
      const source = fs.readFileSync(path.join(GRAPH_DIR, relPath), 'utf8');
      violations.push(...checkGraphModule(relPath, source));
    }
    assert.deepEqual(violations, []);
  });

  it('I/O modules are not imported by the graph core', () => {
    const core = graphModules().filter((rel) => !IO_MODULES.has(rel));
    for (const relPath of core) {
      const source = fs.readFileSync(path.join(GRAPH_DIR, relPath), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const name = specifier.replace(/^\.\//, '');
        assert.equal(
          IO_MODULES.has(name) || IO_MODULES.has(`${name}.js`),
          false,
          `${relPath} imported I/O module ${specifier}`,
        );
      }
    }
  });

  it('every graph module has a .d.ts companion', () => {
    for (const relPath of graphModules()) {
      const companion = path.join(GRAPH_DIR, relPath.replace(/\.js$/, '.d.ts'));
      assert.ok(fs.existsSync(companion), `missing type companion for sub-agents/${relPath}`);
    }
  });

  it('the directory contains no TypeScript sources', () => {
    const ts = fs
      .readdirSync(GRAPH_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
    assert.deepEqual(ts, [], 'the graph ships untranspiled; author .js + .d.ts');
  });

  it('README states the three rules', () => {
    const readme = fs.readFileSync(path.join(GRAPH_DIR, 'README.md'), 'utf8');
    assert.match(readme, /No I\/O/);
    assert.match(readme, /No clock, no randomness/);
    assert.match(readme, /No imports outside this directory/);
  });

  it('rejects a node:fs, node:path, or runner import', () => {
    assert.ok(checkGraphModule('derive.js', "import fs from 'node:fs';\n").length > 0);
    assert.ok(checkGraphModule('derive.js', "import path from 'node:path';\n").length > 0);
    assert.ok(
      checkGraphModule('derive.js', "import { runTurn } from '../runner/run-turn.js';\n").length > 0,
    );
  });

  it('rejects Date.now, Math.random, and fetch', () => {
    assert.ok(checkGraphModule('a.js', 'const t = Date.now();').length > 0);
    assert.ok(checkGraphModule('a.js', 'const r = Math.random();').length > 0);
    assert.ok(checkGraphModule('a.js', 'await fetch(url);').length > 0);
  });
});
