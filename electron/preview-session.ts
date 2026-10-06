import type { Session } from 'electron';

export const PREVIEW_SESSION_PARTITION = 'persist:minnow-preview';

/** Preview guests are top-level WebContentsViews, so site headers remain intact. */
export function configurePreviewSession(_ses: Session): void {
  // No response-header rewrite hook. CSP, frame, and cross-origin isolation
  // headers belong to the destination and must reach Chromium, including
  // workspace previews served from the isolated capability origin.
}
