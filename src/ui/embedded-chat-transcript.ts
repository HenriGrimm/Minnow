import { createChatTurnEventPainter } from '../chat/run-turn-chat-paint';
import { getMainTurnActivity } from '../chat/main-turn-activity';
import { readChatStreamText } from '../chat/streaming-state';
import { chatMutationVersion } from '../state/chat-mutation-version';
import type { Chat } from '../types';
import { createChatStreamingRow, renderEmbeddedChatTranscript, type ChatTranscriptPresentation } from './messages';
import { attachToolStartIndicator } from './stream-status';
import { ThoughtBubbleController } from './thought-bubbles';

export interface EmbeddedChatLive {
  lastDelta?: string;
  lastThinking?: string;
  reasoningFormat?: 'summary';
  phase?: string | null;
  currentTool?: string | null;
}

export function readEmbeddedChatLive(chatId: string): EmbeddedChatLive {
  const text = readChatStreamText(chatId);
  const activity = getMainTurnActivity(chatId);
  return {
    ...text,
    phase: activity?.phase ?? text?.phase,
    currentTool: activity?.receivingToolArguments ? activity.currentTool : activity ? null : text?.currentTool,
  };
}

/** A read-only transcript that owns its scroll, disclosures and live painter. */
export function createEmbeddedChatTranscript(mount: HTMLElement, scroller: HTMLElement) {
  const disclosures = new Map<string, { work: Set<number>; presentation: ChatTranscriptPresentation }>();
  let historyView: ReturnType<typeof renderEmbeddedChatTranscript> | undefined;
  let painted: { chat: Chat; history: Chat['history']; count: number; revision: number; pending?: ChatTranscriptPresentation['pendingToolStatus'] } | undefined;
  let streaming = false;
  let liveRow: ReturnType<typeof mountLiveRow> | undefined;
  let pinned = true;
  const updatePinned = () => { pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32; };
  const scroll = () => { if (pinned) scroller.scrollTop = scroller.scrollHeight; };
  scroller.addEventListener('scroll', updatePinned, { passive: true });

  function disclosuresFor(chatId: string) {
    const existing = disclosures.get(chatId);
    if (existing) return existing;
    const thoughts = new Set<string>();
    const tools = new Set<string>();
    const presentation: ChatTranscriptPresentation = {
      isThoughtExpanded: key => thoughts.has(key),
      onThoughtExpandedChange: (key, open) => { if (open) thoughts.add(key); else thoughts.delete(key); },
      isToolExpanded: key => tools.has(key),
      onToolExpandedChange: (key, open) => { if (open) tools.add(key); else tools.delete(key); },
    };
    const entry = { work: new Set<number>(), presentation };
    disclosures.set(chatId, entry);
    return entry;
  }

  function mountLiveRow(chat: Chat, presentation: ChatTranscriptPresentation) {
    const row = createChatStreamingRow(mount);
    const key = String(chat.history.length);
    row.wrap.dataset.historyIndex = key;
    const options = {
      expanded: presentation.isThoughtExpanded(key),
      onExpandedChange: (open: boolean) => {
        options.expanded = open;
        presentation.onThoughtExpandedChange(key, open);
      },
    };
    const controller = new ThoughtBubbleController(row.wrap, {}, options);
    const painter = createChatTurnEventPainter({
      ...row, mount, thoughtController: controller, thoughts: options, isolated: true,
      isDomVisible: () => row.wrap.isConnected, revealProse: () => {}, scrollTranscript: scroll, modeId: chat.modeId,
    });
    let indicator: ReturnType<typeof attachToolStartIndicator> | undefined;
    let tool: string | null = null;
    return {
      sync(live: EmbeddedChatLive) {
        const delta = live.lastDelta ?? '';
        const thinking = live.lastThinking ?? '';
        const previous = painter.snapshot();
        if (thinking !== previous.lastThinking || live.reasoningFormat !== previous.reasoningFormat) {
          if (!thinking.startsWith(previous.lastThinking)) controller.resetFailedResponse();
          painter.onEvent({ type: 'thinking', text: thinking, reasoningFormat: live.reasoningFormat });
        }
        if (delta !== previous.lastDelta) painter.onEvent({ type: 'delta', text: delta });
        const nextTool = live.currentTool ?? null;
        if (tool !== nextTool) {
          indicator?.dispose();
          indicator = nextTool ? attachToolStartIndicator(row) : undefined;
          if (nextTool) indicator?.show(nextTool);
          tool = nextTool;
        }
        if (!delta && !tool) row.streamStatus.setPhase(live.phase === 'loading_model' ? 'loading_model'
          : live.phase === 'thinking' || thinking ? 'thinking' : 'generating');
      },
      dispose() {
        indicator?.dispose();
        painter.dispose();
        controller.abort();
        row.wrap.remove();
      },
    };
  }

  function clear(): void {
    liveRow?.dispose();
    liveRow = undefined;
    historyView?.dispose();
    historyView = undefined;
    painted = undefined;
  }

  return {
    sync(chat: Chat, live?: EmbeddedChatLive, pending?: ChatTranscriptPresentation['pendingToolStatus']) {
      streaming = Boolean(live);
      const revision = chatMutationVersion(chat);
      const { work, presentation } = disclosuresFor(chat.id);
      const replace = !painted || painted.chat !== chat || painted.history !== chat.history
        || painted.count !== chat.history.length || painted.revision !== revision || painted.pending !== pending;
      if (replace) {
        clear();
        historyView = renderEmbeddedChatTranscript(chat, mount, work, { ...presentation, pendingToolStatus: pending }, () => streaming);
        painted = { chat, history: chat.history, count: chat.history.length, revision, pending };
      }
      const showingToolRows = live && (!live.phase || live.phase === 'tools' || live.phase === 'waiting')
        && Boolean(mount.querySelector('.tool-call-msg[aria-busy="true"]'));
      if (live && !showingToolRows) {
        liveRow ??= mountLiveRow(chat, presentation);
        liveRow.sync(live);
      } else if (liveRow) {
        liveRow.dispose();
        liveRow = undefined;
      }
      scroll();
    },
    reset() {
      clear();
      pinned = true;
      mount.replaceChildren();
    },
    dispose() {
      clear();
      disclosures.clear();
      scroller.removeEventListener('scroll', updatePinned);
    },
  };
}
