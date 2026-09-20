import fs from 'node:fs/promises';
import path from 'node:path';
import { getRipgrepPath } from '../lib/ripgrep-path.js';
import {
  RG_MAX_STDOUT_BYTES,
  RG_TIMEOUT_MS,
  runRipgrep,
} from '../lib/ripgrep-run.js';
import { getToolAbortSignal } from '../runtime/path-access.js';
import { truncateUtf8 } from '../../src/lib/fetch-web-content.mjs';
import {
  GREP_MAX_LINE_CHARS,
  GREP_MAX_OUTPUT_CHARS,
  capLineLength,
  getOutputCapPolicy,
  withFullResultFooterHint,
} from './output-cap.js';

const rgExecutable = getRipgrepPath();

export const GREP_DEFAULT_HEAD_LIMIT = 500;

export const GREP_MAX_HEAD_LIMIT = 2_000;

export const FIND_FILES_DEFAULT_MAX = 2_000;

export { GREP_MAX_OUTPUT_CHARS, GREP_MAX_LINE_CHARS };

const GREP_MAX_FILE_BYTES = '2M';

const VALID_OUTPUT_MODES = new Set(['content', 'count', 'files_with_matches', 'grouped']);

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * @param {string} text
 */
function escapeRegexLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} line
 */
export function isRipgrepMatchLine(line) {
  if (!line || line === '--') return false;
  if (/^[^:\n]+:\d+:/.test(line)) return true;
  return /^\d+:/.test(line);
}

/**
 * @param {string} stdout
 * @param {{ offset?: number, headLimit?: number, maxLineChars?: number, maxOutputChars?: number, }} [options]
 * @returns {{ text: string, truncated: boolean, lineCount: number, nextOffset: number }}
 */
export function capGrepOutput(stdout, options = {}) {
  const policy = getOutputCapPolicy();
  const applyResultCap = options.applyResultCap ?? policy.applyResultCap;
  const offset = Math.max(0, options.offset ?? 0);
  const explicitHead = options.explicitHeadLimit === true;
  const headLimit =
    explicitHead || applyResultCap
      ? (options.headLimit ?? GREP_DEFAULT_HEAD_LIMIT)
      : Number.MAX_SAFE_INTEGER;
  const maxLineChars = applyResultCap
    ? (options.maxLineChars ?? GREP_MAX_LINE_CHARS)
    : Number.MAX_SAFE_INTEGER;
  const maxOutputChars = applyResultCap
    ? (options.maxOutputChars ?? GREP_MAX_OUTPUT_CHARS)
    : Number.MAX_SAFE_INTEGER;

  const lines = stdout.split(/\r?\n/);
  const kept = [];
  let skipped = 0;
  let totalChars = 0;
  let truncated = false;

  for (const rawLine of lines) {
    if (rawLine === '') continue;

    if (skipped < offset) {
      skipped += 1;
      continue;
    }

    if (kept.length >= headLimit) {
      truncated = true;
      break;
    }

    const line = applyResultCap ? capLineLength(rawLine, maxLineChars) : rawLine;
    const addedChars = line.length + (kept.length > 0 ? 1 : 0);
    if (applyResultCap && totalChars + addedChars > maxOutputChars) {
      truncated = true;
      break;
    }

    kept.push(line);
    totalChars += addedChars;
  }

  let text = kept.join('\n');
  const lineCount = kept.length;
  const nextOffset = offset + lineCount;

  if (truncated) {
    const canRaiseLimit = applyResultCap && GREP_DEFAULT_HEAD_LIMIT < GREP_MAX_HEAD_LIMIT;
    const pageHint =
      lineCount > 0
        ? canRaiseLimit
          ? `use offset=${nextOffset} for the next page or raise head_limit (max ${GREP_MAX_HEAD_LIMIT})`
          : `use offset=${nextOffset} for the next page`
        : `use offset=${offset} with a smaller head_limit`;
    const hint = withFullResultFooterHint(pageHint, applyResultCap);
    text = `${text}\n(truncated at ${lineCount} match lines, default head_limit=${GREP_DEFAULT_HEAD_LIMIT}; ${hint})`;
  }

  if (applyResultCap) {
    const beforeUtf8 = text;
    text = truncateUtf8(text, maxOutputChars);
    if (text !== beforeUtf8) {
      truncated = true;
    }
  }

  return { text, truncated, lineCount, nextOffset };
}

