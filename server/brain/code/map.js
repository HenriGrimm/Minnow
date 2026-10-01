/**
 * Code map aggregates for the Code map page: folder modules, module and file call links,
 * external packages, and path search.
 *
 * Everything is derived from the `symbols` + `edges` tables. Symbol-level `calls` edges are
 * rolled up to file pairs once per index state and cached per repo, so the three map views
 * (architecture, folder, file) are cheap re-groupings of the same file graph.
 */

import fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { getEffectiveWorkspaceRoot } from '../../runtime/path-access.js';
import { ensureIndexFreshForQuery } from './cascade.js';
import { activeRepoKey } from './query.js';
import { getCodeDb } from './schema.js';

/** Folder names treated as test code (hidden from the architecture view by default). */
const TEST_SEGMENT_RE = /^(test|tests|__tests__|__test__|spec|specs|e2e|testing|fixtures|__mocks__)$/i;

/** Share of files one folder must hold before the architecture view descends into it. */
const DOMINANT_FOLDER_SHARE = 0.8;

/** Folder view node cap; the rest collapse into a "more" count. */
const FOLDER_VIEW_MAX_NODES = 60;

const FILE_GRAPH_CACHE_MAX = 4;

/** A callee name defined in this many files is too ambiguous to count as a link. */
const AMBIGUOUS_NAME_FILES = 10;

/** Built-in method names that name-based call resolution routinely mismatches. */
const BUILTIN_METHOD_NAMES = new Set(
  (
    'map filter reduce forEach find findIndex some every includes indexOf join split slice splice ' +
    'push pop shift unshift concat sort reverse flat flatMap keys values entries from of all any race ' +
    'then catch finally get set has add delete clear next emit on off once close open read write send ' +
    'run start stop log warn error info debug trace toString valueOf parse stringify resolve reject ' +
    'apply call bind replace trim match test exec assign create now min max round floor ceil abs fetch ' +
    'append remove update init load save render dispose destroy'
  ).split(' '),
);

/** @type {Map<string, { key: string, graph: FileGraph, externals?: Promise<Map<string, Set<string>>> }>} */
const fileGraphCache = new Map();

const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py']);
const SCAN_HEAD_BYTES = 32 * 1024;
const SCAN_CONCURRENCY = 32;

const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

/** Python standard-library roots that would otherwise swamp the external package list. */
const PYTHON_STDLIB = new Set(
  (
    '__future__ abc argparse ast asyncio base64 collections concurrent contextlib copy csv dataclasses ' +
    'datetime decimal enum functools glob hashlib heapq html http importlib inspect io itertools json ' +
    'logging math multiprocessing operator os pathlib pickle platform queue random re shutil signal ' +
    'socket sqlite3 string struct subprocess sys tempfile textwrap threading time traceback types ' +
    'typing unittest urllib uuid warnings weakref xml zipfile'
  ).split(' '),
);

/**
 * @typedef {{ symbols: number, lines: number }} FileStat
 * @typedef {{ src: string, dst: string, n: number }} FileEdge
 * @typedef {{ files: Map<string, FileStat>, edges: FileEdge[] }} FileGraph
 */

/** Forward-slash, no leading `./`, no trailing slash. */
export function normalizeMapPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
}

function dirOf(file) {
  const i = file.lastIndexOf('/');
  return i < 0 ? '' : file.slice(0, i);
}

function baseName(file) {
  const i = file.lastIndexOf('/');
  return i < 0 ? file : file.slice(i + 1);
}

function isUnder(file, folder) {
  return folder === '' || file.startsWith(`${folder}/`);
}

function relativeTo(file, folder) {
  return folder === '' ? file : file.slice(folder.length + 1);
}

/** True for files inside a test folder and for `*.test.*` / `*.spec.*` files. */
export function isTestPath(p) {
  const segs = normalizeMapPath(p).split('/');
  const name = segs.pop() ?? '';
  return segs.some((seg) => TEST_SEGMENT_RE.test(seg)) || /\.(test|spec)\.[a-z0-9]+$/i.test(name);
}

