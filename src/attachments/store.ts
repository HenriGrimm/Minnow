/**
 * Pending attachment list and composer preview chips (SA-12).
 * Send path and multimodal API wiring land in SA-13 / SA-15.
 */

import { createFileCardBody, inferFileKindFromName } from './file-card';
import { isImageFilePath } from './image-path';
import { formatCodeRefLabel } from './code-ref-format';
import { processFile } from './reader';
import { scheduleContextUsageRefresh } from '../ui/context-usage-ring';
import type { Attachment } from './types';
import type { SourceMapping } from '../design/source-map';

// ── Queue ────────────────────────────────────────────────────────────────────

/** Files queued for the next user message. */
const pendingAttachments: Attachment[] = [];
let attachmentEpoch = 0;

/** Changes when the current composer queue is discarded. */
export function getAttachmentEpoch(): number {
  return attachmentEpoch;
}

/** Returns a shallow copy of pending attachments. */
export function getPendingAttachments(): Attachment[] {
  return [...pendingAttachments];
}

/** Clears all pending attachments and refreshes the preview strip. */
export function clearAttachments(): void {
  attachmentEpoch += 1;
  pendingAttachments.length = 0;
  renderAttachPreview();
}

/** Removes queued Design Mode elementRef and designRef attachments for one preview page. */
export function removeDesignAttachmentsForPage(pageUrl: string): void {
  const page = pageUrl.trim();
  if (!page) return;
  const next = pendingAttachments.filter(
    (item) =>
      !((item.kind === 'elementRef' || item.kind === 'designRef') && item.pageUrl === page),
  );
  if (next.length === pendingAttachments.length) return;
  replacePendingAttachments(next);
}

/** Removes one attachment by id. */
export function removeAttachment(id: string): void {
  const index = pendingAttachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  pendingAttachments.splice(index, 1);
  renderAttachPreview();
}

/** Appends one attachment and refreshes the preview strip. */
export function pushAttachment(attachment: Attachment): void {
  pendingAttachments.push(attachment);
  renderAttachPreview();
}

/**
 * Sets/replaces an `elementRef` attachment's resolved source location and re-renders its chip
 * in place (MIN-369) — called once Design Mode's async file:line resolution lands, well after
 * the chip already rendered without it. No-op if the attachment was removed/sent meanwhile.
 */
export function updateAttachmentSourceMapping(id: string, mapping: SourceMapping): void {
  const index = pendingAttachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  pendingAttachments[index] = { ...pendingAttachments[index], sourceMapping: mapping };
  renderAttachPreview();
}

/** Replaces the pending list (e.g. after workspace refs are resolved on send). */
export function replacePendingAttachments(next: Attachment[]): void {
  pendingAttachments.length = 0;
  pendingAttachments.push(...next);
  renderAttachPreview();
}

/**
 * Puts a sent turn's attachments back in the composer after that turn failed or was
 * stopped (MIN-650). Merges rather than replaces: the user is free to queue new files
 * while a turn runs, and a straight replace would silently throw those away.
 */
export function restorePendingAttachments(previous: Attachment[]): void {
  if (!previous.length) return;
  const present = new Set(pendingAttachments.map((item) => item.id));
  const missing = previous.filter((item) => !present.has(item.id));
  if (!missing.length) return;
  pendingAttachments.unshift(...missing);
  renderAttachPreview();
}

// ── Add files ────────────────────────────────────────────────────────────────

/**
 * Processes and appends files from the hidden file input.
 * Oversize and unsupported types become error chips.
 */
export async function addAttachments(files: File[]): Promise<void> {
  if (!files.length) return;

  const epoch = attachmentEpoch;
  const results = await Promise.all(files.map((file) => processFile(file)));
  if (attachmentEpoch !== epoch) return;
  pendingAttachments.push(...results);
  renderAttachPreview();
}

/** Label shown on a preview chip for one attachment. */
function chipLabel(attachment: Attachment): string {
  if (attachment.kind === 'error') {
    return attachment.error ?? attachment.name;
  }
  if (attachment.kind === 'workspace') {
    return attachment.workspacePath ?? attachment.name;
  }
  if (attachment.kind === 'codeRef' || attachment.kind === 'elementRef' || attachment.kind === 'designRef') {
    return attachment.name;
  }
  if (attachment.largeTextWarning) {
    return `${attachment.name} (large file)`;
  }
  return attachment.name;
}

