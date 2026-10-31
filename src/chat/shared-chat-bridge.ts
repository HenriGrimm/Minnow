import { StreamEventSource } from '../api/stream-event-source';
import { hasHostSessionToken, isPairedDevice } from '../api/session-token';
import { isServerStorageMode } from '../config/storage-mode';
import { getChatHostId, receiveRemoteCommandResult, type RemoteChatCommand } from './remote-chat-client';
import { setSharedChatPublisher } from './shared-chat-events';
import { setRemoteChatRunning, setRemoteChatTurns } from './remote-turn-state';
import { subscribeWorkspace } from '../state/workspace';
import {
  applySharedChatFrame, ensureChatHistoryLoaded, findChatById, getActiveChat,
  persistSessionsBeforeDeliveryAck, refreshSessionsFromServer, scheduleSaveSessions, touchChat,
  renameChatTitle,
} from '../state/sessions';
import { streamingChatIds } from '../app-state';
import { isChatTurnSetupPending } from './chat-turn-guard';
import { readChatStreamText } from './streaming-state';
import { getMainTurnActivity, subscribeMainTurnActivity } from './main-turn-activity';
import { appendStreamingAssistantRow, revealAssistantProseBubble } from '../ui/messages';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { ThoughtBubbleController } from '../ui/thought-bubbles';
import { registerStreamDomRemount, type StreamDomHandles } from '../tools/stream-chat-dom';
import { isStreamDomVisible } from './streaming-state';
import { scrollChatIfPinned } from '../ui/chat-scroll';
import { syncComposerFromStreamingState } from '../ui/composer-send';
import { enqueueComposerMessage, pushQueuedMessageNow, removeQueuedMessage, updateQueuedMessage } from './message-queue';
import { clearPendingSteer, enqueueSteerMessage } from './steer-message';
import { stopGeneration } from './stop-generation';
import { setChatPinned } from '../state/chat-groups';
import { setChatArchived } from '../state/chat-archive';
import type { Chat } from '../types';
import type { SharedChatFrame } from './shared-chat-protocol';
import type { TurnEvent } from '../../server/runner/run-turn';
import type { SendProgrammaticChatTextOptions } from './messaging';
import { randomUUID } from '../lib/random-id';
import { getChatTranscript } from '../config/api-client';
import { startManagedChatBridge } from './managed-chat-bridge';
import { startManagedChatRequests } from '../ui/managed-chat-requests';
import { startChatHostCapabilities } from './host-capabilities';
import { getChatTurnOwnerId } from './turn-ownership';
import { createChatPublicationBatch, serializeChatPublicationBatches, type ChatPublicationResult } from './shared-chat-batch';
import { chatMutationVersion } from '../state/chat-mutation-version';

const FIELD_KEYS = ['name', 'workspacePath', 'modelId', 'providerId', 'modeId', 'updatedAt',
  'currentGenerationId', 'lastStats', 'modelInfo', 'turnError', 'unread', 'pinnedAt', 'archivedAt', 'pendingMessageQueue',
  'pendingSteerMessage', 'reasoningEffort', 'worktreeRoot', 'worktreeEnabled', 'worktreeSetupRequired',
  'worktreeSetupError', 'subAgentAutoResumeBlocked', 'activeGoal', 'activeLoops', 'remoteCommandReceipts'] as const;

function sharedFields(chat: Chat): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of FIELD_KEYS) fields[key] = chat[key as keyof Chat] ?? null;
  fields.runs = (chat.runs ?? []).map(({ snapshot: _snapshot, outputMessages: _output, generationIds: _ids, ...run }) => run);
  return fields;
}

async function post(path: string, body: unknown): Promise<void> {
  await postSerialized(path, JSON.stringify(body));
}

async function postSerialized(path: string, body: string): Promise<Response> {
  const response = await fetch(`/api/chat-sync/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Chat connection failed (${response.status})`);
  return response;
}