/** Cheap fingerprint of the index state; any reindex changes it. */
function indexFingerprint(db, repo) {
  const s = db.prepare('SELECT COUNT(*) AS n, MAX(rowid) AS r FROM symbols WHERE repo = ?').get(repo);
  const f = db
    .prepare('SELECT COUNT(*) AS n, MAX(mtime_ms) AS m FROM file_hashes WHERE repo = ?')
    .get(repo);
  const e = db.prepare('SELECT COUNT(*) AS n FROM edges').get();
  return [s?.n, s?.r, f?.n, f?.m, e?.n].join(':');
}

/**
 * Per-file stats plus cross-file call counts for one repo, cached until the index changes.
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @returns {FileGraph}
 */
export function loadFileGraph(db, repo) {
  return loadFileGraphEntry(db, repo).graph;
}

function loadFileGraphEntry(db, repo) {
  const key = indexFingerprint(db, repo);
  const hit = fileGraphCache.get(repo);
  if (hit && hit.key === key) return hit;

  /** @type {Map<string, FileStat>} */
  const files = new Map();
  const statRows = db
    .prepare(
      `SELECT file, COUNT(*) AS symbols, MAX(line_end) AS lines
       FROM symbols WHERE repo = ? GROUP BY file`,
    )
    .all(repo);
  for (const row of statRows) {
    files.set(normalizeMapPath(row.file), { symbols: row.symbols ?? 0, lines: row.lines ?? 0 });
  }
  for (const row of db.prepare('SELECT file FROM file_hashes WHERE repo = ?').all(repo)) {
    const file = normalizeMapPath(row.file);
    if (file && !files.has(file)) files.set(file, { symbols: 0, lines: 0 });
  }

  // Calls resolve by name, so `list.map()` can land on any function called `map`. Names that
  // shadow built-in methods, or that many files define, say nothing about module structure.
  const ambiguous = new Set(
    db
      .prepare(
        `SELECT name FROM symbols WHERE repo = ?
         GROUP BY name HAVING COUNT(DISTINCT file) >= ?`,
      )
      .all(repo, AMBIGUOUS_NAME_FILES)
      .map((row) => row.name),
  );
  const edgeRows = db
    .prepare(
      `SELECT a.file AS src, b.file AS dst, b.name AS name, COUNT(*) AS n
       FROM edges e
       JOIN symbols a ON a.id = e.src_symbol
       JOIN symbols b ON b.id = e.dst_symbol
       WHERE e.kind = 'calls' AND a.repo = ? AND b.repo = ? AND a.file <> b.file
       GROUP BY a.file, b.file, b.name`,
    )
    .all(repo, repo);
  /** @type {Map<string, FileEdge>} */
  const pairs = new Map();
  for (const row of edgeRows) {
    if (ambiguous.has(row.name) || BUILTIN_METHOD_NAMES.has(row.name)) continue;
    const src = normalizeMapPath(row.src);
    const dst = normalizeMapPath(row.dst);
    // Production code never calls into tests; a name match there is a collision.
    if (isTestPath(dst) && !isTestPath(src)) continue;
    const key = `${src}\u0000${dst}`;
    const hit = pairs.get(key);
    if (hit) hit.n += row.n ?? 0;
    else pairs.set(key, { src, dst, n: row.n ?? 0 });
  }
  const edges = [...pairs.values()];

  const entry = { key, graph: { files, edges } };
  fileGraphCache.delete(repo);
  fileGraphCache.set(repo, entry);
  while (fileGraphCache.size > FILE_GRAPH_CACHE_MAX) {
    const oldest = fileGraphCache.keys().next().value;
    fileGraphCache.delete(oldest);
  }
  return entry;
}

/** Drop cached file graphs (tests, index reset). */
export function clearCodeMapCache() {
  fileGraphCache.clear();
}

