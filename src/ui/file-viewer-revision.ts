import { normalizeViewerDocText } from './file-viewer-tab-store';

/** Revision used by save_file's conditional write. EOL normalization matches CodeMirror. */
export async function viewerDocumentRevision(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeViewerDocText(content));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
