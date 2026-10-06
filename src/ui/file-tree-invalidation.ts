import { getFilePanelState, patchFilePanelState } from '../state/file-panel';
import { extractPathLikeArgs } from '../tools/path-args';
import {
  dirname,
  normalizeTreePath,
  pruneExpandedDirs,
  remapExpandedDirs,
} from './file-tree-path';

/** Read a string path argument from a tool call payload. */
function pathArgFromTool(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return normalizeTreePath(value.trim());
}

/** Map a mutating filesystem tool to the parent directory listing(s) that need refresh. */
export function affectedDirsFromTool(
  toolName: string,
  args: Record<string, unknown>,
): string[] | null {
  switch (toolName) {
    case 'apply_patch':
      return [...new Set(extractPathLikeArgs(toolName, args).map(p => dirname(normalizeTreePath(p))))];
    case 'save_file':
    case 'append_file':
    case 'insert_at_line':
    case 'replace_text_in_file':
    case 'create_pdf':
    case 'create_spreadsheet':
    case 'create_word_document': {
      const path = pathArgFromTool(args, 'path');
      return path ? [dirname(path)] : null;
    }
    case 'make_directory': {
      const path = pathArgFromTool(args, 'path');
      return path ? [dirname(path)] : null;
    }
    case 'move_file': {
      const source = pathArgFromTool(args, 'source');
      const destination = pathArgFromTool(args, 'destination');
      if (source && destination) {
        const state = getFilePanelState();
        const remapped = remapExpandedDirs(state.expandedDirs, source, destination);
        if (
          remapped.length !== state.expandedDirs.length ||
          remapped.some((p, i) => p !== state.expandedDirs[i])
        ) {
          patchFilePanelState({ expandedDirs: remapped });
        }
      }
      const dirs: string[] = [];
      if (source) dirs.push(dirname(source));
      if (destination) dirs.push(dirname(destination));
      return dirs.length > 0 ? dirs : null;
    }
    case 'copy_file': {
      const source = pathArgFromTool(args, 'source');
      const destination = pathArgFromTool(args, 'destination');
      const dirs: string[] = [];
      if (source) dirs.push(dirname(source));
      if (destination) dirs.push(dirname(destination));
      return dirs.length > 0 ? dirs : null;
    }
    case 'delete_path': {
      const path = pathArgFromTool(args, 'path');
      if (!path) return null;
      const state = getFilePanelState();
      const pruned = pruneExpandedDirs(state.expandedDirs, path);
      if (pruned.length !== state.expandedDirs.length) {
        patchFilePanelState({ expandedDirs: pruned });
      }
      return [dirname(path)];
    }
    default:
      return null;
  }
}
