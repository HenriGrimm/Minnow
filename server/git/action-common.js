import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gh, requireForge, processError } from './forge-ops.js';
import { runProcess } from '../process-runner.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';

export async function actionRoot(cwd) {
  const root = await fs.realpath(cwd || getEffectiveWorkspaceRoot());
  await validateAllowedWorkspaceRoot(root);
  const result = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  if (result.code !== 0) throw new Error('Not a Git worktree');
  return fs.realpath(result.stdout.trim());
}

export async function inside(root, relative, mustExist = true) {
  if (typeof relative !== 'string' || path.isAbsolute(relative))
    throw new Error('Expected a workspace-relative path');
  const target = path.resolve(root, relative);
  const contained = (value) => {
    const rel = path.relative(root, value);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (!contained(target)) throw new Error('Path is outside the worktree');
  let probe = target;
  while (true) {
    try {
      if (!contained(await fs.realpath(probe)))
        throw new Error('Symlink points outside the worktree');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || mustExist) throw error;
      probe = path.dirname(probe);
    }
  }
  return target;
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function remoteContext(cwd) {
  const root = await actionRoot(cwd);
  const gate = await requireForge(root);
  if (!gate.ok) throw new Error(gate.error);
  return { cwd: root, repo: gate.status.repo, hostname: gate.status.hostname };
}

export async function github(context, endpoint, method = 'GET', body) {
  const args = [
    'api',
    '--hostname',
    context.hostname,
    '--method',
    method,
    `repos/${context.repo}/${endpoint}`,
  ];
  // gh reads structured bodies from a temporary file; values never become shell code.
  let file;
  try {
    if (body !== undefined) {
      const os = await import('node:os');
      file = path.join(os.tmpdir(), `minnow-gh-${randomUUID()}.json`);
      await fs.writeFile(file, JSON.stringify(body), { mode: 0o600 });
      args.push('--input', file);
    }
    const result = await gh(args, context.cwd);
    if (result.code !== 0) throw new Error(processError(result, 'GitHub request failed'));
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } finally {
    if (file) await fs.rm(file, { force: true });
  }
}

export const segment = (value) => encodeURIComponent(String(value));
export const pageNumber = (value) => Math.max(1, Math.min(10000, Math.floor(Number(value) || 1)));
export function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A positive numeric ID is required');
  return id;
}