interface Publication {
  epoch: string;
  base: number;
  messages: string[];
  fields: string;
  liveState?: SharedChatFrame['live'];
  historyCache?: { history: Chat['history']; base: number; revision: number; values: string[] };
  roundOpen: boolean;
  running: boolean;
  sentRunning?: boolean;
  pending?: Promise<void>;
  dirty?: boolean;
}

/** Coalesce tokens for the wire; transcript changes are absolute indexed patches. */
export function createSharedChatPublisher(send: (frame: Omit<SharedChatFrame, 'hostId' | 'sequence'>) => Promise<void>) {
  const publications = new Map<string, Publication>();
  const queued = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const schedule = (chatId: string) => {
    if (disposed) return;
    queued.add(chatId);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const ids = [...queued]; queued.clear();
      for (const id of ids) void publish(id).catch(() => {});
    }, 40);
  };
  const publish = async (chatId: string): Promise<void> => {
    const state = publications.get(chatId);
    const chat = findChatById(chatId);
    if (!state || !chat || chat.historyLoaded === false) return;
    if (state.pending) { state.dirty = true; return state.pending; }
    const task = (async () => {
      if (state.base > chat.history.length) { state.base = 0; state.messages = []; }
      const suffix = chat.history.slice(state.base);
      const cache = state.historyCache;
      const revision = chatMutationVersion(chat);
      const serialized = cache?.history === chat.history && cache.base === state.base &&
        cache.revision === revision && cache.values.length === suffix.length
        ? cache.values : suffix.map(message => JSON.stringify(message));
      state.historyCache = { history: chat.history, base: state.base, revision, values: serialized };
      let changed = 0;
      while (changed < serialized.length && serialized[changed] === state.messages[changed]) changed++;
      const historyChanged = changed !== serialized.length || serialized.length !== state.messages.length;
      const fields = sharedFields(chat);
      const fieldsJson = JSON.stringify(fields);
      const activity = getMainTurnActivity(chatId);
      const text = state.running && state.roundOpen ? readChatStreamText(chatId) : null;
      const live = text ? { ...text, phase: activity?.phase, currentTool: activity?.currentTool } : null;
      const before = state.liveState;
      const sameLive = live === before || Boolean(live && before && live.phase === before.phase &&
        live.currentTool === before.currentTool && live.toolCallCount === before.toolCallCount &&
        live.lastDelta === before.lastDelta && live.lastThinking === before.lastThinking);
      if (!historyChanged && fieldsJson === state.fields && sameLive && state.sentRunning === state.running) return;
      const frame: Omit<SharedChatFrame, 'hostId' | 'sequence'> = { chatId, epoch: state.epoch, running: state.running };
      if (historyChanged || !state.fields) frame.history = {
        start: state.base + changed, messages: suffix.slice(changed), length: chat.history.length,
      };
      if (fieldsJson !== state.fields) frame.fields = fields;
      if (!sameLive || !state.running) {
        if (live && before && live.phase === before.phase && live.currentTool === before.currentTool &&
            live.toolCallCount === before.toolCallCount && live.lastDelta.startsWith(before.lastDelta) &&
            live.lastThinking.startsWith(before.lastThinking)) {
          frame.liveAppend = { textOffset: before.lastDelta.length, thinkingOffset: before.lastThinking.length,
            text: live.lastDelta.slice(before.lastDelta.length), thinking: live.lastThinking.slice(before.lastThinking.length) };
        } else frame.live = live;
      }
      try {
        await send(frame);
        state.messages = serialized;
        state.fields = fieldsJson;
        state.liveState = live;
        state.sentRunning = frame.running;
      } catch (error) {
        // The server may have missed this patch; the next publication supplies
        // the complete current-turn suffix instead of extending a missing row.
        state.messages = []; state.fields = ''; state.liveState = undefined; state.historyCache = undefined;
        throw error;
      }
    })();
    state.pending = task;
    try { await task; } finally {
      if (state.pending === task) state.pending = undefined;
      if (!state.running) state.historyCache = undefined;
      if (state.dirty) {
        state.dirty = false;
        schedule(chatId);
      }
    }
  };
  return {
    async update(chatId: string, event?: TurnEvent, running?: boolean): Promise<void> {
      const chat = findChatById(chatId);
      if (!chat || disposed) return;
      let state = publications.get(chatId);
      if (!state || running === true && !state.running) {
        if (publications.size >= 64) {
          const idle = [...publications].find(([, row]) => !row.running && !row.pending);
          if (idle) { queued.delete(idle[0]); publications.delete(idle[0]); }
        }
        state = { epoch: randomUUID(), base: Math.max(0, chat.history.length - 1), messages: [], fields: '', roundOpen: false, running: true };
        publications.set(chatId, state);
      }
      if (event?.type === 'round_start') state.roundOpen = true;
      if (event?.type === 'round_end') state.roundOpen = false;
      if (running !== undefined || event && event.type !== 'delta' && event.type !== 'thinking') state.historyCache = undefined;
      if (running !== undefined) state.running = running;
      if (running !== undefined) {
        queued.delete(chatId);
        await state.pending?.catch(() => {});
        await publish(chatId); return;
      }
      schedule(chatId);
    },
    reset() {
      for (const state of publications.values()) { state.messages = []; state.fields = ''; state.liveState = undefined; state.historyCache = undefined; state.sentRunning = undefined; }
    },
    async replay() { await Promise.all([...publications.keys()].map(id => publish(id).catch(() => {}))); },
    dispose() { disposed = true; clearTimeout(timer); queued.clear(); publications.clear(); },
  };
}

