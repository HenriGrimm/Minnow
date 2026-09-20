#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHARED_RUNNER_ENTRY = 'server/runner/turn-runner.js';
export const ADAPTER_ENTRY = 'src/agents/renderer-runner-deps.ts';

export const INJECT_SEAMS = [
  'src/state/sessions.ts',
  'src/providers/fetch-chat.ts',
  'src/tools/headless-tool-batch.ts',
  'src/boot/report-background-error.ts',
  'src/usage/record-chat-usage.ts',
  'src/api/models.ts',
  'src/providers/store.ts',
  'src/providers/model-capabilities.ts',
  'src/providers/vision-model.ts',
  'src/config/tool-calls-meta.ts',
  'src/agents/sub-agent-config.ts',
  'src/agents/resolve-sampler.ts',
  'src/agents/resolve-thinking.ts',
  'src/chat/context/apply-policy.ts',
  'src/lib/context-length.ts',
];

export const SLICE_SOURCES = ['src/api/chat.ts'];

const BROWSER_RE = /\b(?:document|window|localStorage|sessionStorage|HTMLElement)\b/;
const BOARD_RE =
  /\b(?:orchestrator|orchestrate-|BoardState|boardId|board_init|board_update_task|board_set_autonomy)\b/;

// ── Parse imports ────────────────────────────────────────────────────────────

/**
 * @param {string} source
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * @param {string} source
 * @returns {{ specifier: string, typeOnly: boolean }[]}
 */
export function parseImports(source) {
  const code = stripComments(source);
  /** @type {{ specifier: string, typeOnly: boolean }[]} */
  const found = [];

  const statement =
    /\bimport\s+(type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(statement)) {
    const typeKw = Boolean(match[1]);
    const clause = match[2].trim();
    const specifier = match[3];
    const allTyped =
      typeKw ||
      /^type\b/.test(clause) ||
      (clause.startsWith('{') &&
        [...clause.matchAll(/\btype\s+\w+/g)].length > 0 &&
        !/\b(?!type\b)\w+\s*(?:,|})/.test(clause.replace(/\btype\s+/g, '')));
    let typeOnly = typeKw || /^type\b/.test(clause);
    if (!typeOnly && clause.startsWith('{')) {
      const inner = clause.slice(1, clause.lastIndexOf('}')).trim();
      const parts = inner.split(',').map((p) => p.trim()).filter(Boolean);
      typeOnly = parts.length > 0 && parts.every((p) => /^type\s+/.test(p));
    }
    found.push({ specifier, typeOnly });
  }

  const bare = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(bare)) {
    found.push({ specifier: match[1], typeOnly: false });
  }
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of code.matchAll(dynamic)) {
    found.push({ specifier: match[1], typeOnly: false });
  }
  const exportFrom = /\bexport\s+(type\s+)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(exportFrom)) {
    found.push({ specifier: match[2], typeOnly: Boolean(match[1]) });
  }
  return found;
}

// ── Resolve ──────────────────────────────────────────────────────────────────

/**
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string | null}
 */
export function resolveSpecifier(fromFile, specifier) {
  if (specifier.startsWith('node:') || !specifier.startsWith('.')) return null;
  const dir = path.dirname(fromFile);
  const raw = path.resolve(dir, specifier);
  const candidates = [
    raw,
    raw + '.ts',
    raw + '.tsx',
    raw + '.js',
    raw + '.mjs',
    raw + '.mts',
    raw + '.json',
    path.join(raw, 'index.ts'),
    path.join(raw, 'index.js'),
    path.join(raw, 'index.mjs'),
  ];
  if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
    return posixRel(raw);
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return posixRel(candidate);
    }
  }
  return posixRel(raw);
}

/** @param {string} abs */
function posixRel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

/**
 * @param {string} rel
 */
function isSeam(rel) {
  if (INJECT_SEAMS.includes(rel)) return true;
  if (SLICE_SOURCES.includes(rel)) return true;
  if (rel.startsWith('src/ui/') || rel.includes('/ui/')) return true;
  return false;
}

// ── Map graph ────────────────────────────────────────────────────────────────

/**
 * @returns {{
 */
