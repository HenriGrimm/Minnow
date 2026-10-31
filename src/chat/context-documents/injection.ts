import { readWorkspaceTextFile } from '../../attachments/workspace-text-read';
import { parseListDirectoryResult } from '../../lib/list-directory-parse';
import { executeTool } from '../../tools/client';
import { resolveContextDocumentsBlock } from './resolve-block';
import type { ContextDocumentsConfig } from './config';

export interface RetrieveContextDocumentsBlockOptions {
  repoPath: string;
  documents: ContextDocumentsConfig;
}

/** Build sections through the same pure resolver used by the server host. */
export async function retrieveContextDocumentsBlock(options: RetrieveContextDocumentsBlockOptions): Promise<string> {
  const workspaceRoot = options.repoPath.trim();
  if (!workspaceRoot) return '';
  return resolveContextDocumentsBlock(options.documents, {
    async readText(path) {
      try { return await readWorkspaceTextFile(path, workspaceRoot); }
      catch { return null; }
    },
    async listFiles(path) {
      const result = await executeTool('list_directory', { path }, { workspaceRoot });
      const parsed = parseListDirectoryResult(result.content ?? '');
      return 'error' in parsed ? [] : parsed.files;
    },
  });
}