/**
 * Pick the folder the architecture view starts from: descend while one folder holds
 * nearly every file (a repo that is all `src/` shows `src/*` as its layers).
 * @param {string[]} filePaths
 */
export function pickArchitectureBase(filePaths) {
  let base = '';
  for (let depth = 0; depth < 6; depth += 1) {
    const under = filePaths.filter((f) => isUnder(f, base));
    if (!under.length) break;
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const f of under) {
      const rest = relativeTo(f, base);
      const i = rest.indexOf('/');
      if (i < 0) continue;
      const seg = rest.slice(0, i);
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
    let top = null;
    for (const [seg, n] of counts) {
      if (!top || n > top[1]) top = [seg, n];
    }
    if (!top || top[1] < under.length * DOMINANT_FOLDER_SHARE) break;
    const child = base ? `${base}/${top[0]}` : top[0];
    const hasSubfolders = under.some((f) => isUnder(f, child) && relativeTo(f, child).includes('/'));
    if (!hasSubfolders) break;
    base = child;
  }
  return base;
}

/**
 * Group files into layers (top-level folders under `base`) and modules (their child folders),
 * then roll file call edges up to module pairs.
 * @param {FileGraph} graph
 * @param {{ base?: string }} [opts]
 */
export function buildArchitecture(graph, opts = {}) {
  const allFiles = [...graph.files.keys()];
  const base = opts.base !== undefined ? normalizeMapPath(opts.base) : pickArchitectureBase(allFiles);

  /** @type {Map<string, { id: string, path: string, name: string, test: boolean, files: number, symbols: number }>} */
  const groups = new Map();
  /** @type {Map<string, { id: string, group: string, path: string, name: string, loose: boolean, test: boolean, files: number, symbols: number, lines: number }>} */
  const modules = new Map();
  /** @type {Map<string, string>} */
  const moduleOfFile = new Map();

  for (const file of allFiles) {
    if (!isUnder(file, base)) continue;
    const stat = graph.files.get(file) ?? { symbols: 0, lines: 0 };
    const segs = relativeTo(file, base).split('/');
    let groupId;
    let groupPath;
    let groupName;
    let moduleId;
    let modulePath;
    let moduleName;
    let loose;
    if (segs.length === 1) {
      groupId = '.';
      groupPath = base;
      groupName = base ? baseName(base) : '';
      moduleId = `${base || '.'}#files`;
      modulePath = base;
      moduleName = groupName;
      loose = true;
    } else {
      groupPath = base ? `${base}/${segs[0]}` : segs[0];
      groupId = groupPath;
      groupName = segs[0];
      if (segs.length === 2) {
        moduleId = `${groupPath}#files`;
        modulePath = groupPath;
        moduleName = segs[0];
        loose = true;
      } else {
        modulePath = `${groupPath}/${segs[1]}`;
        moduleId = modulePath;
        moduleName = segs[1];
        loose = false;
      }
    }

    let group = groups.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        path: groupPath,
        name: groupName,
        test: groupId !== '.' && TEST_SEGMENT_RE.test(groupName),
        files: 0,
        symbols: 0,
      };
      groups.set(groupId, group);
    }
    group.files += 1;
    group.symbols += stat.symbols;

    let mod = modules.get(moduleId);
    if (!mod) {
      mod = {
        id: moduleId,
        group: groupId,
        path: modulePath,
        name: moduleName,
        loose,
        test: group.test || (!loose && TEST_SEGMENT_RE.test(moduleName)),
        files: 0,
        symbols: 0,
        lines: 0,
      };
      modules.set(moduleId, mod);
    }
    mod.files += 1;
    mod.symbols += stat.symbols;
    mod.lines += stat.lines;
    moduleOfFile.set(file, moduleId);
  }

  /** @type {Map<string, { src: string, dst: string, n: number }>} */
  const pairs = new Map();
  for (const edge of graph.edges) {
    const src = moduleOfFile.get(edge.src);
    const dst = moduleOfFile.get(edge.dst);
    if (!src || !dst || src === dst) continue;
    const key = `${src}\u0000${dst}`;
    const hit = pairs.get(key);
    if (hit) hit.n += edge.n;
    else pairs.set(key, { src, dst, n: edge.n });
  }

  return {
    base,
    groups: [...groups.values()].sort((a, b) => b.files - a.files),
    modules: [...modules.values()].sort((a, b) => b.symbols - a.symbols || b.files - a.files),
    edges: [...pairs.values()].sort((a, b) => b.n - a.n),
    moduleOfFile,
  };
}

