import { addAttachments } from '../attachments/store';
import { chatReferencesInText } from './chat-reference-chip';
import { insertInlineComposerText, syncInlineComposerReferences } from './composer-inline-references';

/** Keep pasted references at the insertion point and paint them before the next frame. */
export function pasteChatReferences(input: HTMLTextAreaElement, text: string): boolean {
  if (input.disabled || input.readOnly) return false;
  if (!chatReferencesInText(text).length) return false;
  insertInlineComposerText(input, text);
  return true;
}

/** Clipboard images are nameless blobs; give them a stable, sortable filename. */
function nameForPastedImage(file: File, index: number): string {
  const existing = file.name?.trim();
  if (existing && existing !== 'image.png' && existing !== 'blob') return existing;
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '-')
    .slice(0, 19);
  const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const suffix = index > 0 ? `-${index + 1}` : '';
  return `pasted-${stamp}${suffix}.${ext}`;
}

/** Image files on a clipboard payload, renamed for the attachment chip. */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const raw: File[] = [];

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) raw.push(file);
  }

  if (raw.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.startsWith('image/')) raw.push(file);
    }
  }

  return raw.map((file, index) =>
    new File([file], nameForPastedImage(file, index), { type: file.type }),
  );
}

export function pasteIsImageOnly(data: DataTransfer | null): boolean {
  if (!data) return false;
  const text = data.getData('text/plain');
  return !text.trim();
}

/** Composer textareas across the Code, Chat app, email, and desktop surfaces. */
const COMPOSER_INPUT_IDS = new Set([
  'msgInput',
  'chatAppInput',
  'emailAssistantInput',
  'desktopInput',
]);

/** True when the paste landed in a chat composer (not an issue body or a code editor). */
export function isComposerPasteTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const input = target instanceof HTMLTextAreaElement ? target : target.closest('textarea');
  return input instanceof HTMLTextAreaElement && COMPOSER_INPUT_IDS.has(input.id);
}

function onComposerPaste(event: ClipboardEvent): void {
  if (!isComposerPasteTarget(event.target)) return;
  const input = event.target instanceof HTMLTextAreaElement ? event.target : (event.target as HTMLElement).closest('textarea');
  if (input?.disabled || input?.readOnly) return;
  const data = event.clipboardData;
  if (input && data && pasteChatReferences(input, data.getData('text/plain'))) {
    event.preventDefault();
    return;
  }
  if (!pasteIsImageOnly(data)) return;
  const files = imageFilesFromClipboard(data);
  if (!files.length) return;
  event.preventDefault();
  void addAttachments(files);
}

const boundDocuments = new WeakSet<Document>();

/** Wires paste-to-attach for every composer surface. */
export function initComposerPaste(): void {
  if (boundDocuments.has(document)) return;
  boundDocuments.add(document);
  document.addEventListener('paste', onComposerPaste);
  document.addEventListener('input', event => {
    if (isComposerPasteTarget(event.target)) syncInlineComposerReferences(event.target as HTMLTextAreaElement);
  }, true);
}
