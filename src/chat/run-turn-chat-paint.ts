import type { TurnEvent } from '../../server/runner/run-turn';
import {
  cancelAssistantBubbleRenderDebounce,
  finishStreamingBubbleRender,
  scheduleAssistantBubbleRender,
  setAssistantBubbleContent,
} from '../markdown/renderer';
import {
  anchorPersistedThoughtsOnRow,
  removeOrphanStreamingRow,
  revealAssistantProseBubble,
} from '../ui/messages';
import { scrollChatIfPinned } from '../ui/chat-scroll';
import { renderToolCall, renderToolResult } from '../ui/tool-messages';
import { attachShellKillUi } from '../ui/shell-run-ui';
import { notifyMemorySavedFromTool } from '../ui/memory-saved-toast';
import {
  renderThoughtsToggle,
  syncThoughtsCaretPulse,
  thoughtsScopeFromEl,
  type ThoughtBubbleController,
} from '../ui/thought-bubbles';
import {
  attachToolStartIndicator,
  type StreamingStatusHandle,
  type ToolStartIndicatorHandle,
} from '../ui/stream-status';
import {
  parseToolArguments,
  TOOL_ARGUMENTS_INVALID_JSON,
  type ParseToolArgumentsResult,
} from '../tools/parse-tool-arguments';
import { resolveLiveToolWrap } from '../tools/chat-tool-batch';
import type { CodeChangeStats, ToolImageAttachment } from '../types';
import { sessionState } from '../state/sessions';
import { isStreamDomVisible } from './streaming-state';

// ── Types ────────────────────────────────────────────────────────────────────

export type ChatTurnThoughtController = Pick<ThoughtBubbleController, 'appendReasoningDelta'> & {
  consumePersistedSegments?: ThoughtBubbleController['consumePersistedSegments'];
  endReasoningPhase?: ThoughtBubbleController['endReasoningPhase'];
  setAssistantWrap?: ThoughtBubbleController['setAssistantWrap'];
  resetStreamPhaseHints?: ThoughtBubbleController['resetStreamPhaseHints'];
  resetFailedResponse?: ThoughtBubbleController['resetFailedResponse'];
  setThinkingElapsed?: ThoughtBubbleController['setThinkingElapsed'];
};

/** Closed-round notice so the caller can stamp `historyIndex` and message actions. */
export interface ChatTurnRoundFinalizedInfo {
  wrap: HTMLElement;
  text: string;
  toolCallCount: number;
  connected: boolean;
}

/** DOM + thought controller the live `runChatTurn` path already owns. */
export interface ChatTurnPaintHost {
  wrap: HTMLElement;
  bubble: HTMLElement;
  cursor: HTMLElement;
  streamStatus?: StreamingStatusHandle;
  thoughtController: ChatTurnThoughtController;
  /** Transcript mount that receives `.tool-call-msg` rows. */
  mount: HTMLElement;
  chatId?: string;
  isDomVisible?: () => boolean;
  /** First prose token reveals the awaiting bubble. */
  revealProse: () => void;
  /** Optional activity ping (sidebar dots, stream-activity listeners). */
  onActivity?: () => void;
  scrollTranscript?: () => void;
  /** Override markdown schedule (tests count calls without lexing). */
  scheduleMarkdown?: (
    bubble: HTMLElement,
    markdown: string,
    streamCursor: HTMLElement,
    opts?: { immediate?: boolean },
  ) => void;
  schedulePaintTick?: (cb: () => void) => void;
  onCoalescedPaint?: (snap: ChatTurnPaintSnapshot) => void;
  /** Chat mode for finalized markdown (tool-round close). */
  modeId?: string;
  /** Close the live thinking timer for this round; returns duration ms. */
  finalizeThinkingRound?: () => number;
  beginNextStreamingRow?: () => Partial<ChatTurnPaintHost> | void;
  /** History index / message actions after a round is closed in the DOM. */
  onRoundFinalized?: (info: ChatTurnRoundFinalizedInfo) => void;
}

export interface ChatTurnPaintSnapshot {
  lastDelta: string;
  lastThinking: string;
  toolCallCount: number;
}

export interface ChatTurnEventPainter {
  onEvent: (event: TurnEvent) => void;
  snapshot: () => ChatTurnPaintSnapshot;
  /** Apply any pending delta/thinking now (end of turn, tests, before tool rows). */
  flush: () => void;
  /** Retarget live handles after a stream-dom remount (chat switch). */
  retarget: (next: Partial<ChatTurnPaintHost>) => void;
}