/** True when this attachment should use the file preview card (not a plain label). */
function isFileCardAttachment(attachment: Attachment): boolean {
  if (attachment.kind === 'text' || attachment.kind === 'pdf') return true;
  if (attachment.kind === 'workspace' && attachment.workspacePath) {
    return !isImageFilePath(attachment.workspacePath);
  }
  return false;
}

/** Badge kind for workspace paths queued before send. */
function fileCardKindForAttachment(attachment: Attachment): Attachment['kind'] {
  if (attachment.kind === 'text' || attachment.kind === 'pdf') return attachment.kind;
  if (attachment.kind === 'workspace') return inferFileKindFromName(attachment.name);
  return 'text';
}

/** Builds one preview chip element. */
function createAttachChip(attachment: Attachment): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'attach-chip';
  chip.dataset.attachmentId = attachment.id;

  if (attachment.kind === 'image') {
    chip.classList.add('attach-chip--image');
    if (attachment.dataUrl) {
      const thumb = document.createElement('img');
      thumb.className = 'attach-chip-thumb';
      thumb.src = attachment.dataUrl;
      thumb.alt = '';
      chip.appendChild(thumb);
    }
  }

  if (attachment.kind === 'workspace') {
    if (isImageFilePath(attachment.workspacePath ?? '')) {
      chip.classList.add('attach-chip--workspace');
      chip.title = 'Workspace image — loads when you send';
    } else {
      chip.title = 'Workspace file — loads when you send';
    }
  }

  if (
    attachment.kind === 'codeRef' &&
    attachment.workspacePath &&
    attachment.lineStart != null &&
    attachment.lineEnd != null
  ) {
    chip.classList.add('attach-chip--code-ref');
    chip.title = 'Selection — included when you send';
    const path = attachment.workspacePath;
    const startLine = attachment.lineStart;
    const endLine = attachment.lineEnd;
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'code-ref-link code-ref-link--chip';
    const label = formatCodeRefLabel(path, startLine, endLine);
    const fileName = label.replace(/\s+L\d+(-\d+)?$/, '');
    const linePart = label.slice(fileName.length).trim();
    link.title = `Open ${path} ${linePart}`;
    const icon = document.createElement('span');
    icon.className = 'code-ref-link__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '<>';
    link.appendChild(icon);
    const nameEl = document.createElement('span');
    nameEl.className = 'code-ref-link__name';
    nameEl.textContent = fileName;
    link.appendChild(nameEl);
    if (linePart) {
      const linesEl = document.createElement('span');
      linesEl.className = 'code-ref-link__lines';
      linesEl.textContent = linePart;
      link.appendChild(linesEl);
    }
    link.addEventListener('click', (event) => {
      event.stopPropagation();
      void import('../ui/code-ref-link').then((m) => {
        m.openCodeRefInViewer({ workspacePath: path, startLine, endLine });
      });
    });
    chip.appendChild(link);
  }

  if (attachment.kind === 'elementRef') {
    chip.classList.add('attach-chip--element-ref');
    if (attachment.croppedDataUrl) {
      chip.classList.add('attach-chip--image');
      const thumb = document.createElement('img');
      thumb.className = 'attach-chip-thumb';
      thumb.src = attachment.croppedDataUrl;
      thumb.alt = '';
      chip.appendChild(thumb);
    }
    chip.title = attachment.selector
      ? `${attachment.selector} — included when you send`
      : 'Element reference — included when you send';

    const mapping = attachment.sourceMapping;
    if (mapping?.file) {
      const file = mapping.file;
      const line = mapping.line;
      const mapBtn = document.createElement('button');
      mapBtn.type = 'button';
      mapBtn.className = `attach-chip-source-map attach-chip-source-map--${mapping.confidence}`;
      mapBtn.textContent = `→ ${file}${line != null ? `:${line}` : ''}`;
      mapBtn.title = `Open ${file}${line != null ? `:${line}` : ''} (${mapping.confidence} match)`;
      mapBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void import('../ui/code-ref-link').then((m) => {
          m.openCodeRefInViewer({ workspacePath: file, startLine: line ?? 1, endLine: line ?? 1 });
        });
      });
      chip.appendChild(mapBtn);
    }
  }

  if (attachment.kind === 'designRef') {
    chip.classList.add('attach-chip--design-ref');
    if (attachment.compositedDataUrl) {
      chip.classList.add('attach-chip--image');
      const thumb = document.createElement('img');
      thumb.className = 'attach-chip-thumb';
      thumb.src = attachment.compositedDataUrl;
      thumb.alt = '';
      chip.appendChild(thumb);
    }
    chip.title = attachment.intentText
      ? `${attachment.intentText} — included when you send`
      : 'Design annotation — included when you send';
  }

  if (attachment.kind === 'error') {
    chip.classList.add('attach-chip--error');
    chip.title = attachment.error ?? 'Attachment error';
  } else if (attachment.largeTextWarning) {
    chip.title = 'File is larger than 32KB; only an excerpt may be sent.';
  }

  const usesFileCard = isFileCardAttachment(attachment);
  if (usesFileCard) {
    chip.classList.add('attach-chip--file');
    const { icon, stack } = createFileCardBody({
      name: attachment.largeTextWarning
        ? `${attachment.name} (large file)`
        : attachment.name,
      size: attachment.size,
      kind: fileCardKindForAttachment(attachment),
      workspaceRef: attachment.kind === 'workspace',
    });
    chip.append(icon, stack);
  } else {
    const label = document.createElement('span');
    label.className = 'attach-chip-label';
    label.textContent = chipLabel(attachment);
    chip.appendChild(label);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'attach-chip-remove';
  removeBtn.setAttribute('aria-label', `Remove ${attachment.name}`);
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => removeAttachment(attachment.id));
  chip.appendChild(removeBtn);

  return chip;
}

