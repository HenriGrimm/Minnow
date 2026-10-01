import type { Chat } from '../types';
import { ensureChatHistoryLoaded, sessionState } from '../state/sessions';
import { chatTranscriptFilename, formatChatTranscript, formatChatTranscriptHtml } from '../chat/transcript-export';
import { showToast } from './toast';

export async function runChatTranscriptExport(chat: Chat, format: 'text' | 'html'): Promise<void> {
  try {
    await ensureChatHistoryLoaded(chat.id);
    const current = sessionState?.chats.find((item) => item.id === chat.id);
    if (!current) throw new Error('This chat is no longer available');
    if (format === 'text') {
      await navigator.clipboard.writeText(formatChatTranscript(current));
      showToast('Chat transcript copied');
    } else {
      const blob = new Blob([formatChatTranscriptHtml(current)], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = chatTranscriptFilename(current.name);
      document.body.appendChild(anchor);
      try { anchor.click(); } finally {
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      showToast('Chat transcript exported');
    }
  } catch (error) {
    showToast(`Could not ${format === 'text' ? 'copy' : 'export'} transcript: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}
