import type { Attachment } from '../attachments/types';
import { estimateTextByteSize, inferFileKindFromName } from '../attachments/file-card';
import { randomUUID } from '../lib/random-id';
import { formatComposerTextFromHistory } from '../skills/history-content';
import { stripIssueRefBlocks } from './issue-mentions';
import { parseHistoryUserContent, stripHistoryFileBlocks } from './user-message-parts';

/** Restore attached file snapshots separately from the editable prompt. */
export function messageEditDraft(content: unknown): { text: string; attachments: Attachment[] } {
  const { files } = parseHistoryUserContent(content);
  return {
    text: stripIssueRefBlocks(formatComposerTextFromHistory(stripHistoryFileBlocks(content))).trimEnd(),
    attachments: files.map(({ name, body }) => ({
      id: randomUUID(),
      name,
      kind: inferFileKindFromName(name),
      mimeType: 'text/plain',
      size: estimateTextByteSize(body),
      text: body,
    })),
  };
}
