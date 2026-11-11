import { StreamEventSource } from '../api/stream-event-source';
import { isCurrentWindowWorkspace, subscribeWorkspace } from '../state/workspace';
import { applySharedChatAttention, applySharedChatFrame, findChatById, getActiveChat, refreshSessionsFromServer, sessionState } from '../state/sessions';
import { hasUnsettledAgentWork } from '../state/chat-relationships';
import { setRemoteChatRunning } from './remote-turn-state';
import { getEmbeddedManagedChatView, getManagedChatView, notifyManagedChatMetadata, subscribeEmbeddedManagedChatView, subscribeManagedChatView } from './managed-chat-view';
import type { SharedChatFrame } from './shared-chat-protocol';

/** Project summaries plus full live output for mounted transcripts. */
export function startManagedChatBridge(observer: { receive(frame: SharedChatFrame): Promise<void>; reconnect(): void }, onChange: (activeChanged: boolean) => void,
  options: { createSource?: (url: string) => Pick<StreamEventSource, 'onopen' | 'onmessage' | 'close'> } = {}): () => void {
  let source: Pick<StreamEventSource, 'onopen' | 'onmessage' | 'close'> | undefined, watched = '', disposed = false;
  let reconciliation: AbortController | undefined;
  let connection = new AbortController();
  let connectionVersion = 0;
  const awaitingBaseline = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  let embeddedSource: Pick<StreamEventSource, 'onopen' | 'onmessage' | 'close'> | undefined;
  let embeddedId = '';
  function metadataChanged(chatId: string, baseline?: boolean): void {
    notifyManagedChatMetadata(chatId, { baseline });
    const chat = findChatById(chatId);
    if (chat?.agentTitleCandidate && chat.agentExecution?.status === 'completed') {
      void import('./titles/schedule').then(module => { if (!disposed) module.scheduleManagedChatTitleGeneration(chatId); }).catch(() => {});
    }
  }
  function canonicalFields(chatId: string, fields?: Record<string, unknown>): Record<string, unknown> | null | undefined {
    if (!fields || findChatById(chatId)?.chatCommandVersion !== 1 || !Object.hasOwn(fields, 'chatCommandVersion') || fields.chatCommandVersion === 1) return fields;
    // An old raw notice/receipt can arrive after local promotion. Ownership is
    // monotonic; rollback must never turn this view back into a transcript writer.
    return null;
  }
  const observeFrame = (frame: SharedChatFrame, baseline: boolean | undefined, isCurrent: () => boolean) => observer.receive(frame).then(() => { if (isCurrent() && frame.fields) metadataChanged(frame.chatId, baseline); }).catch(async () => {
    if (!isCurrent()) return;
    const signal = connection.signal;
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(frame.chatId)}`, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      if (response.ok) {
        const raw = (await response.json()).frame;
        if (!isCurrent() || signal.aborted) return;
        const fields = raw && canonicalFields(raw.chatId, raw.fields);
        if (fields === null) return;
        const restored = raw && { ...raw, fields };
        await observer.receive(restored);
        if (isCurrent() && restored?.fields) metadataChanged(restored.chatId, true);
      }
    } catch { /* Reconnection hydrates the authoritative prefix. */ }
  });
  async function notice(message: any, baseline = false, isCurrent = () => !disposed): Promise<void> {
    if (!message.chatId) return;
    if (!findChatById(message.chatId) && message.fields?.chatCommandVersion !== 1) await refreshSessionsFromServer();
    if (!isCurrent()) return;
    const fields = canonicalFields(message.chatId, message.fields);
    if (fields === null) return;
    if (message.fields) {
      const attentionOnly = Object.keys(message.fields).every(key => key === 'agentRequestSummary');
      if (attentionOnly) applySharedChatAttention(message.chatId, message.fields);
      else {
        const isNewShell = !findChatById(message.chatId);
        const chat = applySharedChatFrame(message.chatId, fields);
        if (chat && isNewShell) chat.historyLoaded = false;
      }
    }
    if (message.fields && Object.hasOwn(message.fields, 'agentExecution')) {
      setRemoteChatRunning(message.chatId, ['running', 'loading_model'].includes(message.fields.agentExecution?.status), 'managed');
    }
    if (message.fields) metadataChanged(message.chatId, baseline);
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
      const fields = canonicalFields(chatId, frame?.fields ?? message.fields);
      if (fields === null) return;
      if (frame) await observeFrame({ ...frame, fields }, baseline, isCurrent);
      else await notice(message, baseline, isCurrent);
      // Admission or a project notice can promote the already-mounted chat.
      // Subscribe to its full output once the canonical shell has arrived.
      if (isCurrent()) connect();
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
    const mounted = getManagedChatView() || getActiveChat()?.id || '';
    // A new renderer chat may not exist on the server yet. Watching its id
    // would permanently close EventSource on 404 before its first send.
    // Project summaries and admission receipts upgrade this subscription.
    const candidate = findChatById(mounted)?.chatCommandVersion === 1 ? mounted : '';
    connectEmbedded(candidate, force);
    if (!force && source && watched === candidate) return;
    watched = candidate; source?.close(); reconciliation?.abort(); connection.abort(); connection = new AbortController();
    const url = `/api/chats/events${watched ? `?chatId=${encodeURIComponent(watched)}` : ''}`;
    source = options.createSource?.(url) ?? new StreamEventSource(url);
    const connected = source;
    source.onopen = () => {
      if (disposed || source !== connected) return;
      connectionVersion++; connection.abort(); connection = new AbortController();
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
        else if (message.kind === 'frame' || message.kind === 'chat-changed') {
          const version = connectionVersion;
          receive(message, () => !disposed && source === connected && version === connectionVersion);
        }
      } catch { /* A complete snapshot follows reconnect. */ }
    };
  }
  // The Agents panel can inspect one child while the main thread stays mounted.
  function connectEmbedded(primary: string, force = false): void {
    const id = getEmbeddedManagedChatView();
    const candidate = id !== primary && findChatById(id)?.chatCommandVersion === 1 ? id : '';
    if (!force && candidate === embeddedId) return;
    embeddedId = candidate;
    embeddedSource?.close();
    embeddedSource = undefined;
    if (!candidate) return;
    const url = `/api/chats/events?chatId=${encodeURIComponent(candidate)}`;
    const connected = options.createSource?.(url) ?? new StreamEventSource(url);
    embeddedSource = connected;
    connected.onmessage = event => {
      if (disposed || embeddedSource !== connected) return;
      try {
        const message = JSON.parse(event.data);
        if (message.kind === 'frame' && message.frame?.chatId === candidate) {
          receive(message, () => !disposed && embeddedSource === connected);
        }
      } catch { /* The next snapshot restores the transcript. */ }
    };
  }
  const accepted = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail) receive(detail);
  };
  const stopRemote = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail?.chatId) setRemoteChatRunning(detail.chatId, false, 'managed');
  };
  const unwatch = subscribeManagedChatView(() => connect());
  const unwatchEmbedded = subscribeEmbeddedManagedChatView(() => connect());
  const unworkspace = subscribeWorkspace(() => connect(true));
  window.addEventListener('minnow:managed-chat-change', accepted);
  window.addEventListener('minnow:managed-chat-deleted', stopRemote);
  connect();
  return () => { disposed = true; reconciliation?.abort(); connection.abort(); source?.close(); embeddedSource?.close(); unwatch(); unwatchEmbedded(); unworkspace(); window.removeEventListener('minnow:managed-chat-change', accepted); window.removeEventListener('minnow:managed-chat-deleted', stopRemote); };
}
