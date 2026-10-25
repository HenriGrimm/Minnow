import type { Chat, Message } from '../types';
import type { TurnEvent } from '../../server/runner/run-turn';
import { createChatTurnEventPainter, type ChatTurnEventPainter } from './run-turn-chat-paint';
import { createChatStreamingRow, renderChatTranscriptHistory, type ChatTranscriptPresentation, type StreamingAssistantRow } from '../ui/messages';
import { ThoughtBubbleController } from '../ui/thought-bubbles';
import { renderToolInterruption } from '../ui/tool-messages';
import { cancelAssistantBubbleRenderDebounce } from '../markdown/renderer';

export interface ConversationSnapshot {
  history: Message[];
  completedRound: number;
  openEvents: TurnEvent[];
  isLive: boolean;
  pendingToolStatus?: 'paused' | 'stopped';
}

export interface ConversationView {
  sync: (snapshot: ConversationSnapshot) => void;
  onEvent: (event: TurnEvent, round?: number) => void;
  setPhase: (phase: 'thinking' | 'generating' | 'tools', toolName?: string) => void;
  dispose: () => void;
  flush: () => void;
}

/** Main-chat history and event painting inside an independently owned transcript. */
export function createConversationView(
  mount: HTMLElement,
  identity: Pick<Chat, 'id' | 'modeId'>,
  presentation: ChatTranscriptPresentation,
  scroll: () => void = () => {},
): ConversationView {
  let painter: ChatTurnEventPainter | null = null;
  let row: StreamingAssistantRow | null = null;
  let thoughts: ThoughtBubbleController | null = null;
  let completedRound = -1;
  let currentRound = 0;
  let messageIndex = 0;
  let historyKey: string | null = null;
  let live = false;
  let disposed = false;
  let pendingStatus: ConversationSnapshot['pendingToolStatus'];
  let baseline: ConversationSnapshot | null = null;
  const calls = new Set<string>();
  const results = new Map<string, string>();
  const roundResults = new Set<string>();
  let pendingEvents: { event: TurnEvent; round: number }[] = [];

  const releasePainter = () => {
    painter?.dispose();
    thoughts?.abort();
    if (row) cancelAssistantBubbleRenderDebounce(row.bubble);
    painter = null;
    row = null;
    thoughts = null;
  };

  const toolDisclosure = (wrap: HTMLElement, id: string) => {
    const details = wrap.querySelector<HTMLDetailsElement>('.tool-call-details');
    if (!details) return;
    details.open = presentation.isToolExpanded(id);
    if (details.dataset.conversationDisclosure === id) return;
    details.dataset.conversationDisclosure = id;
    details.addEventListener('toggle', () => presentation.onToolExpandedChange(id, details.open));
  };

  const ensurePainter = () => {
    if (painter) return painter;
    row = createChatStreamingRow(mount);
    row.wrap.dataset.historyIndex = String(messageIndex);
    const key = String(messageIndex);
    const options = { expanded: presentation.isThoughtExpanded(key),
      onExpandedChange: (expanded: boolean) => {
        options.expanded = expanded;
        presentation.onThoughtExpandedChange(key, expanded);
      } };
    thoughts = new ThoughtBubbleController(row.wrap, {}, options);
    const current = row;
    painter = createChatTurnEventPainter({
      ...current, mount, thoughtController: thoughts, isolated: true, finalizeAllRounds: true,
      thoughts: options, isDomVisible: () => !disposed,
      revealProse: () => {}, scrollTranscript: scroll, modeId: identity.modeId,
      onToolRendered: toolDisclosure,
    });
    return painter;
  };

  const syncPhase = (phase: 'thinking' | 'generating' | 'tools') => {
    const snapshot = painter?.snapshot();
    const hasContent = phase === 'thinking' ? snapshot?.lastThinking.trim() : snapshot?.lastDelta.trim();
    row?.streamStatus.setPhase(hasContent ? 'prose' : phase === 'tools' ? 'generating' : phase);
  };

  const apply = (event: TurnEvent, round = currentRound) => {
    if (disposed || !live || round <= completedRound) return;
    if (!['thinking', 'delta', 'tool_call', 'tool_result', 'tool_streaming', 'response_restart', 'phase', 'round_start', 'round_end', 'reasoning_end', 'loading_model'].includes(event.type)) return;
    currentRound = round;
    const active = ensurePainter();
    const snapshot = active.snapshot();
    if (event.type === 'thinking' && snapshot.lastThinking.startsWith(event.text)) return;
    if (event.type === 'delta' && snapshot.lastDelta.startsWith(event.text)) return;
    if (event.type === 'tool_call' && event.id) {
      if (calls.has(event.id)) return;
      calls.add(event.id);
    }
    if (event.type === 'tool_result' && event.id) {
      const key = JSON.stringify(event);
      if (results.get(event.id) === key) return;
      results.set(event.id, key);
      roundResults.add(event.id);
    }
    active.onEvent(event);
    if (event.type === 'phase') syncPhase(event.phase);
    if (event.type === 'loading_model') row?.streamStatus.setPhase('loading_model');
    if (event.type === 'round_end') {
      if (event.text.trim() || event.reasoning.trim() || snapshot.lastDelta.trim() || snapshot.lastThinking.trim() || event.toolCallCount > 0) {
        messageIndex += 1 + roundResults.size;
      }
      roundResults.clear();
      completedRound = round;
      currentRound = round + 1;
      releasePainter();
    }
  };

  return {
    sync(snapshot) {
      if (disposed) return;
      if (snapshot.completedRound < completedRound && baseline) {
        if (snapshot.isLive === live) return;
        snapshot = { ...baseline, isLive: snapshot.isLive, pendingToolStatus: snapshot.pendingToolStatus };
      } else baseline = snapshot;
      live = true;
      pendingStatus = snapshot.pendingToolStatus;
      const key = JSON.stringify([snapshot.history, snapshot.pendingToolStatus, snapshot.isLive]);
      if (key !== historyKey) {
        releasePainter();
        historyKey = key;
        completedRound = snapshot.completedRound;
        currentRound = completedRound + 1;
        messageIndex = snapshot.history.length;
        calls.clear(); results.clear(); roundResults.clear();
        renderChatTranscriptHistory(mount, snapshot.history, identity, { ...presentation, pendingToolStatus: pendingStatus });
        pendingEvents = pendingEvents.filter(item => item.round > completedRound);
        for (const event of snapshot.openEvents) apply(event);
        for (const item of pendingEvents) apply(item.event, item.round);
      } else {
        for (const event of snapshot.openEvents) apply(event);
      }
      painter?.flush();
      live = snapshot.isLive;
      if (!live) {
        if (painter) {
          const partial = painter.snapshot();
          painter.onEvent({ type: 'round_end', index: currentRound, text: partial.lastDelta, reasoning: partial.lastThinking,
            toolCallCount: 0, t0: 0, tFirst: null, tEnd: 0 });
        }
        releasePainter();
        for (const tool of mount.querySelectorAll<HTMLElement>('.tool-call-msg[aria-busy="true"]')) {
          renderToolInterruption(tool, pendingStatus ?? 'stopped');
        }
      }
    },
    onEvent(event, round = currentRound) {
      if (disposed || !live || round <= completedRound) return;
      const last = event.type === 'thinking' || event.type === 'delta'
        ? pendingEvents.find(item => item.round === round && item.event.type === event.type) : undefined;
      if (last) {
        last.event = event;
      } else pendingEvents.push({ event, round });
      apply(event, round);
    },
    setPhase(phase, toolName) {
      if (!live || disposed) return;
      if (phase === 'tools' && toolName) {
        const active = ensurePainter();
        active.onEvent({ type: 'tool_streaming', name: toolName });
      } else {
        ensurePainter();
        syncPhase(phase);
      }
    },
    dispose() {
      disposed = true;
      releasePainter();
      pendingEvents = [];
      baseline = null;
    },
    flush: () => painter?.flush(),
  };
}
