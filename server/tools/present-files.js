import fs from 'node:fs/promises';
import path from 'node:path';
import { getEffectiveWorkspaceRoot, resolveSafePath } from '../runtime/path-access.js';

/** File references travel in the durable tool result, without copying file bytes. */
export async function toolPresentFiles(args) {
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 20) {
    throw new Error('files must contain between 1 and 20 saved files');
  }
  const workspaceRoot = getEffectiveWorkspaceRoot();
  const files = [];
  const seen = new Set();
  for (const entry of args.files) {
    if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) {
      throw new Error('Each file requires a path');
    }
    if (entry.title != null && (typeof entry.title !== 'string' || entry.title.length > 160)) {
      throw new Error('File titles must be strings of at most 160 characters');
    }
    const absolutePath = resolveSafePath(entry.path.trim());
    const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
    if (seen.has(key)) continue;
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) throw new Error(`Not a file: ${entry.path}`);
    seen.add(key);
    const relative = path.relative(workspaceRoot, absolutePath);
    const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    files.push({
      path: (outside ? absolutePath : relative).replace(/\\/g, '/'),
      name: path.basename(absolutePath),
      title: entry.title?.trim() || path.basename(absolutePath),
      bytes: stat.size,
    });
  }
  return JSON.stringify({ kind: 'presented-files', version: 1, workspaceRoot, files });
}