interface Observation { frame: SharedChatFrame; row?: StreamDomHandles; thoughts?: ThoughtBubbleController; thinking: string }

/** Render live output without executing tools or adding anything to persisted history. */
export function createSharedChatObserver(onChange: (activeChanged: boolean) => void) {
  const observed = new Map<string, Observation>();
  const chains = new Map<string, Promise<void>>();
  function paint(state: Observation): void {
    const frame = state.frame;
    if (!isStreamDomVisible(frame.chatId)) return;
    if (!frame.running || !frame.live) {
      state.thoughts?.abort(); state.thoughts = undefined; state.thinking = '';
      state.row?.streamStatus.dispose(); state.row?.wrap.remove(); state.row = undefined;
      return;
    }
    if (!state.row?.wrap.isConnected) {
      state.row = appendStreamingAssistantRow(frame.chatId);
      state.thoughts?.abort();
      state.thoughts = new ThoughtBubbleController(state.row.wrap);
      state.thinking = '';
    }
    const { lastDelta, lastThinking, phase, currentTool } = frame.live;
    if (!lastThinking.startsWith(state.thinking)) {
      state.thoughts?.resetFailedResponse(); state.thinking = '';
    }
    state.thoughts?.appendReasoningDelta(lastThinking.slice(state.thinking.length));
    state.thinking = lastThinking;
    if (lastDelta) {
      revealAssistantProseBubble(state.row.wrap, state.row.bubble, state.row.streamStatus);
      setAssistantBubbleContent(state.row.bubble, lastDelta, { streaming: true });
    }
    if (!lastDelta) state.row.streamStatus.setPhase(phase === 'thinking' ? 'thinking' : phase === 'loading_model' ? 'loading_model' : 'generating');
    state.row.streamStatus.setRuntimeDetail(currentTool ? `Running ${currentTool}` : null);
    scrollChatIfPinned();
  }
  async function apply(frame: SharedChatFrame): Promise<void> {
    if (frame.hostId === getChatHostId() && !isPairedDevice()) return;
    const existing = observed.get(frame.chatId);
    if (existing && existing.frame.sequence >= frame.sequence) return;
    if (!findChatById(frame.chatId)) await refreshSessionsFromServer();
    let chat = findChatById(frame.chatId);
    if (!chat && frame.fields) {
      chat = applySharedChatFrame(frame.chatId, frame.fields);
      if (chat) chat.historyLoaded = false;
    }
    if (!chat) throw new Error('Chat transcript has not arrived yet.');
    if (chat?.historyLoaded === false) await ensureChatHistoryLoaded(chat.id);
    if (frame.history && frame.history.start > chat.history.length) {
      const { history } = await getChatTranscript(chat.id);
      applySharedChatFrame(chat.id, undefined, { start: 0, messages: history, length: history.length });
    }
    const next = { ...existing?.frame, ...frame };
    if (frame.liveAppend) {
      const before = existing?.frame.live;
      const append = frame.liveAppend;
      if (!before || before.lastDelta.length !== append.textOffset || before.lastThinking.length !== append.thinkingOffset) {
        throw new Error('Live output needs a fresh snapshot.');
      }
      next.live = { ...before, lastDelta: before.lastDelta + append.text, lastThinking: before.lastThinking + append.thinking };
    }
    const state = existing ?? { frame: next, thinking: '' };
    const wasRunning = streamingChatIds.has(frame.chatId);
    if (wasRunning) return;
    setRemoteChatRunning(frame.chatId, frame.running);
    const applied = applySharedChatFrame(frame.chatId, frame.fields, frame.history);
    if (!applied) throw new Error('Transcript prefix has not arrived yet.');
    state.frame = next;
    observed.set(frame.chatId, state);
    registerStreamDomRemount(frame.chatId, frame.running ? row => {
      state.row = row; state.thoughts?.abort(); state.thoughts = new ThoughtBubbleController(row.wrap); state.thinking = ''; paint(state);
    } : null);
    if (frame.fields || frame.history) onChange(getActiveChat().id === frame.chatId);
    paint(state);
    syncComposerFromStreamingState();
    if (!frame.running) { state.frame.history = undefined; state.frame.fields = undefined; }
  }
  return {
    receive(frame: SharedChatFrame): Promise<void> {
      const pending = (chains.get(frame.chatId) ?? Promise.resolve()).catch(() => {}).then(() => apply(frame));
      chains.set(frame.chatId, pending);
      return pending;
    },
    reconnect() { for (const state of observed.values()) state.frame.sequence = -1; },
    dispose() {
      for (const [id, state] of observed) {
        state.thoughts?.abort(); state.row?.streamStatus.dispose(); state.row?.wrap.remove(); registerStreamDomRemount(id, null);
      }
      observed.clear();
    },
  };
}

