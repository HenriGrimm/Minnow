import { readWorkspaceTextFile } from '../../attachments/workspace-text-read';
import { parseListDirectoryResult } from '../../lib/list-directory-parse';
import { executeTool } from '../../tools/client';
import { resolveContextDocumentsBlock } from './resolve-block';
import type { ContextDocumentsConfig } from './config';

export interface RetrieveContextDocumentsBlockOptions {
  repoPath: string;
  documents: ContextDocumentsConfig;
  signal?: AbortSignal;
}

/** Build sections through the same pure resolver used by the server host. */
export async function retrieveContextDocumentsBlock(options: RetrieveContextDocumentsBlockOptions): Promise<string> {
  const workspaceRoot = options.repoPath.trim();
  if (!workspaceRoot) return '';
  return resolveContextDocumentsBlock(options.documents, {
    async readText(path) {
      options.signal?.throwIfAborted();
      try { return await readWorkspaceTextFile(path, workspaceRoot, undefined, options.signal); }
      catch { options.signal?.throwIfAborted(); return null; }
    },
    async listFiles(path) {
      options.signal?.throwIfAborted();
      const result = await executeTool('list_directory', { path }, { workspaceRoot, signal: options.signal });
      const parsed = parseListDirectoryResult(result.content ?? '');
      return 'error' in parsed ? [] : parsed.files;
    },
  });
}
