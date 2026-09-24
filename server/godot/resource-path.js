/** Resolve Godot's project-root resource paths without escaping the workspace. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';

/** @param {string} projectRoot @param {string} uri */
export async function resolveGodotResourcePath(projectRoot, uri) {
  if (typeof uri !== 'string' || !uri.startsWith('res://')) {
    throw Object.assign(new Error('Expected a res:// resource path'), { statusCode: 400 });
  }
  const relative = uri.slice('res://'.length).replace(/\\/g, '/');
  if (!relative || relative.includes('\0') || relative.startsWith('/') ||
      relative.split('/').some((part) => !part || part === '.' || part === '..') ||
      /^[a-zA-Z]:/.test(relative)) {
    throw Object.assign(new Error('Invalid res:// resource path'), { statusCode: 400 });
  }
  const absolute = path.resolve(projectRoot, relative);
  if (!isResolvedPathUnderRoot(absolute, projectRoot)) {
    throw Object.assign(new Error('Resource path is outside the Godot project'), { statusCode: 400 });
  }
  let kind = 'missing';
  try {
    const stat = await fs.stat(absolute);
    kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return { uri, relativePath: relative, kind };
}
