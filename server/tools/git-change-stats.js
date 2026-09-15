/**
 * Parse git numstat output and build codeChange payloads for commits.
 */

import { runProcess } from '../process-runner.js';
import { buildCodeChangePayload } from './line-diff-stats.js';

/**
 * Parse `git show --numstat` / `git diff --numstat` tab-separated rows.
 * @param {string} text
 * @returns {{ additions: number; deletions: number; paths: string[] }}
 */
export function parseGitNumstat(text) {
  let additions = 0;
  let deletions = 0;
  const paths = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const addRaw = parts[0];
    const delRaw = parts[1];
    const filePath = parts.slice(2).join('\t').trim();
    if (!filePath || addRaw === '-' || delRaw === '-') continue;
    const add = Number(addRaw);
    const del = Number(delRaw);
    if (!Number.isFinite(add) || !Number.isFinite(del)) continue;
    additions += add;
    deletions += del;
    paths.push(filePath);
  }
  return { additions, deletions, paths };
}

/**
 * Run git in workspace cwd; returns stdout string or empty on failure.
 * @param {string} cwd
 * @param {string[]} args
 */
async function gitStdout(cwd, args) {
  try {
    const result = await runProcess('git', args, { cwd });
    return String(result.stdout ?? '');
  } catch {
    return '';
  }
}

/** True when workspace root is inside a git repository. */
export async function isGitRepository(cwd) {
  const out = await gitStdout(cwd, ['rev-parse', '--is-inside-work-tree']);
  return out.trim() === 'true';
}

/**
 * Build codeChange for HEAD commit or explicit sha.
 * @param {string} cwd
 * @param {string} [sha] defaults to HEAD
 */
export async function codeChangeForGitCommit(cwd, sha = 'HEAD') {
  const rev = sha && String(sha).trim() ? String(sha).trim() : 'HEAD';
  const numstat = await gitStdout(cwd, ['show', '--numstat', '--format=format:', '-1', rev]);
  const { additions, deletions, paths } = parseGitNumstat(numstat);
  if (additions === 0 && deletions === 0) return undefined;
  const payload = buildCodeChangePayload({
    additions,
    deletions,
    paths,
    source: 'git-commit',
  });
  payload.commitSha = (await gitStdout(cwd, ['rev-parse', '--verify', rev])).trim();
  payload.files = numstat.split('\n').flatMap((line) => {
    const parsed = parseGitNumstat(line);
    return parsed.paths.map((path) => ({ path, additions: parsed.additions, deletions: parsed.deletions }));
  });
  return payload;
}

/**
 * Numstat for working tree vs HEAD (tracked files).
 * @param {string} cwd
 */
export async function gitWorkingTreeNumstat(cwd) {
  const out = await gitStdout(cwd, ['diff', '--numstat', 'HEAD']);
  return parseGitNumstat(out);
}
