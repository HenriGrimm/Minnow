/**
 * Attachment shapes for the composer preview and API payload builders (SA-13).
 */

import type { DesignShape } from '../design/shape-model';
import type { SourceMapping } from '../design/source-map';

/** How an attachment is represented after `processFile` or workspace drag-drop. */
export type AttachmentKind =
  | 'image'
  | 'text'
  | 'pdf'
  | 'error'
  | 'workspace'
  | 'codeRef'
  | 'elementRef'
  | 'designRef';

/** One pending file in the composer strip before send. */
export interface Attachment {
  /** Stable id for remove buttons and deduplication. */
  id: string;
  /** Original file name from the picker. */
  name: string;
  kind: AttachmentKind;
  /** Browser-reported MIME type (may be empty for some extensions). */
  mimeType: string;
  /** Raw file size in bytes. */
  size: number;
  /** Data URL for vision models (`image/*` only). */
  dataUrl?: string;
  /** Plain text for code/text files or extracted PDF text. */
  text?: string;
  /** User-visible error when kind is `error`. */
  error?: string;
  /** A removable reservation while the selected file is being read. */
  pendingRead?: boolean;
  /** True when text content exceeds the soft 32KB warning threshold. */
  largeTextWarning?: boolean;
  /** Project-relative path for workspace reference chips (loaded on send). */
  workspacePath?: string;
  /** 1-based start line for `codeRef` selections. */
  lineStart?: number;
  /** 1-based end line for `codeRef` selections (inclusive). */
  lineEnd?: number;
  /** CSS selector for a Design Mode element pick (`elementRef`). */
  selector?: string;
  /** `data-mn-uid` stamped on the picked element (`elementRef`). */
  uid?: number;
  /** Page the element was picked from: workspace path or preview URL (`elementRef`). */
  pageUrl?: string;
  /** Lowercase tag name of the picked element (`elementRef`). */
  tagName?: string;
  /** Class list of the picked element (`elementRef`). */
  classList?: string[];
  /** Capped outerHTML preview of the picked element (`elementRef`). */
  outerHtmlPreview?: string;
  /** Bounding rect (CSS px, guest coordinates) of the picked element at capture time (`elementRef`). */
  rect?: { x: number; y: number; width: number; height: number };
  /** Condensed computed-styles digest: typography/color/spacing/layout mode (`elementRef`). */
  stylesDigest?: string;
  /** DPR-correct cropped screenshot data URL of the picked element (`elementRef`). */
  croppedDataUrl?: string;
  /** Resolved file:line (or best-effort guess) the picked element came from (`elementRef`, MIN-369). Set async after the chip is pushed. */
  sourceMapping?: SourceMapping;
  /** A11y quick-pass (MIN-370): aria-label || alt || trimmed text content (`elementRef`). */
  accessibleName?: string;
  /** A11y quick-pass (MIN-370): WCAG contrast ratio of color vs background, or null when it can't be computed (`elementRef`). */
  contrastRatio?: number | null;
  /** Readable ancestor chain of the picked element, e.g. `div#root > main.page > button.cta` (`elementRef`). */
  domPath?: string;
  /** Every attribute on the picked element (name → value) (`elementRef`). */
  attributes?: Record<string, string>;
  /** Curated computed styles (camelCase key → value) of the picked element (`elementRef`). */
  computedStyles?: Record<string, string>;
  /** The drawn shape (pen/rect/arrow/label) captured into this attachment (`designRef`). */
  shape?: DesignShape;
  /** Composited crop (screenshot region + rasterized overlay shapes) data URL (`designRef`). */
  compositedDataUrl?: string;
  /** Structured intent line: move/motion, region-of-interest, or instruction text (`designRef`). */
  intentText?: string;
}