/**
 * @deprecated
 * @param {string} stdout
 * @param {number} maxMatchLines
 */
export function truncateRipgrepOutput(stdout, maxMatchLines) {
  return capGrepOutput(stdout, { headLimit: maxMatchLines });
}

/**
 * @param {string} cappedText
 */
export function formatGroupedGrepOutput(cappedText) {
  const rawLines = cappedText.split('\n');
  const truncationFooter = rawLines.find((line) => line.startsWith('(truncated'));
  const lines = rawLines.filter((line) => line && !line.startsWith('(truncated'));

  /** @type {Map<string, Array<{ lineNum: string; snippet: string }>>} */
  const groups = new Map();
  let currentFile = '';

  for (const line of lines) {
    const withPath = line.match(/^(.+?):(\d+):(.*)$/);
    if (withPath) {
      const [, filePath, lineNum, snippet] = withPath;
      if (!groups.has(filePath)) groups.set(filePath, []);
      groups.get(filePath).push({ lineNum, snippet });
      currentFile = filePath;
      continue;
    }
    const lineOnly = line.match(/^(\d+):(.*)$/);
    if (lineOnly && currentFile) {
      const [, lineNum, snippet] = lineOnly;
      groups.get(currentFile).push({ lineNum, snippet });
    }
  }

  const blocks = [];
  for (const [filePath, matches] of groups) {
    blocks.push(filePath);
    for (const { lineNum, snippet } of matches) {
      blocks.push(`  ${lineNum}: ${snippet}`);
    }
    blocks.push('');
  }

  let text = blocks.join('\n').replace(/\n+$/, '');
  if (truncationFooter) {
    text = `${text}\n${truncationFooter}`;
  }
  return text;
}

/**
 * Drop the `\r` ripgrep carries out of a CRLF file at the end of every match line.
 *
 * It is invisible until something downstream uses `$` or `.` against it — both treat
 * `\r` as a line terminator, so `formatGroupedGrepOutput` silently *dropped* any line
 * that still had one. Only the last line used to keep its `\r` (the rest were eaten by
 * the trailing `.trim()`), which is why this stayed hidden while rg sorted its own
 * output. Normalizing once here keeps every consumer below from having to care.
 *
 * @param {string} stdout
 * @returns {string}
 */
function stripCarriageReturns(stdout) {
  return stdout.replace(/\r(?=\n)|\r$/g, '');
}

/**
 * Footer for a result ripgrep was killed part-way through.
 *
 * Says the set is incomplete *and* that ordering can no longer be trusted, because a
 * killed parallel run is a prefix of what the threads happened to finish, not of the
 * sorted whole — so `offset` paging does not line up against it.
 *
 * @param {import('../lib/ripgrep-run.js').RipgrepStopReason} stopped
 * @param {'grep' | 'find'} label
 * @returns {string}
 */
function partialRunNote(stopped, label) {
  if (stopped === 'timeout') {
    return `(partial: ${label} was stopped after ${Math.round(RG_TIMEOUT_MS / 1000)}s. These are the matches found so far, in arbitrary order — narrow with path= or glob= for a complete, pageable result.)`;
  }
  if (stopped === 'overflow') {
    return `(partial: the result set passed ${Math.round(RG_MAX_STDOUT_BYTES / (1024 * 1024))}MB and ${label} was stopped. These are the matches found so far, in arbitrary order — narrow with path= or glob= for a complete, pageable result.)`;
  }
  return '';
}

/**
 * Globs that mean "everything", which must never be passed to ripgrep as `-g`.
 *
 * A `-g` glob is an *override*, and an override that whitelists every path beats the
 * ignore files: `rg --files -g '**' + '/*'` returned 153,539 paths in this repo against
 * 7,775 for a plain `rg --files`, 123,084 of them from `node_modules`. Every narrower
 * glob (`**' + '/*.ts`, `src/**`) respects `.gitignore` as expected, so this is the one
 * shape that has to be dropped instead of forwarded — "every file" should mean the same
 * set the other patterns are filtered out of.
 */
