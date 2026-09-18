import fs from 'node:fs';
import path from 'node:path';

/** Upper bound on one drag — a runaway selection should not stat thousands of paths. */
export const MAX_FILE_DRAG_PATHS = 256;

/**
 * Resolve a renderer drag request to absolute paths that exist on this machine.
 *
 * `root` is the folder the file tree lists; `paths` are tree paths relative to it
 * (absolute paths pass through). Returns null when nothing usable is left, so the
 * renderer can fall back to its in-app HTML5 drag instead of a dead native one.
 */
export function resolveFileDragPaths(
  root: unknown,
  paths: unknown,
  exists: (absolutePath: string) => boolean = pathExists,
): string[] | null {
  if (typeof root !== 'string' || !root.trim()) return null;
  const base = root.trim();
  if (!path.isAbsolute(base)) return null;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILE_DRAG_PATHS) {
    return null;
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) return null;
    const absolute = path.resolve(base, raw.trim());
    if (seen.has(absolute)) continue;
    if (!exists(absolute)) return null;
    seen.add(absolute);
    out.push(absolute);
  }
  return out.length > 0 ? out : null;
}

function pathExists(absolutePath: string): boolean {
  try {
    fs.statSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}