/** Admit remote actions on the existing PC engine; no active-chat navigation. */
export function createHostChatCommandHandler(publish: (chatId: string, running: boolean) => Promise<void>, dependencies: {
  persist?: () => Promise<boolean>;
  send?: (chat: Chat, text: string, options: SendProgrammaticChatTextOptions) => Promise<void>;
} = {}) {
  const persist = dependencies.persist ?? persistSessionsBeforeDeliveryAck;
  const admissions = new Map<string, Promise<void>>();
  const handled = new Map<string, Promise<void>>();
  const starting = new Map<string, AbortController>();
  async function execute(command: RemoteChatCommand): Promise<void> {
    let chat = findChatById(command.chatId);
    if (!chat) {
      await persist();
      await refreshSessionsFromServer();
      chat = findChatById(command.chatId);
    }
    if (!chat) throw new Error('Chat is no longer available on the computer.');
    await ensureChatHistoryLoaded(chat.id);
    const receipt = command.deliveryId ?? command.id;
    if (chat.remoteCommandReceipts?.includes(receipt)) return;
    const remember = async () => {
      chat!.remoteCommandReceipts = [...(chat!.remoteCommandReceipts ?? []), receipt].slice(-256);
      touchChat(chat!); scheduleSaveSessions();
      if (!await persist()) throw new Error('The computer could not save this message.');
      await publish(chat!.id, streamingChatIds.has(chat!.id) || isChatTurnSetupPending(chat!.id));
    };
    const busy = streamingChatIds.has(chat.id) || isChatTurnSetupPending(chat.id);
    if (command.action === 'configure') {
      const patch = command.patch ?? {};
      if (typeof patch.name === 'string') renameChatTitle(chat.id, patch.name);
      if (typeof patch.pinned === 'boolean') setChatPinned(chat, patch.pinned);
      if (typeof patch.archived === 'boolean') setChatArchived(chat, patch.archived);
      if (typeof patch.modelSelectValue === 'string') {
        const { onActiveChatModelChange } = await import('../ui/chat-model-ui');
        onActiveChatModelChange(patch.modelSelectValue, chat);
      }
      if (typeof patch.modeId === 'string') {
        if (!['general', 'build', 'plan', 'debug'].includes(patch.modeId)) throw new Error('Invalid chat mode.');
        const { setChatMode } = await import('../ui/mode-selector');
        const result = setChatMode(patch.modeId as 'general' | 'build' | 'plan' | 'debug', chat);
        if (!result.ok) throw new Error(result.error);
      }
      await remember(); return;
    }
    if (command.action === 'stop') {
      if (command.expectedOwnerId && getChatTurnOwnerId(chat.id) !== command.expectedOwnerId) return;
      starting.get(chat.id)?.abort(); stopGeneration(chat.id, 'user', { ownedByThisView: true, serverControl: Boolean(command.expectedOwnerId) }); await remember(); return;
    }
    if (command.action === 'push') {
      if (!pushQueuedMessageNow(chat, command.itemId ?? '')) throw new Error('Queued message is no longer available.');
      await remember(); return;
    }
    if (command.action === 'remove') {
      if (!removeQueuedMessage(chat, command.itemId ?? '')) throw new Error('Queued message is no longer available.');
      await remember(); return;
    }
    if (command.action === 'cancel-steer') {
      clearPendingSteer(chat);
      await remember(); return;
    }
    if (command.action === 'edit') {
      if (!updateQueuedMessage(chat, command.itemId ?? '', command.text ?? '')) throw new Error('Queued message is no longer available.');
      await remember(); return;
    }
    if (busy) {
      if (command.attachments?.length) throw new Error('Follow-ups are text only while this reply is running.');
      const accepted = command.action === 'steer' ? enqueueSteerMessage(chat, command.text ?? '') : enqueueComposerMessage(chat, command.text ?? '');
      if (!accepted) throw new Error('Add a message.');
      await remember(); return;
    }
    const controller = new AbortController();
    starting.set(chat.id, controller);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const accepted = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const sendProgrammaticChatText = dependencies.send ?? (await import('./messaging')).sendProgrammaticChatText;
    void sendProgrammaticChatText(chat, command.text ?? '', {
      validAttachments: command.attachments ?? [], clearComposerOnSend: false, signal: controller.signal,
      onUserMessageAccepted: async () => { await remember(); resolve(); },
      reportStatus: (_level, message) => reject(new Error(message)),
    }).then(() => reject(new Error('The message was not started.'))).catch(reject).finally(() => {
      if (starting.get(chat!.id) === controller) starting.delete(chat!.id);
    });
    await accepted;
  }
  return (command: RemoteChatCommand): Promise<void> => {
    const receipt = command.deliveryId ?? command.id;
    const existing = handled.get(receipt);
    if (existing) return existing;
    // Stop bypasses the admission queue so it can interrupt model/worktree setup.
    const prior = command.action === 'stop' ? Promise.resolve() : admissions.get(command.chatId) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(() => execute(command));
    if (command.action !== 'stop') admissions.set(command.chatId, task);
    handled.set(receipt, task);
    if (handled.size > 512) handled.delete(handled.keys().next().value!);
    return task;
  };
}

