import { getMainTurnActivity } from '../chat/main-turn-activity';
import { isChatStreaming, isStreamDomVisible } from '../chat/streaming-state';
import { getSidebarStreamPhase } from '../ui/chat-item-dot';
import type { StreamingAssistantRow } from '../ui/messages';
import { appendStreamingAssistantRow } from '../ui/messages';
import type { StreamingStatusHandle } from '../ui/stream-status';
import type { ThoughtBubbleController } from '../ui/thought-bubbles';

export interface StreamDomHandles {
  wrap: HTMLDivElement;
  bubble: HTMLDivElement;
  cursor: HTMLDivElement;
  streamStatus: StreamingStatusHandle;
}

type RemountListener = (row: StreamDomHandles) => void;

const remountListeners = new Map<string, RemountListener>();

/** runChatTurn registers while a turn runs; cleared in finally. */
export function registerStreamDomRemount(
  chatId: string,
  listener: RemountListener | null,
): void {
  if (listener) {
    remountListeners.set(chatId, listener);
  } else {
    remountListeners.delete(chatId);
  }
}

/** After switchChat, attach a fresh stream shell if this chat is still in-flight. */
export function remountStreamDomForChat(chatId: string): void {
  if (!isChatStreaming(chatId) || !isStreamDomVisible(chatId)) return;

  const activity = getMainTurnActivity(chatId);
  if (activity?.phase === 'tools' && !activity.receivingToolArguments) return;

  const listener = remountListeners.get(chatId);
  if (!listener) {
    return;
  }

  const row: StreamingAssistantRow = appendStreamingAssistantRow(chatId);
  listener({
    wrap: row.wrap,
    bubble: row.bubble,
    cursor: row.cursor,
    streamStatus: row.streamStatus,
  });

  const phase = getSidebarStreamPhase(chatId);
  if (phase === 'thinking') {
    row.streamStatus.setPhase('thinking');
  } else if (phase === 'loading_model') {
    row.streamStatus.setPhase('loading_model');
  } else if (phase === 'generating') {
    row.streamStatus.setPhase('generating');
  }
}
