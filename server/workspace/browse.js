/**
 * Directory listing for the in-app workspace folder picker (no native dialog).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfigJson, updateConfigJson } from '../config/store.js';
import { mergeConfigMeta } from '../config/validators.js';

/**
 * Parent path for "Up", or null at a filesystem root.
 * @param {string} resolved
 * @returns {string | null}
 */
function parentDirectory(resolved) {
  const parent = path.dirname(resolved);
  if (parent === resolved) {
    return null;
  }
  return parent;
}

/**
 * Quick existence check for Windows drive letters (A:\ … Z:\).
 * @returns {Array<{ name: string, path: string }>}
 */
async function listWindowsDriveRoots() {
  if (process.platform !== 'win32') {
    return [];
  }
  const entries = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const driveRoot = `${letter}:\\`;
    try {
      await fs.access(driveRoot);
      entries.push({ name: `${letter}:`, path: driveRoot });
    } catch {
      /* drive not present */
    }
  }
  return entries;
}

/**
 * Default parent for "Create new project" on the welcome screen (~/Projects).
 * @returns {string}
 */
export function getDefaultNewProjectParentPath() {
  return path.join(os.homedir(), 'Projects');
}

/**
 * Return the configured project location; create ~/Projects only for the default.
 * @returns {Promise<string>} absolute path to the parent directory
 */
export async function ensureDefaultProjectsParent() {
  const config = await readConfigJson('config.json');
  const saved = config?.workspace?.newProjectParent;
  if (typeof saved === 'string' && path.isAbsolute(saved)) return saved;
  return ensureFallbackProjectsParent();
}

/** Save a device-wide location without switching workspaces. Empty resets it. */
export async function saveDefaultProjectsParent(value) {
  if (typeof value !== 'string') throw new Error('Project location must be a path');
  const trimmed = value.trim();
  if (trimmed && !path.isAbsolute(trimmed)) throw new Error('Choose an absolute folder path');
  const resolved = trimmed ? path.resolve(trimmed) : await ensureFallbackProjectsParent();
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Project location must be a directory');
  await updateConfigJson('config.json', (config) =>
    mergeConfigMeta(config, { workspace: { newProjectParent: trimmed ? resolved : '' } }));
  return resolved;
}

async function ensureFallbackProjectsParent() {
  const parent = getDefaultNewProjectParentPath();
  await fs.mkdir(parent, { recursive: true });
  return parent;
}

/**
 * Top-level locations when no path is provided (home + OS roots).
 * @returns {Promise<Array<{ name: string, path: string }>>}
 */
async function listBrowseRoots() {
  const home = os.homedir();
  const entries = [{ name: 'Home', path: home }];
  if (process.platform === 'win32') {
    const drives = await listWindowsDriveRoots();
    entries.push(...drives);
  } else {
    entries.push({ name: 'Root', path: '/' });
  }
  return entries;
}

/**
 * List child directories of a resolved path (names only, sorted).
 * @param {string} resolved
 * @returns {Promise<Array<{ name: string, path: string }>>}
 */
async function listChildDirectories(resolved) {
  const dirents = await fs.readdir(resolved, { withFileTypes: true });
  const dirs = [];
  for (const ent of dirents) {
    if (!ent.isDirectory()) {
      continue;
    }
    if (ent.name === '.' || ent.name === '..') {
      continue;
    }
    dirs.push({
      name: ent.name,
      path: path.join(resolved, ent.name),
    });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return dirs;
}

/**
 * @param {string | null | undefined} userPath Empty or omitted → roots; otherwise list that folder.
 * @returns {Promise<{ path: string, parent: string | null, entries: Array<{ name: string, path: string }> }>}
 */
export async function browseWorkspaceFolders(userPath) {
  const trimmed = typeof userPath === 'string' ? userPath.trim() : '';
  if (!trimmed) {
    return {
      path: '',
      parent: null,
      entries: await listBrowseRoots(),
    };
  }

  const resolved = path.resolve(trimmed);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`Folder does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error('Path must be a directory');
  }

  return {
    path: resolved,
    parent: parentDirectory(resolved),
    entries: await listChildDirectories(resolved),
  };
}

/**
 * Characters illegal in folder names on common desktop OSes.
 * @param {string} name
 */
function assertValidFolderName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new Error('Folder name is required');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid folder name');
  }
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    throw new Error('Folder name contains invalid characters');
  }
  if (process.platform === 'win32' && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(trimmed)) {
    throw new Error('Invalid folder name');
  }
  return trimmed;
}

/**
 * Create a subfolder under an existing directory (workspace picker "New folder").
 * @param {string} parentPath Absolute path of the parent directory.
 * @param {string} folderName Single segment name (no slashes).
 * @returns {Promise<{ path: string, name: string }>}
 */
export async function createWorkspaceSubfolder(parentPath, folderName) {
  const trimmedParent = typeof parentPath === 'string' ? parentPath.trim() : '';
  if (!trimmedParent) {
    throw new Error('Open a folder before creating a subfolder');
  }

  const name = assertValidFolderName(folderName);
  const resolvedParent = path.resolve(trimmedParent);
  let stat;
  try {
    stat = await fs.stat(resolvedParent);
  } catch {
    throw new Error(`Folder does not exist: ${resolvedParent}`);
  }
  if (!stat.isDirectory()) {
    throw new Error('Parent path must be a directory');
  }

  const newPath = path.join(resolvedParent, name);
  try {
    await fs.mkdir(newPath);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
    if (code === 'EEXIST') {
      throw new Error(`A folder named "${name}" already exists`);
    }
    throw err;
  }

  return { path: newPath, name };
}
