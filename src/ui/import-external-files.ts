import {
  emptyDirectoriesToCreate,
  entriesFromFileList,
  type DroppedTreeEntry,
} from '../attachments/directory-drop';
import { MAX_ATTACHMENT_BYTES } from '../attachments/reader';
import { getLocalServerAvailable } from '../tools/client';
import { joinTreePath, normalizeTreePath } from './file-tree-path';
import { parseToolResult } from './file-tree-parse-result';
import { refreshFileTreeViaBridge } from './file-tree-refresh-bridge';
import { setStatus } from './status';
import { showToast } from './toast';
import { beginFileTreeActivity } from './file-tree-activity';

/** Server tool name (UI-only; not exposed to the LLM tool list). */
const IMPORT_TOOL = 'import_workspace_file';

/** Workspace-relative destination for a dropped path under destDir. */
export function workspacePathForDroppedEntry(destDir: string, relativePath: string): string {
  return normalizeTreePath(joinTreePath(destDir, relativePath));
}

/** Read a browser File as a base64 string for POST /api/tools. */
async function readFileAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** POST import_workspace_file and parse the tool result string. */
async function postImportTool(
  args: Record<string, unknown>,
  label: string,
): Promise<{ ok: boolean; message: string }> {
  let response: Response;
  try {
    response = await fetch('/api/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: IMPORT_TOOL,
        args,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `${label}: ${message}` };
  }

  let payload: { result?: string; error?: string };
  try {
    payload = (await response.json()) as { result?: string; error?: string };
  } catch {
    return { ok: false, message: `${label}: invalid server response` };
  }

  if (!response.ok) {
    return { ok: false, message: payload.error ?? `${label}: HTTP ${response.status}` };
  }

  return parseToolResult(String(payload.result ?? ''));
}

/** POST one file to import_workspace_file (nested destPath is mkdir -p'd on the server). */
async function importOneFile(
  file: File,
  destPath: string,
): Promise<{ ok: boolean; message: string }> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      message: `${destPath}: exceeds ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB limit`,
    };
  }

  let content: string;
  try {
    content = await readFileAsBase64(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `${destPath}: ${message}` };
  }

  return postImportTool({ path: destPath, content }, destPath);
}

/** Create an empty directory through the same UI-only import tool. */
async function importOneDirectory(destPath: string): Promise<{ ok: boolean; message: string }> {
  return postImportTool({ path: destPath, kind: 'dir' }, destPath);
}

function destLabel(dir: string): string {
  return dir === '.' ? 'workspace root' : dir;
}

/** Copy a dropped file/folder tree into a workspace folder (relative path, e.g. `.` or `src/lib`). */
export async function importDroppedEntriesToWorkspace(
  entries: DroppedTreeEntry[],
  destDir: string,
): Promise<{ imported: number; directories: number; errors: string[] }> {
  if (!entries.length) {
    return { imported: 0, directories: 0, errors: [] };
  }

  if (!getLocalServerAvailable()) {
    setStatus('err', 'Open Minnow to import files into the workspace.');
    return { imported: 0, directories: 0, errors: ['Tool server unavailable'] };
  }

  const dir = normalizeTreePath(destDir === '' ? '.' : destDir);
  const files = entries.filter((entry) => entry.kind === 'file' && entry.file);
  const emptyDirs = emptyDirectoriesToCreate(entries);
  let imported = 0;
  let directories = 0;
  const errors: string[] = [];

  const spinCount = files.length || emptyDirs.length;
  const spinNoun = files.length ? 'file' : 'folder';
  const finishActivity = beginFileTreeActivity(
    `Importing ${spinCount} ${spinNoun}${spinCount === 1 ? '' : 's'}…`,
  );
  try {

    for (const relativePath of emptyDirs) {
      const destPath = workspacePathForDroppedEntry(dir, relativePath);
      const result = await importOneDirectory(destPath);
      if (result.ok) {
        directories += 1;
      } else {
        errors.push(result.message);
      }
    }

    for (const entry of files) {
      const file = entry.file;
      if (!file) continue;
      const destPath = workspacePathForDroppedEntry(dir, entry.relativePath);
      const result = await importOneFile(file, destPath);
      if (result.ok) {
        imported += 1;
      } else {
        errors.push(result.message);
      }
    }

    if (imported > 0 || directories > 0) {
      await refreshFileTreeViaBridge();
      if (imported > 0) {
        showToast(
          `Imported ${imported} file${imported === 1 ? '' : 's'} to ${destLabel(dir)}`,
        );
      } else {
        showToast(`Imported folder to ${destLabel(dir)}`);
      }
    } else if (errors.length) {
      setStatus('err', errors[0] ?? 'Import failed');
    } else {
      setStatus('err', 'No files imported');
    }
    if ((imported > 0 || directories > 0) && errors.length) {
      setStatus('err', `${errors.length} import(s) failed: ${errors[0]}`);
    }

    return { imported, directories, errors };
  } finally {
    finishActivity();
  }
}

/**
 * Copy dropped OS files into a workspace folder (flat File list, or webkitRelativePath trees).
 */
export async function importExternalFilesToWorkspace(
  files: File[],
  destDir: string,
): Promise<{ imported: number; errors: string[] }> {
  const { entries, error } = entriesFromFileList(files);
  if (!entries.length) {
    if (error) setStatus('err', error);
    return { imported: 0, errors: error ? [error] : [] };
  }
  const result = await importDroppedEntriesToWorkspace(entries, destDir);
  return { imported: result.imported, errors: result.errors };
}
