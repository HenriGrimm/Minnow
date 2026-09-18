import { apiMessageContentToText } from '../api/message-content';
import { ISSUE_REF_BLOCK_RE } from './issue-mentions';

/** One inlined text/PDF attachment from history. */
export interface HistoryFilePart {
  name: string;
  body: string;
}

/** One image placeholder from history (`[image: name]`). */
export interface HistoryImagePart {
  name: string;
}

/** Editor selection reference (`<code-ref path="…" start="…" end="…">`). */
export interface HistoryCodeRefPart {
  workspacePath: string;
  startLine: number;
  endLine: number;
  body: string;
}

/** Design Mode element pick (`<element-ref selector="…" page="…" …>`). */
export interface HistoryElementRefPart {
  selector: string;
  uid: number | null;
  pageUrl: string;
  tagName: string;
  classList: string[];
  rect: { x: number; y: number; width: number; height: number } | null;
  stylesDigest: string;
  /** Name of the co-emitted `[image: name]` placeholder, when a crop was captured. */
  imageName: string | null;
  outerHtmlPreview: string;
  /** `file:line` (or component name) resolved for this pick, when resolution had landed by send time (MIN-369). */
  source: string | null;
  /** `exact` | `probable` | `guess`, when `source` is present. */
  confidence: string | null;
  /** A11y quick-pass (MIN-370): aria-label || alt || trimmed text content. */
  accessibleName: string | null;
  /** A11y quick-pass (MIN-370): WCAG contrast ratio, when computable. */
  contrastRatio: number | null;
}

/** Design Mode drawn shape (`<design-ref kind="…" page="…" anchor="…" …>`). */
export interface HistoryDesignRefPart {
  kind: string;
  pageUrl: string;
  anchor:
    | { type: 'element'; uid: number | null; selector: string }
    | { type: 'page'; x: number; y: number }
    | null;
  /** Name of the co-emitted `[image: name]` placeholder, when a composited crop was captured. */
  imageName: string | null;
  intentText: string;
  /** annotation-store shape id (MIN-368) — links this history block back to annotations.json. */
  shapeId: string | null;
}

/** Parsed segments for chat UI rendering. */
export interface ParsedHistoryUserMessage {
  /** User-typed prose without attachment markers or file bodies. */
  text: string;
  files: HistoryFilePart[];
  images: HistoryImagePart[];
  codeRefs: HistoryCodeRefPart[];
  elementRefs: HistoryElementRefPart[];
  designRefs: HistoryDesignRefPart[];
  /** Ids of issues typed in the message whose details were attached at send. */
  issueRefIds: string[];
}

const FILE_BLOCK_RE = /<file name="([^"]*)">\n([\s\S]*?)\n<\/file>/g;
const CODE_REF_BLOCK_RE =
  /<code-ref path="([^"]*)" start="(\d+)" end="(\d+)">\n([\s\S]*?)\n<\/code-ref>/g;
const ELEMENT_REF_BLOCK_RE =
  /<element-ref selector="([^"]*)"(?: uid="(\d+)")? page="([^"]*)" tag="([^"]*)" classes="([^"]*)" rect="([^"]*)" styles="([^"]*)"(?: source="([^"]*)")?(?: confidence="([^"]*)")?(?: name="([^"]*)")?(?: contrast="([^"]*)")?(?: image="([^"]*)")?>\n([\s\S]*?)\n<\/element-ref>/g;
/** Fallback: strip any element-ref block the strict regex missed (e.g. legacy inline shapes). */
const ELEMENT_REF_LOOSE_RE = /<element-ref[\s\S]*?<\/element-ref>/g;
const DESIGN_REF_BLOCK_RE =
  /<design-ref kind="([^"]*)" page="([^"]*)" anchor="(element|page)"(?: anchorSelector="([^"]*)")?(?: anchorUid="(\d+)")?(?: anchorX="(-?\d+)")?(?: anchorY="(-?\d+)")?(?: image="([^"]*)")?(?: id="([^"]*)")?>\n([\s\S]*?)\n<\/design-ref>/g;
const IMAGE_PLACEHOLDER_RE = /\[image:\s*([^\]]+)\]/g;

function parseRect(raw: string): { x: number; y: number; width: number; height: number } | null {
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) return null;
  const [x, y, width, height] = parts;
  return { x, y, width, height };
}

/** Remove attachment blocks from visible prose; collapse extra blank lines. */
function stripAttachmentMarkers(content: string): string {
  const withoutFiles = content.replace(FILE_BLOCK_RE, '');
  const withoutCodeRefs = withoutFiles.replace(CODE_REF_BLOCK_RE, '');
  const withoutElementRefs = withoutCodeRefs
    .replace(ELEMENT_REF_BLOCK_RE, '')
    .replace(ELEMENT_REF_LOOSE_RE, '');
  const withoutDesignRefs = withoutElementRefs.replace(DESIGN_REF_BLOCK_RE, '');
  const withoutIssueRefs = withoutDesignRefs.replace(ISSUE_REF_BLOCK_RE, '');
  const withoutImages = withoutIssueRefs.replace(IMAGE_PLACEHOLDER_RE, '');
  return withoutImages.replace(/\n{3,}/g, '\n\n').trim();
}

