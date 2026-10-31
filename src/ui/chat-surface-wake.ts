import { subscribeRenderIdle } from '../boot/render-idle';
import { isChatStreaming, isStreamDomVisible } from '../chat/streaming-state';
import { getActiveChat, sessionState } from '../state/sessions';
import { getActiveChatMountElement } from './chat-mount';
import { hasCurrentChatSurface } from './chat-surface-state';
import { remountStreamDomForChat } from '../tools/stream-chat-dom';

/** Catch up on hidden-window completions without rebuilding an unchanged idle transcript. */
export function startChatSurfaceWake(repaint: () => void): () => void {
  return subscribeRenderIdle(idle => {
    if (idle || !sessionState) return;
    const chat = getActiveChat();
    if (chat.historyLoaded === false || !isStreamDomVisible(chat.id)) return;
    const mount = getActiveChatMountElement();
    if (!hasCurrentChatSurface(mount, chat)) repaint();
    else if (isChatStreaming(chat.id)) remountStreamDomForChat(chat.id);
  });
}
