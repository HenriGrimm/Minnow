/**
 * Normalize server / persisted codeChange payloads for ledger and UI.
 */

import type { CodeChangeDiffLine, CodeChangeSource, CodeChangeStats } from '../types';

const CODE_CHANGE_SOURCES = new Set<CodeChangeSource>([
  'file-tool',
  'git-commit',
  'command-snapshot',
  'command-heuristic',
  'backfill',
]);

function normalizeDiffLines(raw: unknown): CodeChangeDiffLine[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const lines: CodeChangeDiffLine[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const type = (row as { type?: string }).type;
    const text = (row as { text?: string }).text;
    if (type !== 'add' && type !== 'remove' && type !== 'unchanged') continue;
    lines.push({ type, text: text != null ? String(text) : '' });
  }
  return lines.length > 0 ? lines : undefined;
}

/** Validate and coerce a codeChange object from API or session JSON. */
export function normalizeCodeChangePayload(raw: unknown): CodeChangeStats | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const additions = Number(row.additions);
  const deletions = Number(row.deletions);
  if (!Number.isFinite(additions) || !Number.isFinite(deletions)) return undefined;
  if (additions === 0 && deletions === 0) return undefined;

  const out: CodeChangeStats = { additions, deletions };
  for (const key of ['workspacePath', 'gitBranch', 'commitSha'] as const) {
    if (typeof row[key] === 'string' && row[key].trim()) out[key] = row[key].trim();
  }
  if (Array.isArray(row.files)) {
    out.files = row.files.flatMap((file) => {
      if (!file || typeof file.path !== 'string' || !file.path.trim() ||
        !Number.isFinite(file.additions) || !Number.isFinite(file.deletions)) return [];
      return [{ path: file.path, additions: file.additions, deletions: file.deletions }];
    });
  }

  const path = typeof row.path === 'string' && row.path.trim() ? row.path.trim() : undefined;
  if (path) out.path = path;

  if (Array.isArray(row.paths)) {
    const paths = row.paths
      .map((p) => (typeof p === 'string' && p.trim() ? p.trim() : ''))
      .filter(Boolean);
    if (paths.length > 0) out.paths = paths;
  }

  const source = row.source;
  if (typeof source === 'string' && CODE_CHANGE_SOURCES.has(source as CodeChangeSource)) {
    out.source = source as CodeChangeSource;
  }

  const diffLines = normalizeDiffLines(row.diffLines);
  if (diffLines) {
    out.diffLines = diffLines;
    out.diffTruncated = Boolean(row.diffTruncated);
  }

  return out;
}
