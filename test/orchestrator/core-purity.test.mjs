/**
 * P0-A — purity guard for `server/orchestrator/core/`.
 *
 * The core is the decision surface of Orchestrator V2, and `state = fold(journal)`
 * only recovers a crashed board if replay reproduces the same decisions. That
 * makes purity load-bearing rather than stylistic, so it is enforced mechanically
 * here instead of in review.
 *
 * Runs on the plain `node` runner with no loader flags — which is itself part of
 * the assertion. If this file ever needs `tsx`, the core stopped being plain JS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_DIR = path.join(PROJECT_ROOT, 'server', 'orchestrator', 'core');

/**
 * Textual bans. Each is a clock, a random source, an I/O surface, or an escape
 * hatch that would let one in through the back door.
 *
 * The list is deliberately broad. Purity here is load-bearing rather than
 * stylistic — `state = fold(journal)` only recovers a crashed board if replay
 * reproduces the same decisions — and this file is the only thing enforcing it.
 */
const BANNED_PATTERNS = [
  { re: /\bDate\s*\./, why: 'reads the clock; take time as an argument instead' },
  { re: /\bnew\s+Date\b/, why: 'reads the clock; take time as an argument instead' },
  { re: /(?<![.\w])Date\s*\(/, why: 'reads the clock; take time as an argument instead' },
  { re: /\bperformance\s*\./, why: 'reads the clock; take time as an argument instead' },
  { re: /\bhrtime\b/, why: 'reads the clock; take time as an argument instead' },

  { re: /\bMath\.random\s*\(/, why: 'nondeterministic; replay would diverge' },
  { re: /\bcrypto\s*\./, why: 'nondeterministic; replay would diverge' },

  { re: /\bIntl\s*\./, why: 'locale-dependent; replay would diverge across hosts' },
  { re: /\btoLocale[A-Z]\w*\s*\(/, why: 'locale-dependent; replay would diverge across hosts' },

  { re: /\bprocess\s*\./, why: 'host access; the core runs in the renderer too' },
  { re: /\bfs\s*\./, why: 'filesystem I/O is not allowed in the core' },
  { re: /\bfetch\s*\(/, why: 'network I/O is not allowed in the core' },
  { re: /\bXMLHttpRequest\b/, why: 'network I/O is not allowed in the core' },
  { re: /\bWebSocket\b/, why: 'network I/O is not allowed in the core' },
  { re: /\b(?:local|session)Storage\b/, why: 'host storage is not allowed in the core' },
  { re: /\bindexedDB\b/, why: 'host storage is not allowed in the core' },
  { re: /\bdocument\s*\./, why: 'the core has no DOM; it runs on the server too' },
  { re: /\bwindow\s*\./, why: 'the core has no DOM; it runs on the server too' },

  { re: /\bset(?:Timeout|Interval|Immediate)\s*\(/, why: 'the core does not schedule work' },
  { re: /\bqueueMicrotask\s*\(/, why: 'the core does not schedule work' },

  { re: /\brequire\s*\(/, why: 'the core is ESM-only' },
  { re: /\bglobalThis\b/, why: 'reaching the global object bypasses every rule above' },
  { re: /\bnew\s+Function\b/, why: 'evaluated code cannot be checked by this guard' },
  { re: /(?<![.\w])eval\s*\(/, why: 'evaluated code cannot be checked by this guard' },
  { re: /\bimport\s*\.\s*meta\b/, why: 'module metadata is host-specific' },
];

/**
 * Strip comments so a rule cited in prose does not fail the file that cites it.
 * Deliberately naive — it is only good enough for source we control, which is
 * the only source it is ever pointed at.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Collect every static import/export specifier in a module.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function importSpecifiers(source) {
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
 * A dynamic import whose target this guard cannot read — `import(spec)`,
 * `import('no' + 'de:fs')`. The specifier is unknowable statically, so it is
 * refused outright rather than assumed innocent.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function hasComputedImport(source) {
  const code = stripComments(source);
  for (const match of code.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    if (!/^\s*(['"])[^'"]*\1\s*$/.test(match[1])) return true;
  }
  return false;
}

/**
 * Check one core module for purity violations.
 *
 * @param {string} relPath  path relative to `core/`, used only in messages
 * @param {string} source
 * @returns {string[]} one message per violation; empty means pure
 */
export function checkCoreModule(relPath, source) {
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
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      violations.push(`${relPath}: imports '${specifier}' — the core may only import within core/`);
      continue;
    }
    const resolved = path.resolve(path.dirname(path.join(CORE_DIR, relPath)), specifier);
    const inside = path.relative(CORE_DIR, resolved);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      violations.push(`${relPath}: imports '${specifier}' — resolves outside core/`);
    }
  }

  return violations;
}

/**
 * Every executable module under core/, relative to core/.
 *
 * `.mjs` and `.cjs` are included as well as `.js` — scanning only `.js` left an
 * unscanned hole a module could simply be renamed into.
 *
 * @returns {string[]}
 */
function coreModules() {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(path.relative(CORE_DIR, full).split(path.sep).join('/'));
      }
    }
  };
  walk(CORE_DIR);
  return out.sort();
}

describe('orchestrator core purity guard', () => {
  it('finds core modules to check', () => {
    const modules = coreModules();
    assert.ok(modules.length > 0, 'no .js modules found under server/orchestrator/core');
    assert.ok(modules.includes('plan.js'), 'core planner is missing');
  });

  it('every core module is pure', () => {
    /** @type {string[]} */
    const violations = [];
    for (const relPath of coreModules()) {
      const source = fs.readFileSync(path.join(CORE_DIR, relPath), 'utf8');
      violations.push(...checkCoreModule(relPath, source));
    }
    assert.deepEqual(violations, []);
  });

  it('every core module has a .d.ts companion', () => {
    for (const relPath of coreModules()) {
      const companion = path.join(CORE_DIR, relPath.replace(/\.js$/, '.d.ts'));
      assert.ok(fs.existsSync(companion), `missing type companion for core/${relPath}`);
    }
  });

  it('the core directory contains no TypeScript sources', () => {
    const ts = fs
      .readdirSync(CORE_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
    assert.deepEqual(ts, [], 'the core ships untranspiled; author .js + .d.ts');
  });

  it('README states the three rules', () => {
    const readme = fs.readFileSync(path.join(CORE_DIR, 'README.md'), 'utf8');
    assert.match(readme, /No I\/O/);
    assert.match(readme, /No clock, no randomness/);
    assert.match(readme, /No imports outside this directory/);
  });
});

describe('the purity guard itself', () => {
  it('rejects a node: import', () => {
    const violations = checkCoreModule('derive.js', "import fs from 'node:fs';\nexport const a = 1;\n");
    assert.equal(violations.length, 1);
    assert.match(violations[0], /may only import within core\//);
  });

  it('rejects an import that escapes core/', () => {
    const violations = checkCoreModule('derive.js', "import { x } from '../../tools/output-cap.js';\n");
    assert.equal(violations.length, 1);
    assert.match(violations[0], /resolves outside core\//);
  });

  it('accepts a relative import within core/', () => {
    assert.deepEqual(checkCoreModule('derive.js', "import { validateEvent } from './events.js';\n"), []);
    assert.deepEqual(checkCoreModule('sub/a.js', "import { b } from '../events.js';\n"), []);
  });

  it('rejects every clock', () => {
    for (const source of [
      'const t = Date.now();',
      'const t = new Date();',
      'const t = new Date;',
      'const t = Date();',
      'const t = Date.parse(s);',
      'const t = performance.now();',
      'const t = process.hrtime.bigint();',
    ]) {
      assert.ok(checkCoreModule('a.js', source).length > 0, source);
    }
  });

  it('rejects every random source', () => {
    for (const source of [
      'const r = Math.random();',
      'const r = crypto.randomUUID();',
      'crypto.getRandomValues(buf);',
    ]) {
      assert.ok(checkCoreModule('a.js', source).length > 0, source);
    }
  });

  it('rejects host-dependent formatting', () => {
    assert.ok(checkCoreModule('a.js', 'Intl.DateTimeFormat().resolvedOptions();').length > 0);
    assert.ok(checkCoreModule('a.js', 'const s = n.toLocaleString();').length > 0);
  });

  it('rejects I/O and host storage', () => {
    for (const source of [
      'const p = process.env.X;',
      'fs.readFileSync(p);',
      'await fetch(url);',
      'new XMLHttpRequest();',
      'new WebSocket(url);',
      'localStorage.getItem("k");',
      'document.querySelector("x");',
      'window.alert(1);',
    ]) {
      assert.ok(checkCoreModule('a.js', source).length > 0, source);
    }
  });

  it('rejects timers', () => {
    for (const source of ['setTimeout(fn, 1);', 'setInterval(fn, 1);', 'queueMicrotask(fn);']) {
      assert.ok(checkCoreModule('a.js', source).length > 0, source);
    }
  });

  it('rejects the escape hatches that would hide any of the above', () => {
    for (const source of [
      'const p = globalThis["pro" + "cess"];',
      'const f = new Function("return process")();',
      'const p = eval("process");',
      'const u = import.meta.url;',
      'const m = await import(spec);',
      'const m = await import("no" + "de:fs");',
    ]) {
      assert.ok(checkCoreModule('a.js', source).length > 0, source);
    }
  });

  it('allows a literal relative dynamic import', () => {
    assert.deepEqual(checkCoreModule('a.js', "const m = await import('./b.js');"), []);
  });

  it('does not fire on words that merely contain a banned token', () => {
    assert.deepEqual(checkCoreModule('a.js', 'const refs = []; const defs = refs.map((r) => r);'), []);
    assert.deepEqual(checkCoreModule('a.js', 'const updated = state.processed;'), []);
  });

  it('ignores banned tokens inside comments', () => {
    const source = '// never call Date.now() here\n/* nor process.env */\nexport const a = 1;\n';
    assert.deepEqual(checkCoreModule('a.js', source), []);
  });

  it('catches a violation introduced into a real core file', () => {
    const relPath = 'derive.js';
    const original = fs.readFileSync(path.join(CORE_DIR, relPath), 'utf8');
    assert.deepEqual(checkCoreModule(relPath, original), [], 'derive.js is not clean to begin with');

    const spiked = `import fs from 'node:fs';\n${original}`;
    const violations = checkCoreModule(relPath, spiked);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /may only import within core\//);

    assert.deepEqual(checkCoreModule(relPath, original), [], 'guard did not pass once removed');
  });

  it('sees imports the same way regardless of statement shape', () => {
    const source = [
      "import a from './a.js';",
      "import { b } from './b.js';",
      "export { c } from './c.js';",
      "import './d.js';",
      "const e = await import('./e.js');",
    ].join('\n');
    assert.deepEqual(importSpecifiers(source), ['./a.js', './b.js', './c.js', './d.js', './e.js']);
  });
});