export function mapRunnerImports(entryRel = SHARED_RUNNER_ENTRY) {
  const entryAbs = path.join(ROOT, entryRel);
  const entrySource = fs.readFileSync(entryAbs, 'utf8');
  const direct = parseImports(entrySource).map((row) => ({
    specifier: row.specifier,
    typeOnly: row.typeOnly,
    resolved: resolveSpecifier(entryAbs, row.specifier),
  }));

/** @type {Set<string>} */
  const runtime = new Set();
/** @type {Set<string>} */
  const typeOnly = new Set();
/** @type {Set<string>} */
  const seamsHit = new Set();
/** @type {Set<string>} */
  const external = new Set();
/** @type {string[]} */
  const queue = [posixRel(entryAbs)];
/** @type {Set<string>} */
  const seen = new Set();

  while (queue.length) {
    const rel = queue.shift();
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    if (rel.endsWith('.json')) {
      runtime.add(rel);
      continue;
    }
    const source = fs.readFileSync(abs, 'utf8');
    for (const row of parseImports(source)) {
      const resolved = resolveSpecifier(abs, row.specifier);
      if (!resolved) continue;
      if (row.typeOnly) {
        typeOnly.add(resolved);
        continue;
      }
      if (isSeam(resolved)) {
        seamsHit.add(resolved);
        continue;
      }
      const entryRelPosix = posixRel(entryAbs);
      if (!resolved.startsWith('server/runner/') && resolved !== entryRelPosix) {
        external.add(resolved);
        continue;
      }
      if (!runtime.has(resolved)) {
        runtime.add(resolved);
        queue.push(resolved);
      }
    }
  }

  runtime.delete(posixRel(entryAbs));

/** @type {Record<string, { browser: boolean, board: boolean, uiImport: boolean, lines: number }>} */
  const flags = {};
  for (const rel of [...runtime, posixRel(entryAbs), ...seamsHit, ...external]) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const source = fs.readFileSync(abs, 'utf8');
    const code = stripComments(source);
    flags[rel] = {
      browser: BROWSER_RE.test(code),
      board: BOARD_RE.test(code) || /\/orchestrate/.test(rel),
      uiImport: /from\s*['"][^'"]*\/ui\//.test(code),
      lines: source.split('\n').length,
    };
  }

  return {
    entry: posixRel(entryAbs),
    direct,
    runtimeClosure: [...runtime].sort(),
    typeOnly: [...typeOnly].sort(),
    seamsHit: [...seamsHit].sort(),
    flags,
    external: [...external].sort(),
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

function printReport(map) {
  const directRuntime = map.direct.filter((d) => !d.typeOnly);
  const directType = map.direct.filter((d) => d.typeOnly);
  console.log(`# turn-runner import map\n`);
  console.log(`Entry: ${map.entry}`);
  console.log(`Direct imports: ${map.direct.length} (${directRuntime.length} runtime, ${directType.length} type-only)`);
  console.log(`Inject seams hit: ${map.seamsHit.length}`);
  console.log(`External (listed, not walked): ${map.external.length}`);
  console.log(`Runtime closure (after seams): ${map.runtimeClosure.length}\n`);

  console.log('## Direct runtime');
  for (const row of directRuntime) {
    console.log(`- ${row.specifier} → ${row.resolved ?? '(unresolved)'}`);
  }
  console.log('\n## Direct type-only');
  for (const row of directType) {
    console.log(`- ${row.specifier} → ${row.resolved ?? '(unresolved)'}`);
  }
  console.log('\n## External (outside server/runner/, not walked)');
  for (const rel of map.external) {
    const f = map.flags[rel];
    console.log(`- ${rel}  [browser=${f?.browser ?? false} lines=${f?.lines ?? '?'}]`);
  }
  console.log('\n## Inject seams (not moved)');
  for (const rel of map.seamsHit) {
    const f = map.flags[rel];
    console.log(`- ${rel}  [browser=${f?.browser ?? false} ui=${f?.uiImport ?? false} board=${f?.board ?? false} lines=${f?.lines ?? '?'}]`);
  }
  console.log('\n## Runtime closure');
  let total = 0;
  for (const rel of map.runtimeClosure) {
    const f = map.flags[rel];
    total += f?.lines ?? 0;
    const marks = [
      f?.browser ? 'BROWSER' : null,
      f?.uiImport ? 'UI' : null,
      f?.board ? 'BOARD-PATH' : null,
      SLICE_SOURCES.includes(rel) ? 'SLICE' : null,
    ]
      .filter(Boolean)
      .join(',');
    console.log(`- ${rel}  (${f?.lines ?? '?'} lines)${marks ? ` [${marks}]` : ''}`);
  }
  console.log(`\nTotal lines in move closure: ${total}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const entryRel = process.argv.includes('--adapter') ? ADAPTER_ENTRY : SHARED_RUNNER_ENTRY;
  const map = mapRunnerImports(entryRel);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(map, null, 2));
  } else {
    printReport(map);
  }
}