/**
 * Files and immediate subfolders of one folder, with call links between them and
 * call counts to and from the rest of the repo.
 * @param {FileGraph} graph
 * @param {string} folderPath
 */
export function buildFolderView(graph, folderPath) {
  const folder = normalizeMapPath(folderPath);
  /** @type {Map<string, { id: string, kind: 'file' | 'folder', path: string, name: string, symbols: number, lines: number, files: number, inside: number, outside: number, callsIn: number, callsOut: number }>} */
  const nodes = new Map();
  /** @type {Map<string, string>} */
  const nodeOfFile = new Map();

  for (const [file, stat] of graph.files) {
    if (!isUnder(file, folder)) continue;
    const rest = relativeTo(file, folder);
    const slash = rest.indexOf('/');
    let id;
    if (slash < 0) {
      id = file;
      nodes.set(id, {
        id,
        kind: 'file',
        path: file,
        name: rest,
        symbols: stat.symbols,
        lines: stat.lines,
        files: 1,
        inside: 0,
        outside: 0,
        callsIn: 0,
        callsOut: 0,
      });
    } else {
      const sub = folder ? `${folder}/${rest.slice(0, slash)}` : rest.slice(0, slash);
      id = `${sub}/`;
      let node = nodes.get(id);
      if (!node) {
        node = {
          id,
          kind: 'folder',
          path: sub,
          name: rest.slice(0, slash),
          symbols: 0,
          lines: 0,
          files: 0,
          inside: 0,
          outside: 0,
          callsIn: 0,
          callsOut: 0,
        };
        nodes.set(id, node);
      }
      node.symbols += stat.symbols;
      node.lines += stat.lines;
      node.files += 1;
    }
    nodeOfFile.set(file, id);
  }

  /** @type {Map<string, { src: string, dst: string, n: number }>} */
  const pairs = new Map();
  /** @type {Map<string, number>} */
  const inboundDirs = new Map();
  /** @type {Map<string, number>} */
  const outboundDirs = new Map();
  for (const edge of graph.edges) {
    const src = nodeOfFile.get(edge.src);
    const dst = nodeOfFile.get(edge.dst);
    if (src && dst) {
      if (src === dst) continue;
      const key = `${src}\u0000${dst}`;
      const hit = pairs.get(key);
      if (hit) hit.n += edge.n;
      else pairs.set(key, { src, dst, n: edge.n });
      nodes.get(src).callsOut += edge.n;
      nodes.get(dst).callsIn += edge.n;
    } else if (dst) {
      const node = nodes.get(dst);
      node.outside += edge.n;
      node.callsIn += edge.n;
      const dir = dirOf(edge.src) || '.';
      inboundDirs.set(dir, (inboundDirs.get(dir) ?? 0) + edge.n);
    } else if (src) {
      const node = nodes.get(src);
      node.callsOut += edge.n;
      const dir = dirOf(edge.dst) || '.';
      outboundDirs.set(dir, (outboundDirs.get(dir) ?? 0) + edge.n);
    }
  }

  const ranked = [...nodes.values()].sort(
    (a, b) => b.callsIn + b.callsOut - (a.callsIn + a.callsOut) || b.symbols - a.symbols,
  );
  const kept = ranked.slice(0, FOLDER_VIEW_MAX_NODES);
  const keptIds = new Set(kept.map((n) => n.id));
  const hidden = ranked.slice(FOLDER_VIEW_MAX_NODES).map((n) => ({ id: n.id, name: n.name, kind: n.kind }));
  const topDirs = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([dir, n]) => ({ path: dir, n }));

  return {
    path: folder,
    nodes: kept.sort((a, b) => a.name.localeCompare(b.name)),
    edges: [...pairs.values()]
      .filter((e) => keptIds.has(e.src) && keptIds.has(e.dst))
      .sort((a, b) => b.n - a.n),
    hidden,
    calledFrom: topDirs(inboundDirs),
    callsInto: topDirs(outboundDirs),
  };
}

