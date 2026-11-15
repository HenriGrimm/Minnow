/**
 * Workspace change detection for execute_command via isolated Git tree snapshots
 * and best-effort single-file heuristics (sed, redirects, patch).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../process-runner.js';
import {
  buildCodeChangePayload,
  codeChangeFromDiff,
  countLineChangeStats,
  MAX_CODE_CHANGE_DIFF_LINES,
} from './line-diff-stats.js';
import { parseGitNumstat } from './git-change-stats.js';

/**
 * @typedef {{ treeSha: string }} WorkspaceSnapshot
 */

/**
 * Capture actual content, including untracked files, without touching the user's
 * index. The caller holds the checkout mutation boundary across pre/tool/post;
 * a turn-wide baseline would also include other chats' intervening edits.
 * @param {string} cwd
 * @returns {Promise<WorkspaceSnapshot | null>}
 */
export async function captureWorkspaceSnapshot(cwd) {
  let temp;
  try {
    const index = await runProcess('git', ['rev-parse', '--git-path', 'index'], { cwd });
    if (index.code !== 0) return null;
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-command-diff-'));
    const env = { GIT_INDEX_FILE: path.join(temp, 'index') };
    try { await fs.copyFile(path.resolve(cwd, index.stdout.trim()), env.GIT_INDEX_FILE); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const empty = await runProcess('git', ['read-tree', '--empty'], { cwd, env });
      if (empty.code !== 0) return null;
    }
    const add = await runProcess('git', ['add', '-A'], { cwd, env });
    if (add.code !== 0) return null;
    const tree = await runProcess('git', ['write-tree'], { cwd, env });
    const treeSha = tree.stdout.trim();
    return tree.code === 0 && /^[a-f0-9]{40,64}$/i.test(treeSha) ? { treeSha } : null;
  } catch {
    return null;
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * After command: diff immutable content, not totals relative to HEAD. Equal-size
 * replacements, reverts and commits cannot be detected by subtracting numstats.
 * @param {string} cwd
 * @param {WorkspaceSnapshot | null} before
 */
export async function codeChangeFromCommandSnapshot(cwd, before) {
  if (!before?.treeSha) return undefined;
  const after = await captureWorkspaceSnapshot(cwd);
  if (!after || before.treeSha === after.treeSha) return undefined;
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative', before.treeSha, after.treeSha];
  const result = await runProcess('git', [...args, '--numstat', '-z', '--', '.'], { cwd });
  if (result.code !== 0 || result.accumulationTruncated) return undefined;
  const files = result.stdout.split('\0').flatMap(row => {
    const [add, del, ...name] = row.split('\t');
    const file = name.join('\t');
    if (!file || !/^\d+$/.test(add) || !/^\d+$/.test(del)) return [];
    return [{ path: file, additions: Number(add), deletions: Number(del) }];
  });
  const payload = buildCodeChangePayload({
    additions: files.reduce((n, file) => n + file.additions, 0),
    deletions: files.reduce((n, file) => n + file.deletions, 0),
    paths: files.map(file => file.path),
    source: 'command-snapshot',
  });
  if (!payload) return undefined;
  let budget = MAX_CODE_CHANGE_DIFF_LINES;
  for (const file of files) {
    file.diffTruncated = true;
    if (!budget) continue;
    const patch = await runProcess('git', ['--literal-pathspecs', ...args, '--unified=3', '--', file.path], { cwd });
    if (patch.code !== 0) continue;
    let inHunk = false;
    const lines = [];
    for (const line of patch.stdout.split('\n')) {
      if (line.startsWith('@@ ')) { inHunk = true; continue; }
      if (!inHunk || !/^[ +\-]/.test(line)) continue;
      lines.push({ type: line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'unchanged', text: line.slice(1) });
    }
    file.diffLines = lines.slice(0, budget);
    file.diffTruncated = Boolean(patch.accumulationTruncated) || lines.length > budget;
    budget -= file.diffLines.length;
  }
  return { ...payload, files };
}

/** Resolve a single relative path from command string heuristics. */
function extractHeuristicTargetPath(command) {
  const cmd = String(command ?? '');
  const patterns = [
    /\bsed\s+(?:-[^\s]+\s+)*['"]?([^'"\s|>]+)['"]?/i,
    /\bpatch\s+(?:-[^\s]+\s+)*['"]?([^'"\s]+)['"]?/i,
    /\bgit\s+apply\s+['"]?([^'"\s]+)['"]?/i,
    /(?:^|[\s|])(?:>>?)\s*['"]?([^\s'"]+)['"]?/,
    /\bOut-File\s+(?:-[^\s]+\s+)*['"]?([^'"\s]+)['"]?/i,
    /\bSet-Content\s+(?:-[^\s]+\s+)*['"]?([^'"\s]+)['"]?/i,
  ];
  for (const re of patterns) {
    const m = cmd.match(re);
    if (m?.[1] && !m[1].startsWith('/dev/')) return m[1];
  }
  return null;
}

/**
 * Best-effort before/after diff for a single file touched by shell one-liners.
 * @param {string} cwd
 * @param {string} command
 * @param {Map<string, string>} beforeContents path → utf8 snapshot
 */
export async function codeChangeFromCommandHeuristic(cwd, command, beforeContents) {
  const rel = extractHeuristicTargetPath(command);
  if (!rel) return undefined;

  const abs = path.resolve(cwd, rel);
  const before = beforeContents.get(rel) ?? '';
  let after = '';
  try {
    after = await fs.readFile(abs, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code !== 'ENOENT') return undefined;
    after = '';
  }

  const change = codeChangeFromDiff(before, after, rel.replace(/\\/g, '/'), {
    source: 'command-heuristic',
  });
  if (!change) return undefined;
  change.source = 'command-heuristic';
  return change;
}

/**
 * Read file contents for heuristic snapshot (ignore errors).
 * @param {string} cwd
 * @param {string} relPath
 */
export async function readHeuristicFileSnapshot(cwd, relPath) {
  try {
    const abs = path.resolve(cwd, relPath);
    return await fs.readFile(abs, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Combine git snapshot delta with optional heuristic when git unavailable.
 * @param {object} params
 * @param {string} params.cwd
 * @param {string} params.command
 * @param {WorkspaceSnapshot | null} params.beforeSnapshot
 * @param {Map<string, string>} [params.beforeFileContents]
 */
export async function resolveExecuteCommandCodeChange({
  cwd,
  command,
  beforeSnapshot,
  beforeFileContents,
}) {
  const fromGit = await codeChangeFromCommandSnapshot(cwd, beforeSnapshot);
  if (fromGit) return fromGit;

  const rel = extractHeuristicTargetPath(command);
  if (!rel || !beforeFileContents?.has(rel)) return undefined;
  return codeChangeFromCommandHeuristic(cwd, command, beforeFileContents);
}

/** Export for tests: line stats without full payload. */
export { countLineChangeStats, parseGitNumstat };
