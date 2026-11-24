/**
 * What a task actually changed, read from git at its merge commit.
 */

import { runProcess } from '../process-runner.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';

const GIT_TIMEOUT_MS = 20_000;

/** Bounded because a task can merge a vendored directory. */
const MAX_FILES = 400;

/** Bounded for the same reason `capDiffText` exists: one file can be enormous. */
const MAX_DIFF_LINES = 4_000;

/**
 * A sha reaches here from HTTP, so it is never interpolated into an argv unchecked.
 * @param {unknown} sha
 * @returns {string | null}
 */
export function safeSha(sha) {
  const value = String(sha ?? '').trim();
  return /^(?:[0-9a-fA-F]{7,40}|[0-9a-fA-F]{64})$/.test(value) ? value : null;
}

/**
 * Repo-relative, no traversal, no leading dash.
 *
 * @param {unknown} filePath
 * @returns {string | null}
 */
export function safeRepoPath(filePath) {
  const value = String(filePath ?? '').trim();
  if (!value || value.length > 1024) return null;
  if (value.startsWith('-') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  if (value.split(/[\\/]/).includes('..')) return null;
  return value;
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function git(args, cwd) {
  try {
    const result = await runProcess('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
    return result.code === 0 ? String(result.stdout ?? '') : '';
  } catch {
    return '';
  }
}

/**
 * `-m --first-parent` is load-bearing.
 * @param {string} sha
 * @returns {string[]}
 */
function showArgs(sha) {
  return ['show', '--no-renames', '-m', '--first-parent', '--format=format:', '-1', sha];
}

/**
 * Per-file line counts for one commit.
 *
 * @param {string} sha
 * @param {string} [cwd]
 * @returns {Promise<{ sha: string, files: Array<{ path: string, additions: number,
 *                     deletions: number, binary: boolean }>,
 *                     additions: number, deletions: number, truncated: boolean } | null>}
 */
export async function readCommitFileStats(sha, cwd = getEffectiveWorkspaceRoot(), beforeSha) {
  const rev = safeSha(sha);
  if (!rev || !cwd) return null;

  const base = safeSha(beforeSha);
  const args = base ? ['diff', '--no-renames', base, rev] : showArgs(rev);
  const numstat = await git([...args, '--numstat'], cwd);
  if (!numstat.trim()) return null;

  /** @type {Array<{ path: string, additions: number, deletions: number, binary: boolean }>} */
  const files = [];
  let additions = 0;
  let deletions = 0;
  for (const raw of numstat.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addRaw, delRaw] = parts;
    const filePath = parts.slice(2).join('\t').trim();
    if (!filePath) continue;
    const binary = addRaw === '-' || delRaw === '-';
    const add = binary ? 0 : Number(addRaw);
    const del = binary ? 0 : Number(delRaw);
    if (!binary && (!Number.isFinite(add) || !Number.isFinite(del))) continue;
    additions += add;
    deletions += del;
    files.push({ path: filePath, additions: add, deletions: del, binary });
  }
  if (files.length === 0) return null;

  files.sort((a, b) => a.path.localeCompare(b.path));
  const truncated = files.length > MAX_FILES;
  return {
    sha: rev,
    files: truncated ? files.slice(0, MAX_FILES) : files,
    additions,
    deletions,
    truncated,
  };
}

/**
 * Turn one file's unified patch into the rows `renderUnifiedPromptDiff` draws.
 * @param {string} patch
 * @returns {{ lines: Array<{ type: 'unchanged' | 'add' | 'remove', text: string }>,
 *             truncated: boolean }}
 */
export function patchToDiffLines(patch) {
  /** @type {Array<{ type: 'unchanged' | 'add' | 'remove', text: string }>} */
  const lines = [];
  let inHunk = false;
  for (const raw of String(patch ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@')) {
      inHunk = true;
      lines.push({ type: 'unchanged', text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) lines.push({ type: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) lines.push({ type: 'remove', text: line.slice(1) });
    else if (line.startsWith(' ')) lines.push({ type: 'unchanged', text: line.slice(1) });
    else if (line.startsWith('\\')) continue;
    else if (line === '') lines.push({ type: 'unchanged', text: '' });
    else inHunk = false;
  }
  const truncated = lines.length > MAX_DIFF_LINES;
  return { lines: truncated ? lines.slice(0, MAX_DIFF_LINES) : lines, truncated };
}

/**
 * One file's diff at one commit.
 *
 * @param {string} sha
 * @param {string} filePath
 * @param {string} [cwd]
 * @returns {Promise<{ path: string, lines: Array<{ type: string, text: string }>,
 *                     truncated: boolean } | null>}
 */
export async function readCommitFileDiff(sha, filePath, cwd = getEffectiveWorkspaceRoot(), beforeSha) {
  const rev = safeSha(sha);
  const target = safeRepoPath(filePath);
  if (!rev || !target || !cwd) return null;
  const base = safeSha(beforeSha);
  const args = base ? ['diff', '--no-renames', base, rev] : showArgs(rev);
  const patch = await git([...args, '--unified=3', '--', ':(literal)' + target], cwd);
  if (!patch.trim()) return null;
  const { lines, truncated } = patchToDiffLines(patch);
  if (lines.length === 0) return null;
  return { path: target, lines, truncated };
}
