/** Discover Godot projects without traversing generated caches or symlinks. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';

const SKIP_DIRS = new Set([
  '.git',
  '.godot',
  '.minnow',
  '.worktrees',
  'node_modules',
  'dist',
  'build',
]);

/**
 * A bounded walk is important for monorepos and folders containing imported assets.
 * The caller can select any project found here by its workspace-relative path.
 * @param {string} workspaceRoot
 * @param {{ maxDepth?: number, maxDirectories?: number }} [options]
 */
export async function listGodotProjects(workspaceRoot, options = {}) {
  const root = path.resolve(workspaceRoot);
  const maxDepth = options.maxDepth ?? 3;
  const maxDirectories = options.maxDirectories ?? 400;
  const queue = [{ abs: root, relative: '.', depth: 0 }];
  const projects = [];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (visited >= maxDirectories) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    visited += 1;
    let entries;
    try {
      entries = await fs.readdir(current.abs, { withFileTypes: true });
    } catch (err) {
      // The selected root itself must be valid; inaccessible descendants are skipped.
      if (current.depth === 0) throw err;
      continue;
    }

    if (entries.some((entry) => entry.name === 'project.godot' && entry.isFile())) {
      projects.push({ relativeRoot: current.relative, root: current.abs });
      // Nested fixtures/addons inside a project are not separate workspace projects.
      continue;
    }
    if (current.depth >= maxDepth) continue;

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(current.abs, entry.name);
      if (!isResolvedPathUnderRoot(abs, root)) continue;
      queue.push({
        abs,
        relative: current.relative === '.' ? entry.name : `${current.relative}/${entry.name}`,
        depth: current.depth + 1,
      });
    }
  }

  projects.sort((a, b) => a.relativeRoot.localeCompare(b.relativeRoot));
  return { projects, truncated };
}

/**
 * @param {string} workspaceRoot
 * @param {string | undefined} requestedRelativeRoot
 * @param {{ maxDepth?: number, maxDirectories?: number }} [options]
 */
export async function resolveGodotProject(workspaceRoot, requestedRelativeRoot, options) {
  const discovered = await listGodotProjects(workspaceRoot, options);
  const { projects } = discovered;
  if (requestedRelativeRoot != null) {
    const requested = String(requestedRelativeRoot).replace(/\\/g, '/').replace(/\/$/, '') || '.';
    const parts = requested.split('/');
    if (path.isAbsolute(requested) || parts.includes('..') || parts.includes('') ||
        (parts.includes('.') && requested !== '.')) {
      return { status: 'invalid-selection', ...discovered, project: null };
    }
    const root = path.resolve(workspaceRoot);
    const selectedRoot = path.resolve(root, requested);
    if (!isResolvedPathUnderRoot(selectedRoot, root)) {
      return { status: 'invalid-selection', ...discovered, project: null };
    }
    try {
      const configPath = path.join(selectedRoot, 'project.godot');
      if (!isResolvedPathUnderRoot(configPath, selectedRoot) || !(await fs.stat(configPath)).isFile()) {
        return { status: 'invalid-selection', ...discovered, project: null };
      }
    } catch {
      return { status: 'invalid-selection', ...discovered, project: null };
    }
    return {
      status: 'selected',
      ...discovered,
      project: { relativeRoot: requested, root: selectedRoot },
    };
  }
  if (discovered.truncated) return { status: 'scan-incomplete', ...discovered, project: null };
  if (projects.length === 0) return { status: 'not-project', ...discovered, project: null };
  if (projects.length > 1) return { status: 'select-project', ...discovered, project: null };
  return { status: 'selected', ...discovered, project: projects[0] };
}

/** Read only the small set of project settings needed by Minnow's status/run controls. */
export async function readGodotProjectInfo(projectRoot) {
  const configPath = path.join(projectRoot, 'project.godot');
  if (!isResolvedPathUnderRoot(configPath, projectRoot)) {
    throw new Error('project.godot is outside the selected project');
  }
  const stat = await fs.stat(configPath);
  if (stat.size > 256 * 1024) {
    throw new Error('project.godot is too large to inspect');
  }
  const raw = await fs.readFile(configPath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) {
    throw new Error('project.godot is too large to inspect');
  }
  let section = '';
  const values = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1];
      continue;
    }
    const assignment = /^([^=]+)=(.*)$/.exec(trimmed);
    if (!assignment) continue;
    values.set(`${section}/${assignment[1].trim()}`, assignment[2].trim());
  }
  const decode = (key) => {
    const value = values.get(key);
    if (!value) return null;
    if (!value.startsWith('"')) return value;
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  };
  return {
    name: decode('application/config/name'),
    mainScene: decode('application/run/main_scene'),
    configVersion: Number(values.get('/config_version')) || null,
  };
}
