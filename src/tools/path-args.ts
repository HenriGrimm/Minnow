import { normalizePathForComparison } from './workspace-path-guard.ts';
import { parsePatch } from '../lib/apply-patch.mjs';

/** Argument keys that hold user-supplied paths per tool (aligned with server.js resolveSafePath usage). */
const TOOL_PATH_ARG_KEYS: Record<string, readonly string[]> = {
  list_directory: ['path'],
  read_file: ['path'],
  read_file_range: ['path'],
  read_document: ['path'],
  save_file: ['path'],
  create_pdf: ['path'],
  create_spreadsheet: ['path'],
  create_word_document: ['path'],
  append_file: ['path'],
  insert_at_line: ['path'],
  replace_text_in_file: ['path'],
  search_in_file: ['path'],
  grep: ['path'],
  make_directory: ['path'],
  move_file: ['source', 'destination'],
  copy_file: ['source', 'destination'],
  delete_path: ['path'],
  find_files: ['path'],
  get_file_metadata: ['path'],
  get_lsp_diagnostics: ['path'],
};

/**
 * Returns non-empty path strings referenced by the tool invocation (relative or absolute).
 */
export function extractPathLikeArgs(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (toolName === 'apply_patch') {
    try { return parsePatch(args.patch).flatMap(file => file.move ? [file.path, file.move] : [file.path]); }
    catch { return []; } // The executor rejects malformed patches without writing.
  }
  const keys = TOOL_PATH_ARG_KEYS[toolName];
  const out: string[] = [];
  if (keys) {
    for (const key of keys) {
      const v = args[key];
      if (typeof v === 'string' && v.trim()) {
        out.push(v.trim());
      }
    }
  }
  if (toolName === 'git_diff' && typeof args.path === 'string' && args.path.trim()) {
    out.push(args.path.trim());
  }
  if (toolName === 'git_add' && Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === 'string' && p.trim()) out.push(p.trim());
    }
  }
  return out;
}

/** Stable path string for cache keys and invalidation prefix matching. */
export function normalizePathArg(path: string): string {
  let p = path.trim().replace(/\\/g, '/');
  p = p.replace(/\/+/g, '/');
  if (p.startsWith('./')) {
    p = p.slice(2);
  }
  while (p.startsWith('./')) {
    p = p.slice(2);
  }
  return normalizePathForComparison(p);
}