export interface FinalizeThinkingRoundOpts {
  thoughtController: ChatTurnThoughtController | null | undefined;
  wrap: HTMLElement;
  streamStatus?: StreamingStatusHandle;
  hasProse: boolean;
  durationMs?: number;
  /** When false, skip DOM (background chat). Default true. */
  domVisible?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function finalizeAndAnchorThinkingRound(
  opts: FinalizeThinkingRoundOpts,
): { segments: string[]; durationMs: number } {
  const segments = opts.thoughtController?.consumePersistedSegments?.() ?? [];
  const durationMs = opts.durationMs ?? 0;
  if (opts.domVisible === false) return { segments, durationMs };
  if (segments.length > 0) {
    const durationOpt = durationMs > 0 ? { durationMs } : {};
    if (opts.hasProse) {
      renderThoughtsToggle(opts.wrap, segments, durationOpt);
    } else {
      anchorPersistedThoughtsOnRow(opts.wrap, segments, {
        ...durationOpt,
        streamStatus: opts.streamStatus,
      });
    }
    syncThoughtsCaretPulse(thoughtsScopeFromEl(opts.wrap));
  } else if (!opts.hasProse) {
    removeOrphanStreamingRow(opts.wrap, opts.streamStatus);
  }
  return { segments, durationMs };
}

export function thinkingDeltaFromSnapshot(previous: string, next: string): string {
  if (!next) return '';
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

export function parsePaintToolArguments(
  raw: unknown,
  constrained = true,
): ParseToolArgumentsResult {
  if (typeof raw === 'string') {
    return parseToolArguments(raw, { constrained });
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown> };
  }
  if (constrained && raw != null) {
    return { args: {}, parseError: TOOL_ARGUMENTS_INVALID_JSON };
  }
  return { args: {} };
}

/** Display-only args from a `tool_call` event. Never returns `{ raw }`. */
export function coerceToolCallArgs(raw: unknown): unknown {
  return parsePaintToolArguments(raw).args;
}

/** P10-B `tool_result.attachments` is untyped on the wire. */
function asToolImageAttachments(raw: unknown): ToolImageAttachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw as ToolImageAttachment[];
}

/** P10-B `tool_result.codeChange` is untyped on the wire. */
function asCodeChangeStats(raw: unknown): CodeChangeStats | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.additions !== 'number' || typeof rec.deletions !== 'number') {
    return undefined;
  }
  return rec as unknown as CodeChangeStats;
}

function argsRecordFromUnknown(args: unknown): Record<string, unknown> | undefined {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return undefined;
}

function displayToolResultContent(event: {
  content: string;
  isError?: boolean;
}): string {
  if (event.isError && !event.content.trimStart().startsWith('Error:')) {
    return `Error: ${event.content}`;
  }
  return event.content;
}

/** rAF when the compositor is about to paint; setTimeout(0) in node / missing rAF. */
function defaultSchedulePaintTick(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      cb();
    });
    return;
  }
  setTimeout(cb, 0);
}

// ── Painter ──────────────────────────────────────────────────────────────────