/**
 * Callers and callees of one file, rolled up by file.
 * @param {FileGraph} graph
 * @param {string} filePath
 */
export function fileLinks(graph, filePath) {
  const file = normalizeMapPath(filePath);
  const callers = [];
  const callees = [];
  for (const edge of graph.edges) {
    if (edge.dst === file) callers.push({ path: edge.src, n: edge.n });
    else if (edge.src === file) callees.push({ path: edge.dst, n: edge.n });
  }
  callers.sort((a, b) => b.n - a.n);
  callees.sort((a, b) => b.n - a.n);
  return { callers, callees };
}

/**
 * Files and folders whose path matches every query token; basename hits rank first.
 * @param {FileGraph} graph
 * @param {string} query
 * @param {number} [limit]
 */
export function searchMapPaths(graph, query, limit = 12) {
  const tokens = String(query ?? '')
    .toLowerCase()
    .split(/[\s/\\]+/)
    .filter(Boolean);
  if (!tokens.length) return [];
  const folders = new Set();
  for (const file of graph.files.keys()) {
    let dir = dirOf(file);
    while (dir && !folders.has(dir)) {
      folders.add(dir);
      dir = dirOf(dir);
    }
  }
  const last = tokens[tokens.length - 1];
  /** @type {Array<{ path: string, kind: 'file' | 'folder', score: number }>} */
  const hits = [];
  const consider = (p, kind) => {
    const lower = p.toLowerCase();
    if (!tokens.every((t) => lower.includes(t))) return;
    const name = baseName(lower);
    let score = 1;
    if (name === last || name.replace(/\.[^.]+$/, '') === last) score = 4;
    else if (name.startsWith(last)) score = 3;
    else if (name.includes(last)) score = 2;
    if (kind === 'folder') score += 0.5;
    hits.push({ path: p, kind, score });
  };
  for (const dir of folders) consider(dir, 'folder');
  for (const file of graph.files.keys()) consider(file, 'file');
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return hits.slice(0, limit).map(({ path: p, kind }) => ({ path: p, kind }));
}

// ── Source reads ─────────────────────────────────────────────────────────────

