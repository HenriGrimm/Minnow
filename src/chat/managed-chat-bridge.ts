import { StreamEventSource } from '../api/stream-event-source';
import { isCurrentWindowWorkspace, subscribeWorkspace } from '../state/workspace';
import { applySharedChatAttention, applySharedChatFrame, findChatById, getActiveChat, refreshSessionsFromServer, sessionState } from '../state/sessions';
import { hasUnsettledAgentWork } from '../state/chat-relationships';
import { setRemoteChatRunning } from './remote-turn-state';
import { getManagedChatView, notifyManagedChatMetadata, subscribeManagedChatView } from './managed-chat-view';
import type { SharedChatFrame } from './shared-chat-protocol';

/** One project summary stream, with full live output for the mounted chat only. */
export function startManagedChatBridge(observer: { receive(frame: SharedChatFrame): Promise<void>; reconnect(): void }, onChange: (activeChanged: boolean) => void,
  options: { createSource?: (url: string) => Pick<StreamEventSource, 'onopen' | 'onmessage' | 'close'> } = {}): () => void {
  let source: Pick<StreamEventSource, 'onopen' | 'onmessage' | 'close'> | undefined, watched = '', disposed = false;
  let reconciliation: AbortController | undefined;
  const awaitingBaseline = new Set<string>();
  const pending = new Map<string, Promise<void>>();
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
  async function notice(message: any, baseline = false, isCurrent = () => !disposed): Promise<void> {
    if (!message.chatId) return;
    if (!findChatById(message.chatId) && message.fields?.chatCommandVersion !== 1) await refreshSessionsFromServer();
    if (!isCurrent()) return;
    if (message.fields) {
      const attentionOnly = Object.keys(message.fields).every(key => key === 'agentRequestSummary');
      if (attentionOnly) applySharedChatAttention(message.chatId, message.fields);
      else {
        const isNewShell = !findChatById(message.chatId);
        const chat = applySharedChatFrame(message.chatId, message.fields);
        if (chat && isNewShell) chat.historyLoaded = false;
      }
    }
    if (message.fields) notifyManagedChatMetadata(message.chatId, { baseline });
    if (message.fields && Object.hasOwn(message.fields, 'agentExecution')) {
      setRemoteChatRunning(message.chatId, ['running', 'loading_model'].includes(message.fields.agentExecution?.status));
    }
    onChange(getActiveChat()?.id === message.chatId);
  }
  // A full frame can be hydrating history when the chat becomes a background summary.
  function receive(message: { chatId?: string; fields?: Record<string, unknown>; frame?: SharedChatFrame; baseline?: boolean }, isCurrent = () => !disposed): void {
    const { frame, baseline } = message;
    const chatId = frame?.chatId ?? message.chatId;
    if (!chatId) return;
    if (Object.hasOwn(frame?.fields ?? message.fields ?? {}, 'agentExecution')) awaitingBaseline.delete(chatId);
    const apply = async () => {
      if (!isCurrent()) return;
      if (frame) await observeFrame(frame, baseline);
      else await notice(message, baseline, isCurrent);
    };
    const previous = pending.get(chatId);
    const work = (previous ? previous.then(apply) : apply()).catch(() => {});
    pending.set(chatId, work);
    void work.then(() => { if (pending.get(chatId) === work) pending.delete(chatId); });
  }
  // The project stream replays active chats. Reconcile children that may have finished offline.
  async function reconcileBackground(signal: AbortSignal): Promise<void> {
    for (const chatId of awaitingBaseline) {
      if (signal.aborted) return;
      try {
        const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}?view=activity`, {
          cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        if (response.ok) {
          const snapshot = await response.json();
          if (!signal.aborted && awaitingBaseline.delete(chatId)) receive({ ...snapshot, baseline: true }, () => !signal.aborted);
        }
      } catch { /* The next project connection retries any missed completion. */ }
    }
  }
  function connect(force = false): void {
    if (disposed) return;
    const candidate = getManagedChatView() || getActiveChat()?.id || '';
    // Ordinary roots also receive summaries; watching them permits the first
    // managed delivery to hydrate in place after a legacy turn has drained.
    if (!force && source && watched === candidate) return;
    watched = candidate; source?.close(); reconciliation?.abort();
    const url = `/api/chats/events${watched ? `?chatId=${encodeURIComponent(watched)}` : ''}`;
    source = options.createSource?.(url) ?? new StreamEventSource(url);
    const connected = source;
    source.onopen = () => {
      if (disposed || source !== connected) return;
      reconciliation?.abort(); reconciliation = new AbortController();
      awaitingBaseline.clear();
      for (const chat of sessionState?.chats ?? []) {
        if (chat.id !== watched && chat.chatCommandVersion === 1 && isCurrentWindowWorkspace(chat.workspacePath ?? '') && hasUnsettledAgentWork(chat)) awaitingBaseline.add(chat.id);
      }
      observer.reconnect();
      window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-reconnected'));
    };
    source.onmessage = event => {
      if (disposed || source !== connected) return;
      try {
        const message = JSON.parse(event.data);
        if (message.kind === 'baseline-end' && reconciliation) void reconcileBackground(reconciliation.signal);
        else if (message.kind === 'frame' || message.kind === 'chat-changed') receive(message, () => !disposed && source === connected);
      } catch { /* A complete snapshot follows reconnect. */ }
    };
  }
  const accepted = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail) receive(detail);
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
  return () => { disposed = true; reconciliation?.abort(); source?.close(); unwatch(); unworkspace(); window.removeEventListener('minnow:managed-chat-change', accepted); window.removeEventListener('minnow:managed-chat-deleted', stopRemote); };
}
