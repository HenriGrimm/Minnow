import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRequestWorkspaceRoot, resolveSafePath, runWithToolContext } from '../runtime/path-access.js';
import { isRegisteredGitWorktreePath } from '../worktree/allowlist.js';
import { buildRevealCommand } from './reveal-in-explorer.js';
import { isResolvedPathUnderRoot } from './safe-path.js';

const run = promisify(execFile);
const EDITORS = new Map([
  ['cursor', { mac: 'Cursor', bin: 'cursor', win: ['Cursor', 'Cursor.exe'] }],
  ['vscode', { mac: 'Visual Studio Code', bin: 'code', win: ['Microsoft VS Code', 'Code.exe'] }],
]);

export function isWorkspaceApp(app) {
  return app === 'finder' || EDITORS.has(app);
}

/** Resolve inside the requesting workspace or a worktree belonging to it. */
export async function resolveWorkspaceAppPath(userPath, checkout, workspace = getRequestWorkspaceRoot()) {
  const base = await fs.realpath(workspace);
  const root = checkout ? await fs.realpath(checkout) : base;
  if (!isResolvedPathUnderRoot(root, base) &&
      !(await runWithToolContext(() => isRegisteredGitWorktreePath(root), { workspaceRoot: base }))) {
    throw new Error('The checkout does not belong to this workspace.');
  }
  const resolved = await runWithToolContext(() => resolveSafePath(userPath), {
    workspaceRoot: root, enforceWorkspace: true,
  });
  return fs.realpath(resolved);
}

async function windowsEditor(editor) {
  const [folder, exe] = editor.win;
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', folder, exe),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, folder, exe),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], folder, exe),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue with the next installation location.
    }
  }
  return exe;
}

function launch(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Start a fixed local app with one already-validated path argument. */
export async function openWorkspaceApp(app, target) {
  if (!isWorkspaceApp(app)) throw new Error('Unsupported application.');
  const platform = process.platform;
  try {
    if (app === 'finder') {
      const info = await fs.stat(target);
      const { command, args, windowsVerbatimArguments } = buildRevealCommand(platform, target, info.isDirectory());
      if (platform === 'darwin') {
        await run(command, args, { timeout: 10_000 });
      } else {
        const launchArgs = platform === 'win32' && info.isDirectory() ? [`"${args[0]}"`] : args;
        await launch(command, launchArgs, { windowsVerbatimArguments });
      }
    } else {
      const editor = EDITORS.get(app);
      if (platform === 'darwin') {
        try {
          await run('/usr/bin/open', ['-Ra', editor.mac], { timeout: 5_000 });
        } catch {
          return { ok: false, reason: 'not-installed' };
        }
        await run('/usr/bin/open', ['-a', editor.mac, target], { timeout: 10_000 });
      } else {
        await launch(platform === 'win32' ? await windowsEditor(editor) : editor.bin, [target]);
      }
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'not-installed' };
    throw error;
  }
  return { ok: true };
}
