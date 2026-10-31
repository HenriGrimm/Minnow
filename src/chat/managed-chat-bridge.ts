import { StreamEventSource } from '../api/stream-event-source';
import { subscribeWorkspace } from '../state/workspace';
import { applySharedChatAttention, applySharedChatFrame, findChatById, getActiveChat, refreshSessionsFromServer } from '../state/sessions';
import { setRemoteChatRunning } from './remote-turn-state';
import { getManagedChatView, notifyManagedChatMetadata, subscribeManagedChatView } from './managed-chat-view';
import type { SharedChatFrame } from './shared-chat-protocol';

/** One project summary stream, with full live output for the mounted chat only. */
export function startManagedChatBridge(observer: { receive(frame: SharedChatFrame): Promise<void>; reconnect(): void }, onChange: (activeChanged: boolean) => void,
  options: { createSource?: (url: string) => Pick<StreamEventSource, 'onopen' | 'onmessage' | 'close'> } = {}): () => void {
  let source: Pick<StreamEventSource, 'onopen' | 'onmessage' | 'close'> | undefined, watched = '', disposed = false;
  const observeFrame = (frame: SharedChatFrame, baseline = false) => observer.receive(frame).then(() => { if (!disposed && frame.fields) notifyManagedChatMetadata(frame.chatId, { baseline }); }).catch(async () => {
    if (disposed) return;
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(frame.chatId)}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        if (disposed) return;
        const restored = (await response.json()).frame;
        await observer.receive(restored);
        if (!disposed && restored?.fields) notifyManagedChatMetadata(restored.chatId, { baseline: true });
      }
    } catch { /* Reconnection hydrates the authoritative prefix. */ }
  });
  async function notice(message: any, baseline = false): Promise<void> {
    if (!message.chatId) return;
    if (!findChatById(message.chatId)) await refreshSessionsFromServer();
    if (disposed) return;
    if (message.fields) {
      const attentionOnly = Object.keys(message.fields).every(key => key === 'agentRequestSummary');
      if (attentionOnly) applySharedChatAttention(message.chatId, message.fields);
      else applySharedChatFrame(message.chatId, message.fields);
    }
    if (message.fields) notifyManagedChatMetadata(message.chatId, { baseline });
    if (message.fields && Object.hasOwn(message.fields, 'agentExecution')) {
      setRemoteChatRunning(message.chatId, ['running', 'loading_model'].includes(message.fields.agentExecution?.status));
    }
    onChange(getActiveChat()?.id === message.chatId);
  }
  function connect(force = false): void {
    if (disposed) return;
    const candidate = getManagedChatView() || getActiveChat()?.id || '';
    // Ordinary roots also receive summaries; watching them permits the first
    // managed delivery to hydrate in place after a legacy turn has drained.
    if (!force && source && watched === candidate) return;
    watched = candidate; source?.close();
    const url = `/api/chats/events${watched ? `?chatId=${encodeURIComponent(watched)}` : ''}`;
    source = options.createSource?.(url) ?? new StreamEventSource(url);
    source.onopen = () => {
      observer.reconnect();
      window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-reconnected'));
    };
    source.onmessage = event => {
      if (disposed) return;
      try {
        const message = JSON.parse(event.data);
        const baseline = message.baseline === true;
        if (message.kind === 'frame') void observeFrame(message.frame, baseline);
        else if (message.kind === 'chat-changed') void notice(message, baseline).catch(() => {});
      } catch { /* A complete snapshot follows reconnect. */ }
    };
  }
  const accepted = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail?.frame) void observeFrame(detail.frame);
    else if (detail?.chatId) void notice(detail).catch(() => {});
  };
  const stopRemote = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail?.chatId) setRemoteChatRunning(detail.chatId, false);
  };
  const unwatch = subscribeManagedChatView(() => connect());
  const unworkspace = subscribeWorkspace(() => connect(true));
  window.addEventListener('minnow:managed-chat-change', accepted);
  window.addEventListener('minnow:managed-chat-deleted', stopRemote);
  connect();
  return () => { disposed = true; source?.close(); unwatch(); unworkspace(); window.removeEventListener('minnow:managed-chat-change', accepted); window.removeEventListener('minnow:managed-chat-deleted', stopRemote); };
}
