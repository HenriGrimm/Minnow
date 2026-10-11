import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseRemoteRepository, validateRemoteFolderName } from '../../src/lib/remote-repository.mjs';
import { createWorkspaceSubfolder } from './browse.js';

const execFileAsync = promisify(execFile);

/** Clone into a newly reserved folder; activation remains the normal workspace switch. */
export async function cloneWorkspaceRepository(parentPath, folderName, remoteUrl) {
  const { remote, name: suggestedName } = parseRemoteRepository(remoteUrl);
  const name = folderName == null ? suggestedName : folderName;
  const error = validateRemoteFolderName(name);
  if (error) throw new Error(error);
  if (typeof parentPath !== 'string' || !path.isAbsolute(parentPath.trim())) {
    throw new Error('Choose an absolute parent folder path');
  }
  const parent = await fs.realpath(parentPath.trim());
  const created = await createWorkspaceSubfolder(parent, name.trim());
  try {
    await execFileAsync('git', ['clone', '--', remote, created.path], {
      cwd: parent,
      windowsHide: true,
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      },
    });
    return created;
  } catch (err) {
    // Only remove the single folder this operation created, within the resolved parent.
    if (path.dirname(created.path) === parent) {
      await fs.rm(created.path, { recursive: true, force: true }).catch(() => {});
    }
    if (err.code === 'ENOENT') throw new Error('Git is not installed or is unavailable. Install Git and try again.');
    if (err.killed) throw new Error('Cloning timed out. Check the connection and try again.');
    const detail = String(err.stderr || '').trim().slice(-2000);
    throw new Error(detail || 'Could not clone the repository. Check the link and Git access on this device.');
  }
}