export function parseHistoryUserContent(content: unknown): ParsedHistoryUserMessage {
  const text = apiMessageContentToText(content);
  const files: HistoryFilePart[] = [];
  const images: HistoryImagePart[] = [];
  const codeRefs: HistoryCodeRefPart[] = [];
  const elementRefs: HistoryElementRefPart[] = [];
  const designRefs: HistoryDesignRefPart[] = [];

  for (const match of text.matchAll(FILE_BLOCK_RE)) {
    const name = match[1] ?? '';
    const body = match[2] ?? '';
    if (name) files.push({ name, body });
  }

  for (const match of text.matchAll(CODE_REF_BLOCK_RE)) {
    const workspacePath = match[1] ?? '';
    const startLine = Number(match[2]);
    const endLine = Number(match[3]);
    const body = match[4] ?? '';
    if (workspacePath && Number.isFinite(startLine) && Number.isFinite(endLine)) {
      codeRefs.push({
        workspacePath,
        startLine,
        endLine,
        body,
      });
    }
  }

  for (const match of text.matchAll(ELEMENT_REF_BLOCK_RE)) {
    const selector = match[1] ?? '';
    const uid = match[2] != null ? Number(match[2]) : null;
    const pageUrl = match[3] ?? '';
    const tagName = match[4] ?? '';
    const classList = (match[5] ?? '').split(/\s+/).filter(Boolean);
    const rect = parseRect(match[6] ?? '');
    const stylesDigest = match[7] ?? '';
    const source = match[8] ?? null;
    const confidence = match[9] ?? null;
    const accessibleName = match[10] ?? null;
    const contrastRaw = match[11] ?? null;
    const contrastRatio =
      contrastRaw != null && contrastRaw !== '' && Number.isFinite(Number(contrastRaw))
        ? Number(contrastRaw)
        : null;
    const imageName = match[12] ?? null;
    const body = match[13] ?? '';
    const htmlMarker = body.lastIndexOf('\nHTML\n');
    const outerHtmlPreview = htmlMarker === -1 ? body : body.slice(htmlMarker + '\nHTML\n'.length);
    if (selector) {
      elementRefs.push({
        selector,
        uid,
        pageUrl,
        tagName,
        classList,
        rect,
        stylesDigest,
        imageName,
        outerHtmlPreview,
        source,
        confidence,
        accessibleName,
        contrastRatio,
      });
    }
  }

  for (const match of text.matchAll(DESIGN_REF_BLOCK_RE)) {
    const kind = match[1] ?? '';
    const pageUrl = match[2] ?? '';
    const anchorType = match[3];
    const anchorSelector = match[4] ?? '';
    const anchorUid = match[5] != null ? Number(match[5]) : null;
    const anchorX = match[6] != null ? Number(match[6]) : null;
    const anchorY = match[7] != null ? Number(match[7]) : null;
    const imageName = match[8] ?? null;
    const shapeId = match[9] ?? null;
    const intentText = match[10] ?? '';
    let anchor: HistoryDesignRefPart['anchor'] = null;
    if (anchorType === 'element' && anchorSelector) {
      anchor = { type: 'element', uid: anchorUid, selector: anchorSelector };
    } else if (anchorType === 'page' && anchorX != null && anchorY != null) {
      anchor = { type: 'page', x: anchorX, y: anchorY };
    }
    if (kind) {
      designRefs.push({ kind, pageUrl, anchor, imageName, intentText, shapeId });
    }
  }

  for (const match of text.matchAll(IMAGE_PLACEHOLDER_RE)) {
    const name = (match[1] ?? '').trim();
    if (name) images.push({ name });
  }

  const issueRefIds = [...new Set([...text.matchAll(ISSUE_REF_BLOCK_RE)].map((m) => m[1]))];

  return {
    text: stripAttachmentMarkers(text),
    files,
    images,
    codeRefs,
    elementRefs,
    issueRefIds,
    designRefs,
  };
}

/** True when content includes inlined files or image placeholders. */
export function historyUserContentHasAttachments(content: unknown): boolean {
  const text = apiMessageContentToText(content);
  FILE_BLOCK_RE.lastIndex = 0;
  CODE_REF_BLOCK_RE.lastIndex = 0;
  ELEMENT_REF_BLOCK_RE.lastIndex = 0;
  DESIGN_REF_BLOCK_RE.lastIndex = 0;
  IMAGE_PLACEHOLDER_RE.lastIndex = 0;
  return (
    FILE_BLOCK_RE.test(text) ||
    CODE_REF_BLOCK_RE.test(text) ||
    ELEMENT_REF_BLOCK_RE.test(text) ||
    DESIGN_REF_BLOCK_RE.test(text) ||
    IMAGE_PLACEHOLDER_RE.test(text)
  );
}
