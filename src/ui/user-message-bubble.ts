import {
  createFileCardBody,
  estimateTextByteSize,
  inferFileKindFromName,
} from '../attachments/file-card';
import type { Attachment } from '../attachments/types';
import type { UserImageAttachment } from '../types';
import { formatElementRefLabel } from '../attachments/element-ref-format';
import { formatDesignRefLabel } from '../attachments/design-ref-format';
import {
  parseHistoryUserContent,
  type HistoryDesignRefPart,
  type HistoryElementRefPart,
} from '../chat/user-message-parts';
import { parseSkillTagFromHistory } from '../skills/history-content';
import { appendHighlightedSkillText, restoreLeadingSkillToken } from '../skills/skill-chip';
import { createCodeRefLinkButton } from './code-ref-link';

/** Optional live attachments when the bubble is painted at send time. */
export interface UserBubbleRenderOptions {
  /** Pending attachments from the composer (includes image data URLs). */
  liveAttachments?: Attachment[];
  /** Image bytes stored on the history row. */
  persistedImages?: UserImageAttachment[];
}

/** Stored bytes for one `[image: name]` placeholder, or undefined for old rows. */
function findPersistedImageDataUrl(
  name: string,
  persisted?: UserImageAttachment[],
): string | undefined {
  return persisted?.find((image) => image.name === name)?.dataUrl;
}

function findLiveImageDataUrl(
  name: string,
  options?: UserBubbleRenderOptions,
): string | undefined {
  const hit = options?.liveAttachments?.find((a) => a.kind === 'image' && a.name === name);
  return hit?.dataUrl ?? findPersistedImageDataUrl(name, options?.persistedImages);
}

function findLiveElementRefDataUrl(
  name: string,
  options?: UserBubbleRenderOptions,
): string | undefined {
  const hit = options?.liveAttachments?.find((a) => a.kind === 'elementRef' && a.name === name);
  return hit?.croppedDataUrl ?? findPersistedImageDataUrl(name, options?.persistedImages);
}

function findLiveDesignRefDataUrl(
  name: string,
  options?: UserBubbleRenderOptions,
): string | undefined {
  const hit = options?.liveAttachments?.find((a) => a.kind === 'designRef' && a.name === name);
  return hit?.compositedDataUrl ?? findPersistedImageDataUrl(name, options?.persistedImages);
}

/** Multi-line "open" body for an element-ref chip (selector, styles, outerHTML preview). */
function elementRefSummaryText(ref: HistoryElementRefPart): string {
  const lines: string[] = [
    `Selector: ${ref.selector}`,
    ...(ref.uid != null ? [`data-mn-uid: ${ref.uid}`] : []),
    `Tag: ${ref.tagName}`,
    ...(ref.classList.length ? [`Classes: ${ref.classList.join(' ')}`] : []),
    ...(ref.rect
      ? [
          `Rect: ${Math.round(ref.rect.x)},${Math.round(ref.rect.y)} ${Math.round(ref.rect.width)}×${Math.round(ref.rect.height)}`,
        ]
      : []),
    `Page: ${ref.pageUrl}`,
    `Styles: ${ref.stylesDigest}`,
    ...(ref.accessibleName ? [`Accessible name: ${ref.accessibleName}`] : []),
    ...(ref.contrastRatio != null ? [`Contrast: ${ref.contrastRatio}`] : []),
    ...(ref.source ? [`Source: ${ref.source}${ref.confidence ? ` (${ref.confidence})` : ''}`] : []),
    '',
    ref.outerHtmlPreview,
  ];
  return lines.join('\n');
}

/** Multi-line "open" body for a design-ref chip (kind, anchor, page, intent text). */
function designRefSummaryText(ref: HistoryDesignRefPart): string {
  const lines: string[] = [
    `Kind: ${ref.kind}`,
    ...(ref.anchor?.type === 'element'
      ? [
          `Anchor: element ${ref.anchor.selector}`,
          ...(ref.anchor.uid != null ? [`data-mn-uid: ${ref.anchor.uid}`] : []),
        ]
      : ref.anchor?.type === 'page'
        ? [`Anchor: page @ ${ref.anchor.x},${ref.anchor.y}`]
        : []),
    `Page: ${ref.pageUrl}`,
    '',
    ref.intentText,
  ];
  return lines.join('\n');
}

