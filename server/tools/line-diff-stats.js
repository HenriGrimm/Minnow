/**
 * Line-level add/delete counts and capped unified diff payloads for file mutations.
 */

import { diffLines } from 'diff';

/** Max diff lines returned in tool payloads (session size guard). */
export const MAX_CODE_CHANGE_DIFF_LINES = 500;

/** Normalize line endings and trailing whitespace before compare. */
export function normalizeDiffText(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();
}

/**
 * Build unified diff line objects for the client renderer.
 * @param {string} before
 * @param {string} after
 * @returns {{ lines: Array<{ type: 'unchanged' | 'add' | 'remove'; text: string }>; truncated: boolean }}
 */
export function buildDiffLines(before, after) {
  const parts = diffLines(normalizeDiffText(before), normalizeDiffText(after), {
    newlineIsToken: false,
  });
  const lines = [];
  for (const part of parts) {
    const split = part.value.split('\n');
    if (split.length > 0 && split[split.length - 1] === '') {
      split.pop();
    }
    const type = part.added ? 'add' : part.removed ? 'remove' : 'unchanged';
    for (const text of split) {
      lines.push({ type, text });
    }
  }
  if (lines.length <= MAX_CODE_CHANGE_DIFF_LINES) {
    return { lines, truncated: false };
  }
  return {
    lines: lines.slice(0, MAX_CODE_CHANGE_DIFF_LINES),
    truncated: true,
  };
}

/**
 * Count added and removed lines between two file bodies.
 * @param {string} before
 * @param {string} after
 * @returns {{ additions: number; deletions: number }}
 */
export function countLineChangeStats(before, after) {
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(normalizeDiffText(before), normalizeDiffText(after))) {
    if (part.added) additions += part.count ?? 0;
    else if (part.removed) deletions += part.count ?? 0;
  }
  return { additions, deletions };
}

/** Line count for normalized text (empty string → 0). */
export function countLinesInText(text) {
  const normalized = normalizeDiffText(text);
  if (!normalized) return 0;
  return normalized.split('\n').length;
}

/** Append-only mutation: additions = inserted lines, deletions = 0. */
export function countAppendLineStats(content) {
  return { additions: countLinesInText(content), deletions: 0 };
}

/** Add-only diff lines for append/insert tools. */
export function buildAddOnlyDiffLines(content) {
  const normalized = normalizeDiffText(content);
  if (!normalized) return { lines: [], truncated: false };
  const rawLines = normalized.split('\n');
  const lines = rawLines.map((text) => ({ type: 'add', text }));
  if (lines.length <= MAX_CODE_CHANGE_DIFF_LINES) {
    return { lines, truncated: false };
  }
  return {
    lines: lines.slice(0, MAX_CODE_CHANGE_DIFF_LINES),
    truncated: true,
  };
}

/** Remove-only diff lines for deleted files. */
export function buildRemoveOnlyDiffLines(content) {
  const normalized = normalizeDiffText(content);
  if (!normalized) return { lines: [], truncated: false };
  const rawLines = normalized.split('\n');
  const lines = rawLines.map((text) => ({ type: 'remove', text }));
  if (lines.length <= MAX_CODE_CHANGE_DIFF_LINES) {
    return { lines, truncated: false };
  }
  return {
    lines: lines.slice(0, MAX_CODE_CHANGE_DIFF_LINES),
    truncated: true,
  };
}

/**
 * Build optional codeChange payload when stats are non-zero.
 * @param {string} before
 * @param {string} after
 * @param {string} relativePath
 * @param {object} [options]
 * @param {string} [options.source]
 * @returns {object | undefined}
 */
export function codeChangeFromDiff(before, after, relativePath, options = {}) {
  const { additions, deletions } = countLineChangeStats(before, after);
  if (additions === 0 && deletions === 0) return undefined;
  const { lines, truncated } = buildDiffLines(before, after);
  return {
    additions,
    deletions,
    path: relativePath,
    source: options.source ?? 'file-tool',
    diffLines: lines,
    diffTruncated: truncated,
  };
}

/**
 * Build codeChange from explicit stats and optional diff lines.
 * @param {object} params
 * @returns {object | undefined}
 */
export function buildCodeChangePayload(params) {
  const additions = Number(params.additions) || 0;
  const deletions = Number(params.deletions) || 0;
  if (additions === 0 && deletions === 0) return undefined;
  const out = {
    additions,
    deletions,
    source: params.source ?? 'file-tool',
  };
  if (typeof params.path === 'string' && params.path.trim()) {
    out.path = params.path.trim();
  }
  if (Array.isArray(params.paths) && params.paths.length > 0) {
    out.paths = params.paths.map(String);
  }
  if (Array.isArray(params.diffLines) && params.diffLines.length > 0) {
    out.diffLines = params.diffLines;
    out.diffTruncated = Boolean(params.diffTruncated);
  }
  return out;
}
