#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = path.join(repoRoot, 'server');

const REQUIRED_RUNTIME_PATHS = [
  'src/lsp/merge-config.mjs',
  'src/lsp/defaults.json',
  'src/lsp/bundles.json',
  'src/lib/fetch-web-content.mjs',
  'src/lib/untrusted.mjs',
  'src/lib/assert-public-url.mjs',
  'src/attachments/document-extensions.mjs',
  'src/skills/builtin-manifest.json',
  'src/chat/prompts/work-agents/registry.json',
  'src/state/session-schema.mjs',
  'src/product-wiki/path-filter.mjs',
  'src/agents/defaults/sub-agents.json',
  'src/styles/tokens.css',
  'build/icon.ico',
];

const REQUIRED_RUNTIME_DIRS = [
  'src/skills',
  'src/chat/prompts',
  'src/evals/packs',
  'src/models',
];

/** @returns {string[]} */
function loadElectronBuilderFilePatterns() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return pkg.build?.files ?? [];
}

/**
 * @param {string} pattern
 * @param {string} relativePath
 */
function electronFilePatternMatches(pattern, relativePath) {
  const p = pattern.replace(/\\/g, '/');
  const normalized = relativePath.replace(/\\/g, '/');
  if (p.endsWith('/**')) {
    const prefix = p.slice(0, -3);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }
  if (p.includes('*')) return false;
  return normalized === p;
}

/**
 * Last matching electron-builder `files` pattern wins, including `!` exclusions.
 *
 * @param {string} relativePath
 * @param {string[]} patterns
 */
function isIncludedInElectronFiles(relativePath, patterns) {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (electronFilePatternMatches(pattern.slice(1), relativePath)) included = false;
      continue;
    }
    if (electronFilePatternMatches(pattern, relativePath)) included = true;
  }
  return included;
}

/**
 * Leaf files copied to extraResources are omitted from app.asar even when a
 * `files` glob would have included them. ESM imports from asar-resident modules
 * cannot resolve those copies.
 *
 * @param {Record<string, unknown>} pkg
 * @returns {string[]}
 */
function extraResourceLeafFiles(pkg) {
  const entries = Array.isArray(pkg.build?.extraResources) ? pkg.build.extraResources : [];
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const from = typeof entry.from === 'string' ? entry.from.replace(/\\/g, '/') : '';
    const filters = Array.isArray(entry.filter) ? entry.filter : [];
    if (!from) continue;
    for (const filter of filters) {
      if (typeof filter !== 'string' || filter.includes('*')) continue;
      files.push(`${from}/${filter}`.replace(/\/{2,}/g, '/'));
    }
  }
  return files;
}

/**
 * @param {string} relFile
 * @returns {string[]}
 */
function relativeImportSpecifiers(relFile) {
  if (!/\.(js|mjs|cjs)$/.test(relFile)) return [];
  const full = path.join(repoRoot, relFile);
  if (!fs.existsSync(full)) return [];
  const text = fs.readFileSync(full, 'utf8');
  const importRe = /from\s+['"](\.[^'"]+)['"]/g;
  /** @type {string[]} */
  const resolved = [];
  let match;
  while ((match = importRe.exec(text)) !== null) {
    resolved.push(
      path.relative(repoRoot, path.resolve(path.dirname(full), match[1])).replace(/\\/g, '/'),
    );
  }
  return resolved;
}

/**
 * @param {string} dir
 * @returns {{ src: string[], scripts: string[] }}
 */
function collectServerRuntimeImports(dir) {
/** @type {string[]} */
  const src = [];
/** @type {string[]} */
  const scripts = [];
  const importRe = /from\s+['"]((?:\.\.\/)+(?:src|scripts)\/[^'"]+)['"]/g;
  const importMetaUrlRe =
    /new\s+URL\(\s*['"]((?:\.\.\/)+(?:src|scripts)\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = collectServerRuntimeImports(full);
      src.push(...nested.src);
      scripts.push(...nested.scripts);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    const text = fs.readFileSync(full, 'utf8');
    const recordHit = (specifier) => {
      const resolved = path
        .relative(repoRoot, path.resolve(path.dirname(full), specifier))
        .replace(/\\/g, '/');
      if (resolved.startsWith('src/')) src.push(resolved);
      else if (resolved.startsWith('scripts/')) scripts.push(resolved);
    };
    let match;
    while ((match = importRe.exec(text)) !== null) {
      recordHit(match[1]);
    }
    while ((match = importMetaUrlRe.exec(text)) !== null) {
      recordHit(match[1]);
    }
  }
  return { src, scripts };
}

function assertExists(relPath) {
  const normalized = relPath.replace(/^(\.\.[\\/])+/, '');
  const full = path.join(repoRoot, normalized);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing packaged runtime file: ${normalized}`);
  }
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const asarUnpack = pkg.build?.asarUnpack ?? [];
  for (const required of [
    'node_modules/@vscode/ripgrep/**',
    'node_modules/@vscode/ripgrep-*/**',
  ]) {
    if (!asarUnpack.includes(required)) {
      throw new Error(
        `electron-builder asarUnpack missing ripgrep pattern: ${required}`,
      );
    }
  }

  for (const rel of REQUIRED_RUNTIME_PATHS) {
    assertExists(rel);
  }
  for (const rel of REQUIRED_RUNTIME_DIRS) {
    assertExists(rel);
  }

  const electronFiles = loadElectronBuilderFilePatterns();
  const dynamicImports = collectServerRuntimeImports(serverRoot);
  const uniqueSrc = [...new Set(dynamicImports.src)];
  const uniqueScripts = [...new Set(dynamicImports.scripts)];

  for (const relImport of uniqueSrc) {
    assertExists(relImport);
    if (!isIncludedInElectronFiles(relImport, electronFiles)) {
      throw new Error(
        `Server src import is not listed in electron-builder files: ${relImport}`,
      );
    }
  }

  const extraResourceLeaves = new Set(extraResourceLeafFiles(pkg));
  const relativeQueue = [...uniqueSrc];
  const relativeSeen = new Set();
  while (relativeQueue.length) {
    const relFile = relativeQueue.pop();
    if (!relFile || relativeSeen.has(relFile)) continue;
    relativeSeen.add(relFile);
    for (const relImport of relativeImportSpecifiers(relFile)) {
      if (extraResourceLeaves.has(relImport)) {
        throw new Error(
          `${relFile} imports ${relImport}, which is extraResources-only and missing from app.asar`,
        );
      }
      if (!isIncludedInElectronFiles(relImport, electronFiles)) {
        throw new Error(
          `${relFile} imports ${relImport}, which is not listed in electron-builder files`,
        );
      }
      if (!relativeSeen.has(relImport)) relativeQueue.push(relImport);
    }
  }

  const unpackagedScripts = uniqueScripts.filter(
    (relImport) => !isIncludedInElectronFiles(relImport, electronFiles),
  );
  if (unpackagedScripts.length) {
    throw new Error(
      `Server scripts imports missing from electron-builder files: ${unpackagedScripts.join(', ')}`,
    );
  }

  console.log(
    `[validate-packaged-runtime-files] OK — ${REQUIRED_RUNTIME_PATHS.length} files, ${REQUIRED_RUNTIME_DIRS.length} trees, ${uniqueSrc.length} server src imports, ${uniqueScripts.length} server scripts imports`,
  );
}

main();
