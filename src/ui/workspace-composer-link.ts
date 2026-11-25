import { isImageFilePath } from '../attachments/image-path';
import {
  addWorkspaceFileReference,
  addWorkspaceReference,
} from '../attachments/workspace-ref';

/** Drop / Add to chat entry point. */
export function attachWorkspacePathToComposer(
  workspacePath: string,
  _inputOverride?: HTMLTextAreaElement | null,
): void {
  const path = workspacePath.trim();
  if (!path) return;
  if (isImageFilePath(path)) {
    addWorkspaceReference(path);
    return;
  }
  addWorkspaceFileReference(path);
}