function openFilePart(name: string, body: string): void {
  void import('./file-viewer').then((m) => {
    m.openAttachmentSnapshotInViewer(name, body);
  });
}

/** "View on page" affordance for a linked design-ref (MIN-368): opens the preview at the shape's page, enables Design Mode, and pulses the surviving anchor — or toasts that it's moved/removed when the shape's uid AND selector both fail to resolve on the live page. */
function createOnPageButton(pageUrl: string, shapeId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-onpage-btn';
  btn.title = 'View this mark on the page';
  btn.setAttribute('aria-label', 'View this mark on the page');
  btn.textContent = '◎';
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void Promise.all([
      import('../design/annotation-nav'),
      import('./toast'),
    ]).then(async ([nav, toast]) => {
      const status = await nav.openAnnotationOnPage(pageUrl, { shapeId });
      if (status === 'dead') {
        toast.showToast('This mark moved or was removed from the page.', 'error');
      } else if (status === 'unavailable') {
        toast.showToast('Could not locate this annotation.', 'error');
      }
    });
  });
  return btn;
}

function createMessageAttachChip(
  label: string,
  options: {
    kind: 'file' | 'image';
    dataUrl?: string;
    /** Byte size for file cards (history estimate or live attachment). */
    fileSize?: number;
    /** Attachment kind for file badge tint (`text` | `pdf`). */
    fileKind?: Attachment['kind'];
    /** Native tooltip — defaults to "Open {label}". */
    title?: string;
    onOpen: () => void;
  },
): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'msg-attach-chip';
  if (options.kind === 'image') {
    chip.classList.add('msg-attach-chip--image');
  } else {
    chip.classList.add('msg-attach-chip--file');
  }
  chip.title = options.title ?? `Open ${label}`;
  chip.setAttribute('aria-label', `Open attachment ${label}`);

  if (options.kind === 'image' && options.dataUrl) {
    const thumb = document.createElement('img');
    thumb.className = 'msg-attach-chip-thumb';
    thumb.src = options.dataUrl;
    thumb.alt = '';
    chip.appendChild(thumb);
  }

  if (options.kind === 'file') {
    const fileKind = options.fileKind ?? 'text';
    const fileSize = options.fileSize ?? 0;
    const { icon, stack } = createFileCardBody({
      name: label,
      size: fileSize,
      kind: fileKind,
    });
    chip.append(icon, stack);
  } else {
    const nameEl = document.createElement('span');
    nameEl.className = 'msg-attach-chip-label';
    nameEl.textContent = label;
    chip.appendChild(nameEl);
  }

  chip.addEventListener('click', () => options.onOpen());
  return chip;
}

function findLiveFileAttachment(
  name: string,
  liveAttachments?: Attachment[],
): Attachment | undefined {
  if (!liveAttachments?.length) return undefined;
  return liveAttachments.find(
    (item) =>
      item.name === name && (item.kind === 'text' || item.kind === 'pdf'),
  );
}

/**
 * Paint a user bubble: visible text plus attachment chips (not raw file bodies).
 */