/** Composer preview strip ids shared by Code and Minnow chat surfaces. */
const ATTACH_PREVIEW_IDS = [
  'attachPreview',
  'chatAppAttachPreview',
  'desktopAttachPreview',
  'emailAssistantAttachPreview',
] as const;

// ── Preview ──────────────────────────────────────────────────────────────────

/** Renders chips into composer preview strips when markup exists (SA-15). */
export function renderAttachPreview(): void {
  const containers = ATTACH_PREVIEW_IDS.map((id) => document.getElementById(id)).filter(
    (el): el is HTMLElement => el != null,
  );
  if (!containers.length) return;

  const hasAttachments = pendingAttachments.length > 0;
  for (const container of containers) {
    container.replaceChildren();
    if (!hasAttachments) {
      container.classList.add('hidden');
      continue;
    }
    container.classList.remove('hidden');
    for (const attachment of pendingAttachments) {
      container.appendChild(createAttachChip(attachment));
    }
  }
  if (hasAttachments) {
    scheduleContextUsageRefresh();
  }
}

/** Handles change on the hidden #fileInput (also exposed on window for inline HTML). */
export function onFileSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const list = input.files;
  if (!list?.length) return;

  void addAttachments(Array.from(list));
  input.value = '';
}

/**
 * Wires attach button and file input when present in index.html (SA-15).
 * Safe to call before markup exists — no-op until elements are added.
 */
export function initAttachments(): void {
  const fileInput = document.getElementById('fileInput') as HTMLInputElement | null;
  const attachBtn = document.getElementById('attachBtn');

  if (fileInput) {
    fileInput.addEventListener('change', onFileSelected);
  }

  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
  }

  const chatAttachBtn = document.getElementById('btnChatAppAttach');
  if (chatAttachBtn && fileInput) {
    chatAttachBtn.addEventListener('click', () => fileInput.click());
  }

  const desktopAttachBtn = document.getElementById('btnDesktopAttach');
  if (desktopAttachBtn && fileInput) {
    desktopAttachBtn.addEventListener('click', () => fileInput.click());
  }

  renderAttachPreview();
}