const MATCH_EVERYTHING_GLOBS = new Set(['*', '**', '*/*', '**/*', '**/**']);

/**
 * @param {string} glob
 * @returns {boolean}
 */
export function isMatchEverythingGlob(glob) {
  const normalized = String(glob ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  return MATCH_EVERYTHING_GLOBS.has(normalized);
}

/** `path:12:text` — the only ripgrep line shape that names its own file. */
const MATCH_LINE_PATH = /^(.*?):(\d+):/;

/**
 * Restore `--sort path` ordering in JS, so `offset` pages line up across calls.
 *
 * Ripgrep writes each file's lines contiguously and in line order even with threads,
 * so path order is recovered by grouping on the file a *match* line names and stably
 * sorting the groups. Context lines (`path-11-text`) and `--` separators are not
 * parsed: they are carried with the block they were emitted against, which is both
 * cheaper and safer than guessing where a `-`-separated path ends.
 *
 * @param {string} text
 * @param {string} outputMode
 * @returns {string}
 */
export function sortRipgrepOutputByPath(text, outputMode = 'content') {
  // `files_with_matches` lines are bare paths and `count` lines are `path:42`, one per
  // file, so a plain line sort is already path order for both.
  if (outputMode === 'files_with_matches' || outputMode === 'count') {
    return text.split('\n').filter(Boolean).sort().join('\n');
  }

  /** @type {Array<{ path: string, lines: string[] }>} */
  const groups = [];
  /** @type {Map<string, { path: string, lines: string[] }>} */
  const byPath = new Map();
  /** @type {{ path: string, lines: string[] } | null} */
  let current = null;
  /** Lines seen before their file is known — leading context, separators. */
  let pending = [];

  function openGroup(filePath) {
    let group = byPath.get(filePath);
    if (!group) {
      group = { path: filePath, lines: [] };
      byPath.set(filePath, group);
      groups.push(group);
    }
    return group;
  }

  for (const line of text.split('\n')) {
    if (!line) continue;

    // Checked first so a match line whose *content* happens to contain `:12:` cannot
    // be mistaken for the start of a new file.
    if (current && (line.startsWith(`${current.path}:`) || line.startsWith(`${current.path}-`))) {
      current.lines.push(line);
      continue;
    }

    const match = MATCH_LINE_PATH.exec(line);
    if (!match) {
      pending.push(line);
      continue;
    }

    current = openGroup(match[1]);
    if (pending.length > 0) {
      current.lines.push(...pending);
      pending = [];
    }
    current.lines.push(line);
  }

  if (pending.length > 0) {
    (current ?? openGroup('')).lines.push(...pending);
  }

  groups.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return groups.flatMap((group) => group.lines).join('\n');
}

/**
 * @param {{ outputMode: string, literal: boolean, caseInsensitive: boolean, context: number, glob: string, maxCount: number, }} opts
 */
function buildRipgrepArgs(opts) {
  // No `--sort`: it makes ripgrep walk the tree on a single thread, which measured
  // 5x slower warm and ~20x slower on a cold file cache (a board agent's fresh
  // worktree is always cold). Path order is restored by `sortRipgrepOutputByPath`
  // over the collected output, which `capGrepOutput` already has to walk anyway.
  const rgArgs = ['--max-filesize', GREP_MAX_FILE_BYTES, '--path-separator', '/'];

  if (opts.outputMode === 'content') {
    rgArgs.push('-n', '--no-heading');
    if (opts.context > 0) {
      rgArgs.push('-C', String(opts.context));
    }
  } else if (opts.outputMode === 'count') {
    rgArgs.push('--count');
  } else if (opts.outputMode === 'files_with_matches') {
    rgArgs.push('--files-with-matches');
  }

  if (opts.maxCount > 0) {
    rgArgs.push('--max-count', String(opts.maxCount));
  }

  if (opts.literal) {
    rgArgs.push('-F');
  }
  if (opts.caseInsensitive) {
    rgArgs.push('-i');
  }
  if (opts.glob && !isMatchEverythingGlob(opts.glob)) {
    rgArgs.push('-g', opts.glob);
  }

  return rgArgs;
}

/**
 * @param {Record<string, unknown>} args
 * @param {{ resolveSafePath: (p: string, opts?: { write?: boolean }) => string, toRelativePath: (abs: string) => string, getWorkspaceRoot: () => string, }} deps
 */
export async function runGrepSearch(args, deps) {
  const pattern = args?.pattern;
  if (!pattern || typeof pattern !== 'string') {
    return 'Error: pattern is required';
  }

  const literal = args?.literal === true;
  if (!literal) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: invalid regex: ${message}`;
    }
  }

  const policy = getOutputCapPolicy();
  const hasExplicitHead =
    args != null &&
    Object.prototype.hasOwnProperty.call(args, 'head_limit') &&
    args.head_limit != null;
  const headLimit = hasExplicitHead
    ? clampInt(
        args.head_limit,
        1,
        policy.applyResultCap ? GREP_MAX_HEAD_LIMIT : Number.MAX_SAFE_INTEGER,
        GREP_DEFAULT_HEAD_LIMIT,
      )
    : policy.applyResultCap
      ? GREP_DEFAULT_HEAD_LIMIT
      : Number.MAX_SAFE_INTEGER;
  const offset = clampInt(args?.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const context = clampInt(args?.context, 0, 5, 0);
  const caseInsensitive = args?.case_insensitive === true;
  const glob =
    typeof args?.glob === 'string' && args.glob.trim() ? args.glob.trim() : '';
  const outputModeRaw =
    typeof args?.output_mode === 'string' ? args.output_mode.trim() : 'content';
  const outputMode = VALID_OUTPUT_MODES.has(outputModeRaw)
    ? outputModeRaw
    : 'content';

  const resolved = deps.resolveSafePath(
    typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : '.',
  );
  const workspaceRoot = deps.getWorkspaceRoot();
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return `Error: path not found: ${deps.toRelativePath(resolved)}`;
  }

  const displayRoot = deps.toRelativePath(stat.isDirectory() ? resolved : path.dirname(resolved));

  const relTarget = path.relative(workspaceRoot, resolved);
  const searchTarget =
    relTarget === ''
      ? '.'
      : !relTarget.startsWith('..') && !path.isAbsolute(relTarget)
        ? relTarget
        : resolved;
  const rgPattern = literal ? escapeRegexLiteral(pattern) : pattern;

  const ripgrepMode = outputMode === 'grouped' ? 'content' : outputMode;
  const rgArgs = buildRipgrepArgs({
    outputMode: ripgrepMode,
    literal,
    caseInsensitive,
    context: ripgrepMode === 'content' ? context : 0,
    glob,
    // Per *file*, not per search — ripgrep's `-m` has no global form. It is a valve
    // against one pathological file, and cannot be lowered to trim the aggregate
    // without silently dropping real matches from a file that has many. The whole
    // result set is bounded by `runRipgrep`'s output ceiling instead.
    maxCount:
      ripgrepMode === 'content' && headLimit < 1_000_000 ? headLimit + offset : 0,
  });
  rgArgs.push(rgPattern, searchTarget);

  /** @type {import('../lib/ripgrep-run.js').RipgrepRunResult} */
  let run;
  try {
    run = await runRipgrep(rgExecutable, rgArgs, {
      cwd: workspaceRoot,
      signal: getToolAbortSignal(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error running grep: ${message}`;
  }

  const stdout = run.stdout;
  const hasOutput = stdout.trim().length > 0;

  if (run.stopped === 'aborted') {
    return 'Search was stopped before it finished.';
  }
  // Every other stop still carries real matches, so they are served with a note
  // rather than thrown away — a partial answer beats an error the agent must retry.
  if (run.stopped && !hasOutput) {
    return run.stopped === 'timeout'
      ? `Error: grep for "${pattern}" under ${displayRoot} found nothing within ${Math.round(RG_TIMEOUT_MS / 1000)}s and was stopped. Narrow it with path= or glob=.`
      : `Error running grep: search output exceeded the ${Math.round(RG_MAX_STDOUT_BYTES / (1024 * 1024))}MB ceiling before any usable line arrived.`;
  }
  if (!run.stopped) {
    if (run.code === 1 && !hasOutput) {
      return `No matches for "${pattern}" under ${displayRoot}`;
    }
    if (run.code !== 0 && run.code !== 1 && !hasOutput) {
      const detail =
        run.stderr ||
        (run.code === null
          ? 'ripgrep was terminated before it produced any output'
          : `ripgrep exited with code ${run.code}`);
      return `Error running grep: ${detail}`;
    }
  }

  const trimmed = stripCarriageReturns(stdout).replace(/^\.\//gm, '').trim();
  if (!trimmed) {
    return `No matches for "${pattern}" under ${displayRoot}`;
  }

  const ordered = sortRipgrepOutputByPath(trimmed, outputMode);

  let { text } = capGrepOutput(ordered, {
    offset,
    headLimit,
    applyResultCap: policy.applyResultCap,
    explicitHeadLimit: hasExplicitHead,
    maxLineChars: GREP_MAX_LINE_CHARS,
    maxOutputChars: GREP_MAX_OUTPUT_CHARS,
  });

  if (outputMode === 'grouped') {
    text = formatGroupedGrepOutput(text);
  }

  const stopNote = partialRunNote(run.stopped, 'grep');
  return stopNote ? `${text}\n${stopNote}` : text;
}

/**
 * @param {Record<string, unknown>} args
 * @param {{ resolveSafePath: (p: string, opts?: { write?: boolean }) => string, toRelativePath: (abs: string) => string, getWorkspaceRoot: () => string, }} deps
 * @param {{ maxResults?: number }} [options]
 */
export async function runFindFilesSearch(args, deps, options = {}) {
  const pattern = typeof args?.pattern === 'string' ? args.pattern.trim() : '';
  if (!pattern) {
    return 'Error: pattern is required';
  }
  const findPolicy = getOutputCapPolicy();
  const maxResults =
    options.maxResults ??
    (findPolicy.applyResultCap ? FIND_FILES_DEFAULT_MAX : Number.MAX_SAFE_INTEGER);

  const resolved = deps.resolveSafePath(
    typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : '.',
  );
  const workspaceRoot = deps.getWorkspaceRoot();
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return `Error: path not found: ${deps.toRelativePath(resolved)}`;
  }
  const searchDir = stat.isDirectory() ? resolved : path.dirname(resolved);
  const displayRoot = deps.toRelativePath(searchDir);

  const relTarget = path.relative(workspaceRoot, searchDir);
  const target =
    relTarget === ''
      ? '.'
      : !relTarget.startsWith('..') && !path.isAbsolute(relTarget)
        ? relTarget
        : searchDir;

  const globNorm = pattern.replace(/\\/g, '/');
  const rgArgs = ['--files', '--path-separator', '/'];
  if (!isMatchEverythingGlob(globNorm)) {
    rgArgs.push('-g', globNorm);
  }
  if (target !== '.') {
    rgArgs.push(target);
  }

  /** @type {import('../lib/ripgrep-run.js').RipgrepRunResult} */
  let run;
  try {
    run = await runRipgrep(rgExecutable, rgArgs, {
      cwd: workspaceRoot,
      signal: getToolAbortSignal(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error running find: ${message}`;
  }

  if (run.stopped === 'aborted') {
    return 'Search was stopped before it finished.';
  }

  const files = run.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'));

  if (files.length === 0) {
    if (run.stopped === 'timeout') {
      return `Error: find for "${pattern}" under ${displayRoot} found nothing within ${Math.round(RG_TIMEOUT_MS / 1000)}s and was stopped. Narrow it with path=.`;
    }
    if (!run.stopped && run.code !== 0 && run.code !== 1) {
      const detail =
        run.stderr ||
        (run.code === null
          ? 'ripgrep was terminated before it produced any output'
          : `ripgrep exited with code ${run.code}`);
      return `Error running find: ${detail}`;
    }
    return `No files matching "${pattern}" under ${displayRoot}`;
  }

  // `rg --files` is unordered without `--sort`, which made the cap below return an
  // arbitrary 2000 of the matches. Sorting here makes the truncation deterministic
  // for the cost of one sort over paths already in memory.
  files.sort();

  const limited = files.slice(0, maxResults);
  const parts = [limited.join('\n')];
  if (files.length > maxResults) {
    parts.push(`(truncated at ${maxResults} results)`);
  }
  const stopNote = partialRunNote(run.stopped, 'find');
  if (stopNote) parts.push(stopNote);
  return parts.join('\n');
}