export function createChatTurnEventPainter(host: ChatTurnPaintHost): ChatTurnEventPainter {
  let lastDelta = '';
  let lastThinking = '';
  let lastPaintedThinking = '';
  let pendingDelta: string | null = null;
  let pendingThinking: string | null = null;
  let paintScheduled = false;
  let toolCallCount = 0;
  let proseRevealed = false;
  const toolWraps = new Map<string, HTMLElement>();
  const argsById = new Map<string, unknown>();
  let lastStreamingToolName: string | null = null;
  let toolStart: ToolStartIndicatorHandle | null = null;

  const scheduleMarkdown =
    host.scheduleMarkdown ??
    ((
      bubble: HTMLElement,
      markdown: string,
      streamCursor: HTMLElement,
      opts?: { immediate?: boolean },
    ) => {
      scheduleAssistantBubbleRender(bubble, markdown, streamCursor, {
        pinScroll: false,
        immediate: opts?.immediate,
      });
    });
  const scrollTranscript = host.scrollTranscript ?? scrollChatIfPinned;
  const schedulePaintTick = host.schedulePaintTick ?? defaultSchedulePaintTick;

  const originStreamVisible = (): boolean => {
    if (host.isDomVisible) return host.isDomVisible();
    if (!host.chatId) return true;
    if (!sessionState) return true;
    return isStreamDomVisible(host.chatId);
  };

  const bindToolStartIndicator = (): void => {
    toolStart?.dispose();
    toolStart = null;
    if (!lastStreamingToolName || !host.streamStatus) return;
    if (!originStreamVisible()) return;
    toolStart = attachToolStartIndicator({
      wrap: host.wrap,
      bubble: host.bubble,
      cursor: host.cursor,
      streamStatus: host.streamStatus,
    });
    toolStart.show(lastStreamingToolName);
  };

  const clearToolStartIndicator = (): void => {
    lastStreamingToolName = null;
    toolStart?.dispose();
    toolStart = null;
  };

  const flushPaint = (opts?: { immediateMarkdown?: boolean }): void => {
    paintScheduled = false;
    const thinkingSnap = pendingThinking;
    const deltaSnap = pendingDelta;
    pendingThinking = null;
    pendingDelta = null;
    if (thinkingSnap === null && deltaSnap === null) return;

    const visible = originStreamVisible();

    if (thinkingSnap !== null) {
      const added = thinkingDeltaFromSnapshot(lastPaintedThinking, thinkingSnap);
      lastPaintedThinking = thinkingSnap;
      if (added && visible) host.thoughtController.appendReasoningDelta(added);
    }

    if (deltaSnap !== null) {
      if (!proseRevealed && deltaSnap.trim()) {
        proseRevealed = true;
        if (visible) {
          host.revealProse();
          revealAssistantProseBubble(host.wrap, host.bubble, host.streamStatus);
        }
      }
      if (visible) {
        scheduleMarkdown(
          host.bubble,
          deltaSnap,
          host.cursor,
          opts?.immediateMarkdown ? { immediate: true } : undefined,
        );
      }
    }

    if (visible) scrollTranscript();
    host.onCoalescedPaint?.({ lastDelta, lastThinking, toolCallCount });
  };

  const schedulePaint = (): void => {
    if (paintScheduled) return;
    paintScheduled = true;
    schedulePaintTick(() => {
      flushPaint();
    });
  };

  /** Drop per-round snapshots so the next model round cannot prefix-diff against this one. */
  const resetRoundPaintState = (): void => {
    lastDelta = '';
    lastThinking = '';
    lastPaintedThinking = '';
    pendingDelta = null;
    pendingThinking = null;
    proseRevealed = false;
  };

  const applyHostPatch = (next: Partial<ChatTurnPaintHost>): void => {
    if (next.wrap) host.wrap = next.wrap;
    if (next.bubble) host.bubble = next.bubble;
    if (next.cursor) host.cursor = next.cursor;
    if (next.streamStatus) host.streamStatus = next.streamStatus;
    if (next.chatId !== undefined) host.chatId = next.chatId;
    if (next.isDomVisible) host.isDomVisible = next.isDomVisible;
    if (next.mount && originStreamVisible()) host.mount = next.mount;
    if (next.thoughtController) host.thoughtController = next.thoughtController;
    if (next.revealProse) host.revealProse = next.revealProse;
    if (next.modeId !== undefined) host.modeId = next.modeId;
    if (next.finalizeThinkingRound) host.finalizeThinkingRound = next.finalizeThinkingRound;
    if (next.beginNextStreamingRow) host.beginNextStreamingRow = next.beginNextStreamingRow;
    if (next.onRoundFinalized) host.onRoundFinalized = next.onRoundFinalized;
    if (next.onCoalescedPaint) host.onCoalescedPaint = next.onCoalescedPaint;
    if (next.scrollTranscript) host.scrollTranscript = next.scrollTranscript;
    if (next.scheduleMarkdown) host.scheduleMarkdown = next.scheduleMarkdown;
  };

  const retarget = (next: Partial<ChatTurnPaintHost>): void => {
    applyHostPatch(next);
    flushPaint();
    if (proseRevealed && lastDelta && next.bubble && originStreamVisible()) {
      scheduleMarkdown(next.bubble, lastDelta, next.cursor ?? host.cursor);
    }
    bindToolStartIndicator();
  };

  const closeToolBearingRound = (event: Extract<TurnEvent, { type: 'round_end' }>): void => {
    flushPaint();
    const wrap = host.wrap;
    const bubble = host.bubble;
    const prose = event.text.trim() || lastDelta.trim();
    const hasProse = Boolean(prose);

    if (bubble) {
      cancelAssistantBubbleRenderDebounce(bubble);
      finishStreamingBubbleRender(bubble, host.cursor);
    }
    if (hasProse && bubble) {
      if (!proseRevealed) {
        proseRevealed = true;
        host.revealProse();
        revealAssistantProseBubble(wrap, bubble, host.streamStatus);
      }
      setAssistantBubbleContent(bubble, prose, { streaming: false, modeId: host.modeId });
    }

    const durationMs = host.finalizeThinkingRound?.() ?? 0;
    finalizeAndAnchorThinkingRound({
      thoughtController: host.thoughtController,
      wrap,
      streamStatus: host.streamStatus,
      hasProse,
      durationMs,
      domVisible: originStreamVisible(),
    });
    if (wrap.isConnected) host.streamStatus?.dispose();

    host.onRoundFinalized?.({
      wrap,
      text: prose,
      toolCallCount: event.toolCallCount,
      connected: wrap.isConnected,
    });

    resetRoundPaintState();
    clearToolStartIndicator();

    const next = host.beginNextStreamingRow?.();
    if (next) retarget(next);
  };

  const onEvent = (event: TurnEvent): void => {
    host.onActivity?.();
    if (event.type === 'response_restart') {
      pendingDelta = null; pendingThinking = null;
      lastDelta = ''; lastThinking = ''; lastPaintedThinking = '';
      clearToolStartIndicator();
      host.thoughtController.resetFailedResponse?.();
      scheduleMarkdown(host.bubble, '', host.cursor, { immediate: true });
      const warning = document.createElement('p');
      warning.className = 'router-message'; warning.setAttribute('role', 'status');
      warning.textContent = event.warning;
      host.wrap.prepend(warning);
      return;
    }
    if (event.type === 'delta') {
      lastDelta = event.text;
      pendingDelta = event.text;
      schedulePaint();
      return;
    }
    if (event.type === 'thinking') {
      lastThinking = event.text;
      pendingThinking = event.text;
      schedulePaint();
      return;
    }
    if (event.type === 'reasoning_end') {
      flushPaint();
      host.thoughtController.endReasoningPhase?.();
      return;
    }
    if (event.type === 'round_start') {
      if (event.index > 0) {
        lastPaintedThinking = '';
        lastThinking = '';
        pendingThinking = null;
      }
      return;
    }
    if (event.type === 'round_end') {
      if (event.toolCallCount > 0) closeToolBearingRound(event);
      return;
    }
    if (event.type === 'tool_streaming') {
      flushPaint({ immediateMarkdown: true });
      lastStreamingToolName = event.name;
      bindToolStartIndicator();
      return;
    }
    if (event.type === 'tool_call') {
      flushPaint({ immediateMarkdown: true });
      clearToolStartIndicator();
      toolCallCount += 1;
      const parsed = parsePaintToolArguments(event.arguments);
      // Invalid JSON must never reach execution, but keep the submitted payload so
      // a failed edit/save can show the user what the model attempted to send.
      const presentationArgs = parsed.parseError ? event.arguments : parsed.args;
      const key = event.id ?? `${event.name}:${toolCallCount}`;
      argsById.set(key, presentationArgs);
      if (event.id) argsById.set(event.id, presentationArgs);
      // Background chats rebuild tool cards from history on switch (MIN-584).
      if (!originStreamVisible()) return;
      const wrap = renderToolCall(event.name, presentationArgs);
      if (event.id) wrap.dataset.toolCallId = event.id;
      toolWraps.set(key, wrap);
      if (event.id) {
        attachShellKillUi(
          wrap,
          event.name,
          event.id,
          argsRecordFromUnknown(presentationArgs),
          undefined,
          host.chatId,
        );
      }
      host.mount.appendChild(wrap);
      return;
    }
    if (event.type === 'tool_result') {
      flushPaint();
      const key = event.id
        ? event.id
        : [...toolWraps.keys()].find((k) => k.startsWith(`${event.name}:`));
      const captured =
        (event.id && toolWraps.get(event.id)) || (key ? toolWraps.get(key) : undefined);
      const args =
        (event.id && argsById.get(event.id)) || (key ? argsById.get(key) : undefined);
      const content = displayToolResultContent(event);
      if (!captured) {
        notifyMemorySavedFromTool(event.name, args, content);
        return;
      }
      const wrap =
        originStreamVisible() && event.id
          ? resolveLiveToolWrap(event.id, captured)
          : captured;
      if (wrap !== captured && event.id) {
        toolWraps.set(event.id, wrap);
      }
      renderToolResult(
        wrap,
        content,
        asToolImageAttachments(event.attachments),
        args,
        asCodeChangeStats(event.codeChange),
      );
      if (event.id) {
        attachShellKillUi(
          wrap,
          event.name,
          event.id,
          argsRecordFromUnknown(args),
          content,
          host.chatId,
        );
      }
      notifyMemorySavedFromTool(event.name, args, content);
    }
  };

  return {
    onEvent,
    snapshot: () => ({ lastDelta, lastThinking, toolCallCount }),
    flush: flushPaint,
    retarget,
  };
}