/** Attach authenticated streams to the shared WebSocket transport. */
export function startSharedChatBridge(onChange: (activeChanged: boolean) => void): () => void {
  if (!isServerStorageMode()) return () => {};
  const hostId = getChatHostId();
  const sendPublication = createChatPublicationBatch(async frames => {
    const results: ChatPublicationResult[] = [];
    for (const { body, count } of serializeChatPublicationBatches(hostId, frames)) {
      const response = await postSerialized('publish', body);
      const data = await response.json() as { results?: ChatPublicationResult[] };
      if (!Array.isArray(data.results) || data.results.length !== count) throw new Error('Invalid chat publication acknowledgement.');
      results.push(...data.results);
    }
    return results;
  });
  const publisher = createSharedChatPublisher(sendPublication);
  const observer = createSharedChatObserver(onChange);
  const disposeManagedBridge = startManagedChatBridge(observer, onChange);
  const disposeManagedRequests = startManagedChatRequests();
  const disposeHostCapabilities = hasHostSessionToken() ? startChatHostCapabilities() : () => {};
  const handle = createHostChatCommandHandler((id, running) => publisher.update(id, undefined, running));
  let events: StreamEventSource | undefined;
  let host: StreamEventSource | undefined;
  const connect = () => {
    events?.close(); host?.close();
    events = new StreamEventSource('/api/chat-sync/events');
    events.onopen = () => observer.reconnect();
    events.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.kind === 'frame') void observer.receive(message.frame).catch(async () => {
          // A wake or a history hydration race can miss a prefix. Recover from
          // the coalesced snapshot, never by replaying the model/tool runner.
          try {
            const response = await fetch(`/api/chat-sync/snapshot?chatId=${encodeURIComponent(message.frame.chatId)}`,
              { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
            if (response.ok) await observer.receive(await response.json());
          } catch {}
        });
        if (message.kind === 'command-result') receiveRemoteCommandResult(message.id, message);
        if (message.kind === 'presence' && setRemoteChatTurns(message.turns
          .filter((turn: { hostId?: string }) => isPairedDevice() || turn.hostId !== hostId)
          .map((turn: { chatId: string }) => turn.chatId))) onChange(true);
      } catch { /* Reconnect will provide a complete current-turn snapshot. */ }
    };
    if (hasHostSessionToken()) {
      host = new StreamEventSource(`/api/chat-sync/host?hostId=${encodeURIComponent(hostId)}`);
      host.onopen = () => {
        publisher.reset();
        void publisher.replay();
        for (const id of streamingChatIds) void publisher.update(id, undefined, true).catch(() => {});
      };
      host.onmessage = event => {
        try {
          const { command } = JSON.parse(event.data);
          if (!command) return;
          void handle(command).then(() => post('ack', { id: command.deliveryId, hostId, ok: true }),
            error => post('ack', { id: command.deliveryId, hostId, ok: false, error: String(error?.message || error) })).catch(() => {});
        } catch {}
      };
    }
  };
  setSharedChatPublisher(hasHostSessionToken() ? publisher.update : undefined);
  const unsubscribeStatus = subscribeMainTurnActivity(() => {
    for (const id of streamingChatIds) if (hasHostSessionToken()) void publisher.update(id).catch(() => {});
  });
  const unsubscribeWorkspace = subscribeWorkspace(connect);
  const wake = () => {
    if (isPairedDevice() && document.visibilityState !== 'hidden') connect();
  };
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
  document.addEventListener('visibilitychange', wake);
  connect();
  return () => {
    disposeManagedBridge(); disposeManagedRequests(); disposeHostCapabilities();
    events?.close(); host?.close(); unsubscribeStatus(); unsubscribeWorkspace();
    setSharedChatPublisher(undefined); publisher.dispose(); observer.dispose();
    window.removeEventListener('online', wake);
    window.removeEventListener('pageshow', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}