/** Absolute path for a workspace-relative file, or null when it escapes the root. */
function resolveInWorkspace(root, rel) {
  const normalized = normalizeMapPath(rel);
  if (!root || normalized.split('/').includes('..')) return null;
  const abs = path.resolve(root, normalized);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

async function readHead(abs, bytes = SCAN_HEAD_BYTES) {
  let handle;
  try {
    handle = await fs.open(abs, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

const LICENSE_RE = /\b(copyright|licen[cs]ed?|spdx-license)\b/i;

/**
 * First paragraph of a file's leading comment (JS/TS block or line comments, Python docstring
 * or `#` lines). License headers are skipped.
 * @param {string} text
 */
export function extractHeaderComment(text) {
  let body = String(text ?? '').replace(/^﻿/, '');
  body = body.replace(/^#!.*\n/, '');
  const blocks = [];
  let rest = body;
  for (let i = 0; i < 4; i += 1) {
    rest = rest.replace(/^\s*(['"]use strict['"];?\s*)?/, '');
    let m = rest.match(/^\/\*\*?([\s\S]*?)\*\//);
    if (m) {
      blocks.push(m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, '')).join('\n'));
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^(?:[ \t]*\/\/.*(?:\r?\n|$))+/);
    if (m) {
      blocks.push(m[0].split(/\r?\n/).map((l) => l.replace(/^\s*\/\/\s?/, '')).join('\n'));
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^(?:"""|''')([\s\S]*?)(?:"""|''')/);
    if (m) {
      blocks.push(m[1]);
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^(?:[ \t]*#(?!!).*(?:\r?\n|$))+/);
    if (m) {
      blocks.push(m[0].split(/\r?\n/).map((l) => l.replace(/^\s*#\s?/, '')).join('\n'));
      rest = rest.slice(m[0].length);
      continue;
    }
    break;
  }
  // A module comment often sits after the imports; only a detached block (blank line
  // after it) counts — one attached to a declaration documents that symbol instead.
  const afterImports = stripLeadingImports(rest).match(/^\/\*\*?([\s\S]*?)\*\/[ \t]*\r?\n[ \t]*\r?\n/);
  if (afterImports) {
    blocks.push(afterImports[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, '')).join('\n'));
  }
  for (const block of blocks) {
    if (LICENSE_RE.test(block)) continue;
    const paragraph = firstParagraph(block.replace(/^\s*@\w+.*$/gm, ''));
    if (paragraph) return paragraph;
  }
  return '';
}

const IMPORT_END_RE = /;\s*$|\bfrom\s+['"][^'"]+['"]\s*;?\s*$/;

/** Text after the leading import / require block of a JS or TS file. */
export function stripLeadingImports(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let i = 0;
  let inImport = false;
  for (; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (inImport) {
      if (IMPORT_END_RE.test(t)) inImport = false;
      continue;
    }
    if (!t || /^['"]use [a-z]+['"];?$/.test(t)) continue;
    if (/^import\b/.test(t) || /^export\s+(\*|\{)/.test(t)) {
      if (!IMPORT_END_RE.test(t) && !/^import\s+['"][^'"]+['"]\s*;?$/.test(t)) inImport = true;
      continue;
    }
    if (/^(const|let|var)\s+[\w{}\s,:]+=\s*require\(/.test(t)) continue;
    break;
  }
  return lines.slice(i).join('\n');
}

/** First prose paragraph of markdown or comment text, capped for the inspector. */
export function firstParagraph(text, max = 420) {
  const paras = String(text ?? '')
    .split(/\r?\n\s*\r?\n/)
    .map((p) =>
      p
        .split(/\r?\n/)
        .filter((l) => !/^\s*(#{1,6}\s|[-=]{3,}\s*$|!\[|<|```|\|)/.test(l))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((p) => p.length > 0);
  const first = paras[0] ?? '';
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return `${(stop > max * 0.5 ? cut.slice(0, stop + 1) : cut).trim()}…`;
}

/**
 * Short description for a folder: its README, else the header comment of its entry file
 * (index/main/mod) or its most-called file.
 * @param {FileGraph} graph
 * @param {string} folderPath
 */
export async function describeFolder(graph, folderPath) {
  const root = getEffectiveWorkspaceRoot();
  const folder = normalizeMapPath(folderPath);
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README']) {
    const abs = resolveInWorkspace(root, folder ? `${folder}/${name}` : name);
    if (!abs) continue;
    const text = await readHead(abs, 8 * 1024);
    const para = firstParagraph(text);
    if (para) return { text: para, source: folder ? `${folder}/${name}` : name };
  }

  const direct = [...graph.files.keys()].filter((f) => dirOf(f) === folder);
  const entry = direct.find((f) => /^(index|main|mod|__init__)\.[a-z]+$/i.test(baseName(f)));
  const inCalls = new Map();
  for (const edge of graph.edges) {
    if (dirOf(edge.dst) === folder) inCalls.set(edge.dst, (inCalls.get(edge.dst) ?? 0) + edge.n);
  }
  const ranked = [...inCalls.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const candidates = [...new Set([entry, ...ranked.slice(0, 3)].filter(Boolean))];
  for (const file of candidates) {
    const text = await describeFile(file);
    if (text) return { text, source: file };
  }
  return null;
}

/** Header comment of one workspace file, or '' when it has none. */
export async function describeFile(filePath) {
  const abs = resolveInWorkspace(getEffectiveWorkspaceRoot(), filePath);
  if (!abs) return '';
  return extractHeaderComment(await readHead(abs, 8 * 1024));
}

// ── External packages ────────────────────────────────────────────────────────

const JS_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|^\s*export\s+\*\s+from\s*)['"]([^'"\n]+)['"]/gm;
const PY_IMPORT_RE = /^[ \t]*(?:from[ \t]+([A-Za-z_]\w*)[\w.]*[ \t]+import\b|import[ \t]+([A-Za-z_]\w*))/gm;

/**
 * Package root for an import specifier, or null for relative, aliased and builtin imports.
 * @param {string} spec
 */
export function packageNameFromSpecifier(spec) {
  const s = String(spec ?? '').trim();
  if (!s || s.startsWith('.') || s.startsWith('/') || s.startsWith('#') || s.startsWith('~')) return null;
  if (s.startsWith('node:') || s.startsWith('virtual:') || s.startsWith('bun:')) return null;
  if (/^[a-z]+:\/\//i.test(s)) return null;
  const parts = s.split('/');
  let name;
  if (s.startsWith('@')) {
    if (parts.length < 2 || parts[0] === '@') return null;
    name = `${parts[0]}/${parts[1]}`;
  } else {
    name = parts[0];
  }
  if (NODE_BUILTINS.has(name)) return null;
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return null;
  return name;
}

/**
 * Package imports declared near the top of a source file.
 * @param {string} text
 * @param {string} file
 */
export function scanImports(text, file) {
  const out = new Set();
  if (file.endsWith('.py')) {
    for (const m of String(text).matchAll(PY_IMPORT_RE)) {
      const name = m[1] ?? m[2];
      if (name && !PYTHON_STDLIB.has(name)) out.add(name);
    }
    return out;
  }
  for (const m of String(text).matchAll(JS_IMPORT_RE)) {
    const name = packageNameFromSpecifier(m[1]);
    if (name) out.add(name);
  }
  return out;
}

/** Package names the workspace itself declares (monorepo members), which are not external. */
async function workspacePackageNames(root) {
  const names = new Set();
  const abs = resolveInWorkspace(root, 'package.json');
  if (!abs) return names;
  try {
    const pkg = JSON.parse(await fs.readFile(abs, 'utf8'));
    if (typeof pkg.name === 'string') names.add(pkg.name);
  } catch {
    // no package.json — nothing to exclude
  }
  return names;
}

/**
 * Package imports per file for the whole graph (read once per index state).
 * @param {FileGraph} graph
 */
async function scanGraphImports(graph) {
  const root = getEffectiveWorkspaceRoot();
  const own = await workspacePackageNames(root);
  const files = [...graph.files.keys()].filter((f) => SCAN_EXTENSIONS.has(path.extname(f).toLowerCase()));
  /** @type {Map<string, Set<string>>} */
  const byFile = new Map();
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      const abs = resolveInWorkspace(root, file);
      if (!abs) continue;
      const found = scanImports(await readHead(abs), file);
      for (const name of own) found.delete(name);
      if (found.size) byFile.set(file, found);
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return byFile;
}

/**
 * External packages used by each architecture module (count of importing files).
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {Map<string, string>} moduleOfFile
 * @param {number} [limit]
 */
export async function loadModuleExternals(db, repo, moduleOfFile, limit = 16) {
  const entry = loadFileGraphEntry(db, repo);
  if (!entry.externals) {
    entry.externals = scanGraphImports(entry.graph).catch(() => new Map());
  }
  const byFile = await entry.externals;
  /** @type {Map<string, { name: string, files: number, testFiles: number, modules: Record<string, number> }>} */
  const packages = new Map();
  for (const [file, names] of byFile) {
    const mod = moduleOfFile.get(file);
    if (!mod) continue;
    const test = isTestPath(file);
    for (const name of names) {
      let pkg = packages.get(name);
      if (!pkg) {
        pkg = { name, files: 0, testFiles: 0, modules: {} };
        packages.set(name, pkg);
      }
      if (test) pkg.testFiles += 1;
      else pkg.files += 1;
      pkg.modules[mod] = (pkg.modules[mod] ?? 0) + 1;
    }
  }
  return [...packages.values()]
    .sort((a, b) => b.files - a.files || b.testFiles - a.testFiles)
    .slice(0, limit);
}

// ── File detail ──────────────────────────────────────────────────────────────

/**
 * Symbols of one file (with nesting depth from line ranges) plus its file-level call links.
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {string} filePath
 */
export async function loadFileDetail(db, repo, filePath) {
  const file = normalizeMapPath(filePath);
  const graph = loadFileGraph(db, repo);
  const stat = graph.files.get(file);
  if (!stat) return null;
  const rows = db
    .prepare(
      `SELECT id, name, kind, line_start, line_end, signature, doc, pagerank, usage_count
       FROM symbols WHERE repo = ? AND (file = ? OR file = ?)
       ORDER BY line_start, line_end DESC`,
    )
    .all(repo, file, file.replace(/\//g, '\\'));
  /** @type {Array<{ end: number }>} */
  const stack = [];
  const symbols = rows.map((row) => {
    while (stack.length && stack[stack.length - 1].end < row.line_start) stack.pop();
    const depth = stack.length;
    stack.push({ end: row.line_end });
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      line: row.line_start,
      lineEnd: row.line_end,
      signature: row.signature,
      doc: row.doc ?? '',
      rank: row.pagerank ?? 0,
      usage: row.usage_count ?? 0,
      depth,
    };
  });
  const links = fileLinks(graph, file);
  return {
    path: file,
    lines: stat.lines,
    symbolCount: stat.symbols,
    summary: await describeFile(file),
    symbols,
    callers: links.callers.slice(0, 24),
    callees: links.callees.slice(0, 24),
    callerCount: links.callers.length,
    calleeCount: links.callees.length,
  };
}

// ── Route entry ──────────────────────────────────────────────────────────────

/**
 * Serve one code map view for the active workspace.
 * @param {'architecture' | 'folder' | 'file' | 'search'} view
 * @param {URLSearchParams} params
 * @returns {Promise<unknown | undefined>} undefined for an unknown view
 */
export async function runCodeMapQuery(view, params) {
  const repo = activeRepoKey();
  const db = getCodeDb(repo);

  if (view === 'architecture') {
    await ensureIndexFreshForQuery();
    const graph = loadFileGraph(db, repo);
    const baseParam = params.get('base');
    const arch = buildArchitecture(graph, baseParam != null ? { base: baseParam } : {});
    const externals = await loadModuleExternals(db, repo, arch.moduleOfFile);
    let symbolTotal = 0;
    for (const stat of graph.files.values()) symbolTotal += stat.symbols;
    return {
      repo,
      base: arch.base,
      fileCount: graph.files.size,
      symbolCount: symbolTotal,
      groups: arch.groups,
      modules: arch.modules,
      edges: arch.edges,
      externals,
    };
  }

  if (view === 'folder') {
    const graph = loadFileGraph(db, repo);
    const folder = normalizeMapPath(params.get('path') ?? '');
    const payload = buildFolderView(graph, folder);
    return { ...payload, summary: await describeFolder(graph, folder) };
  }

  if (view === 'file') {
    const detail = await loadFileDetail(db, repo, params.get('path') ?? '');
    return detail ?? { error: 'file not indexed' };
  }

  if (view === 'search') {
    const graph = loadFileGraph(db, repo);
    const limit = Math.max(1, Math.min(40, Number(params.get('limit') ?? 12) || 12));
    return { paths: searchMapPaths(graph, params.get('query') ?? '', limit) };
  }

  return undefined;
}