export function renderUserMessageBubble(
  bubble: HTMLDivElement,
  historyContent: unknown,
  options?: UserBubbleRenderOptions,
): void {
  bubble.replaceChildren();
  bubble.classList.add('msg-bubble--user-parts');

  // Restore `/skill-id` that send stored only as a `[skill:]` footer.
  const tagged = parseSkillTagFromHistory(historyContent);
  const displaySource = restoreLeadingSkillToken(tagged.displayText, tagged.skillId);
  const parsed = parseHistoryUserContent(displaySource);
  const live = options?.liveAttachments;
  const extraSkillIds = tagged.skillId ? [tagged.skillId] : undefined;

  if (parsed.text) {
    const textEl = document.createElement('div');
    textEl.className = 'user-msg-text';
    appendHighlightedSkillText(textEl, parsed.text, extraSkillIds);
    bubble.appendChild(textEl);
  }

  const elementRefImageNames = new Set(
    parsed.elementRefs.map((ref) => ref.imageName).filter((name): name is string => Boolean(name)),
  );
  const designRefImageNames = new Set(
    parsed.designRefs.map((ref) => ref.imageName).filter((name): name is string => Boolean(name)),
  );
  const visibleImages = parsed.images.filter(
    (image) => !elementRefImageNames.has(image.name) && !designRefImageNames.has(image.name),
  );

  const hasChips =
    parsed.files.length > 0 ||
    visibleImages.length > 0 ||
    parsed.codeRefs.length > 0 ||
    parsed.elementRefs.length > 0 ||
    parsed.designRefs.length > 0;
  if (!hasChips) {
    if (!parsed.text) {
      bubble.textContent = displaySource.trim() || displaySource;
      bubble.classList.remove('msg-bubble--user-parts');
    }
    return;
  }

  if (parsed.codeRefs.length > 0) {
    const refsRow = document.createElement('div');
    refsRow.className = 'user-msg-code-refs';
    refsRow.setAttribute('role', 'list');
    for (const ref of parsed.codeRefs) {
      refsRow.appendChild(
        createCodeRefLinkButton({
          workspacePath: ref.workspacePath,
          startLine: ref.startLine,
          endLine: ref.endLine,
        }),
      );
    }
    bubble.appendChild(refsRow);
  }

  const row = document.createElement('div');
  row.className = 'user-msg-attachments';
  row.setAttribute('role', 'list');

  for (const file of parsed.files) {
    const liveFile = findLiveFileAttachment(file.name, live);
    const fileKind = liveFile?.kind ?? inferFileKindFromName(file.name);
    const fileSize = liveFile?.size || estimateTextByteSize(file.body);
    row.appendChild(
      createMessageAttachChip(file.name, {
        kind: 'file',
        fileSize,
        fileKind,
        onOpen: () => openFilePart(file.name, file.body),
      }),
    );
  }

  for (const image of visibleImages) {
    const dataUrl = findLiveImageDataUrl(image.name, options);
    row.appendChild(
      createMessageAttachChip(image.name, {
        kind: 'image',
        dataUrl,
        onOpen: () => {
          if (dataUrl) {
            void import('./file-viewer').then((m) => {
              void m.openImageDataUrlInViewer(image.name, dataUrl);
            });
            return;
          }
          setStatusForMissingImage(image.name);
        },
      }),
    );
  }

  for (const ref of parsed.elementRefs) {
    const label = formatElementRefLabel(ref.selector, ref.pageUrl);
    const dataUrl = ref.imageName ? findLiveElementRefDataUrl(ref.imageName, options) : undefined;
    const summary = elementRefSummaryText(ref);
    row.appendChild(
      createMessageAttachChip(label, {
        kind: 'image',
        dataUrl,
        title: summary,
        onOpen: () => openFilePart(label, summary),
      }),
    );
  }

  for (const ref of parsed.designRefs) {
    const label = formatDesignRefLabel(ref.kind, ref.pageUrl);
    const dataUrl = ref.imageName ? findLiveDesignRefDataUrl(ref.imageName, options) : undefined;
    row.appendChild(
      createMessageAttachChip(label, {
        kind: 'image',
        dataUrl,
        onOpen: () => openFilePart(label, designRefSummaryText(ref)),
      }),
    );
    if (ref.shapeId) {
      row.appendChild(createOnPageButton(ref.pageUrl, ref.shapeId));
    }
  }

  if (
    parsed.files.length > 0 ||
    visibleImages.length > 0 ||
    parsed.elementRefs.length > 0 ||
    parsed.designRefs.length > 0
  ) {
    bubble.appendChild(row);
  }
}

function setStatusForMissingImage(name: string): void {
  void import('./status').then((m) => {
    m.setStatus('err', `Image preview not stored for ${name}`);
  });
}
