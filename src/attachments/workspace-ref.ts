/**
 * Workspace file references from the file tree into the composer.
 * Text paths resolve via read_file; PDF/Excel/Word via read_document; images
 * stay as attachment chips and resolve via the preview file API on send.
 */

import { executeTool } from '../tools/client';
import { estimateTextByteSize } from './file-card';
import { isImageFilePath } from './image-path';
import { isDocumentFilePath } from './document-extensions.mjs';
import {
  getPendingAttachments,
  pushAttachment,
  removeAttachment,
} from './store';
import type { Attachment } from './types';
import {
  readWorkspaceImage,
  type WorkspaceImagePayload,
} from './workspace-image-read';

/** Drag-and-drop MIME type for file-tree → composer transfers. */
export const WORKSPACE_FILE_MIME = 'application/x-minnow-workspace-file';

/**
 * Multi-select drag: every selected tree path, newline-separated. Set alongside
 * WORKSPACE_FILE_MIME (which stays the first path) so single-path readers — the
 * composer, terminal, Issues capture — keep working untouched.
 */
export const WORKSPACE_FILES_MIME = 'application/x-minnow-workspace-files';

/** Loads file text for a workspace path (overridable in tests). */
export type WorkspaceFileReader = (path: string) => Promise<string>;

/** Loads image bytes as a data URL (overridable in tests). */
export type WorkspaceImageReader = (path: string) => Promise<WorkspaceImagePayload>;

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

function newWorkspaceAttachmentId(): string {
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Inserts a project-relative path into a composer textarea (deduped; not an attachment). */
export function insertWorkspacePathInComposer(
  workspacePath: string,
  input: HTMLTextAreaElement | null | undefined,
): void {
  const normalized = workspacePath.trim().replace(/\\/g, '/');
  if (!normalized || !input) return;

  const value = input.value;
  if (value.includes(normalized)) {
    input.focus();
    return;
  }

  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? value.length;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const needsBreakBefore = before.length > 0 && !/\n\s*$/.test(before);
  const needsBreakAfter = after.length > 0 && !/^\s*\n/.test(after);
  const insert = `${needsBreakBefore ? '\n' : ''}${normalized}${needsBreakAfter ? '\n' : ''}`;
  input.value = before + insert + after;
  const caret = before.length + insert.length;
  input.selectionStart = caret;
  input.selectionEnd = caret;
  input.dispatchEvent(
    new (input.ownerDocument?.defaultView ?? globalThis).Event('input', {
      bubbles: true,
    }),
  );
  input.focus();
}

/** Queues a workspace image path chip in the composer (deduped by path). */
export function addWorkspaceReference(workspacePath: string): void {
  const path = workspacePath.trim();
  if (!path) return;

  const duplicate = getPendingAttachments().some(
    (item) => item.kind === 'workspace' && item.workspacePath === path,
  );
  if (duplicate) return;

  pushAttachment({
    id: newWorkspaceAttachmentId(),
    name: basename(path),
    kind: 'workspace',
    mimeType: WORKSPACE_FILE_MIME,
    size: 0,
    workspacePath: path,
  });
}

/** Queues a non-image workspace file as a preview card (deduped by path). */
export function addWorkspaceFileReference(workspacePath: string): void {
  addWorkspaceReference(workspacePath);
}

/** Removes a workspace reference chip by attachment id. */
export function removeWorkspaceReference(id: string): void {
  removeAttachment(id);
}

async function defaultWorkspaceFileReader(path: string): Promise<string> {
  const result = await executeTool('read_file', { path });
  return result.content ?? '';
}

async function defaultWorkspaceDocumentReader(path: string): Promise<string> {
  const result = await executeTool('read_document', { path });
  const content = result.content ?? '';
  if (content.startsWith('Error:')) {
    throw new Error(content.slice('Error:'.length).trim() || content);
  }
  return content;
}

async function defaultWorkspaceImageReader(path: string): Promise<WorkspaceImagePayload> {
  return readWorkspaceImage(path);
}

/**
 * Resolves workspace chips for {@link buildHistoryUserContent}.
 * Images use the preview file API; PDF/office use read_document; other files use read_file.
 */
export async function resolveWorkspaceReferences(
  attachments: Attachment[],
  readText: WorkspaceFileReader = defaultWorkspaceFileReader,
  readImage: WorkspaceImageReader = defaultWorkspaceImageReader,
  readDocument: WorkspaceFileReader = defaultWorkspaceDocumentReader,
): Promise<Attachment[]> {
  const resolved: Attachment[] = [];

  for (const attachment of attachments) {
    if (attachment.kind !== 'workspace' || !attachment.workspacePath) {
      resolved.push(attachment);
      continue;
    }

    const path = attachment.workspacePath;
    const name = basename(path);
    try {
      if (isImageFilePath(path)) {
        const { dataUrl, mimeType, size } = await readImage(path);
        resolved.push({
          ...attachment,
          kind: 'image',
          name,
          mimeType,
          size,
          dataUrl,
        });
        continue;
      }

      const text = isDocumentFilePath(path)
        ? await readDocument(path)
        : await readText(path);
      resolved.push({
        ...attachment,
        kind: 'text',
        name,
        mimeType: 'text/plain',
        text,
        size: estimateTextByteSize(text),
        largeTextWarning: text.length > 32 * 1024,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not read workspace file';
      resolved.push({
        ...attachment,
        kind: 'error',
        error: message,
      });
    }
  }

  return resolved;
}
