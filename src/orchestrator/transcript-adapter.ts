/**
 * Board attempt transcripts, in the shape the chat renderer already speaks.
 *
 * An attempt is recorded as a JSONL stream of turn events (`thinking`,
 * `tool_call`, `tool_result`, `round_end`, `attempt_end`, `error`). The chat
 * transcript renderer takes API-shaped messages. This is the seam between them,
 * so a board attempt reads like every other thread in the app instead of like a
 * log file.
 */

import type { Message } from '../types';
import type { TurnEvent } from '../../server/runner/run-turn';
import type { ConversationSnapshot } from '../chat/conversation-view';
import { applyTurnEventToMessages } from '../../server/orchestrator/transcript-messages.js';

/** Board journals adapt data; the shared chat owns all message and stream DOM. */
export function adaptAttemptConversation(events: readonly Record<string, unknown>[], isLive: boolean): ConversationSnapshot & { end: AttemptOutcomeLine | null } {
  let boundary = -1;
  let completedRound = -1;
  events.forEach((event, index) => {
    if (event.type === 'context_compaction') boundary = index;
    if (event.type !== 'round_end') return;
    boundary = index;
    completedRound = typeof event.index === 'number' ? event.index : completedRound + 1;
  });
  const ended = events.some(event => event.type === 'attempt_end' || event.type === 'error');
  const settled = !isLive || ended;
  const { messages, end } = adaptAttemptTranscript(settled ? events : events.slice(0, boundary + 1));
  const history = messages.map(raw => {
    const { reasoning, isError, ...message } = raw as Record<string, unknown>;
    return { ...message, ...(typeof reasoning === 'string' && reasoning ? { thinking: [reasoning] } : {}),
      ...(isError ? { failed: true } : {}) } as unknown as Message;
  });
  const openEvents: TurnEvent[] = [];
  if (!settled) for (const [offset, event] of events.slice(boundary + 1).entries()) {
    const name = text(event.name) || 'tool';
    if (event.type === 'thinking') openEvents.push({ type: 'thinking', text: text(event.text),
      ...(event.reasoningFormat === 'summary' ? { reasoningFormat: 'summary' } : {}) });
    if (event.type === 'delta') openEvents.push({ type: 'delta', text: text(event.text) });
    if (event.type === 'reasoning_end') openEvents.push({ type: 'reasoning_end' });
    if (event.type === 'phase' && ['thinking', 'generating', 'tools'].includes(text(event.phase))) {
      openEvents.push({ type: 'phase', phase: event.phase as 'thinking' | 'generating' | 'tools' });
    }
    if (event.type === 'tool_streaming') openEvents.push({ type: 'tool_streaming', name });
    if (event.type === 'response_restart') openEvents.push({ type: 'response_restart', warning: text(event.warning) });
    if (event.type === 'tool_call') openEvents.push({ type: 'tool_call', name, id: callId(event.id, boundary + 1 + offset), arguments: event.arguments });
    if (event.type === 'tool_result') openEvents.push({ type: 'tool_result', name, id: text(event.id), content: text(event.content ?? event.result),
      ...(event.codeChange ? { codeChange: event.codeChange } : {}), ...(Array.isArray(event.attachments) ? { attachments: event.attachments } : {}) });
  }
  return { history, openEvents, completedRound, isLive: !settled, end };
}

export interface AttemptOutcomeLine {
  outcome: string;
  summary: string;
}

export interface AdaptedTranscript {
  /** API-shaped messages for `renderTranscriptView`. */
  messages: unknown[];
  /** How the attempt ended, if the transcript recorded it. */
  end: AttemptOutcomeLine | null;
}

interface PendingToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Tool arguments reach the renderer as the JSON string the API uses. */
function argumentsJson(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

/**
 * A tool call with no id cannot be paired with its result by id, so give it a
 * stable synthetic one rather than dropping the row.
 */
function callId(raw: unknown, index: number): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  return id || `ov2-call-${index}`;
}

/**
 * Fold one attempt's recorded events into a message list.
 *
 * Thinking accumulates onto the assistant turn it belongs to. Tool calls and
 * their results are paired by id. `round_end` carries the assistant's prose for
 * that round. Cumulative `delta` snapshots retain prose while a round is live
 * or interrupted; the settled round replaces them rather than repeating them.
 */
export function adaptAttemptTranscript(
  events: readonly Record<string, unknown>[],
): AdaptedTranscript {
  const messages: unknown[] = [];
  let thinking: string[] = [];
  let reasoningFormat: 'summary' | undefined;
  let partialText = '';
  let settledText: string | null = null;
  let pendingCalls: PendingToolCall[] = [];
  const resultsByCallId = new Map<string, Record<string, unknown>>();
  let end: AttemptOutcomeLine | null = null;

  /** Close the current assistant turn, carrying its thinking and tool calls. */
  const flushAssistant = (content: string): void => {
    if (!content && thinking.length === 0 && pendingCalls.length === 0) return;
    const message: Record<string, unknown> = { role: 'assistant', content };
    if (thinking.length > 0) message.reasoning = thinking.join('\n\n');
    if (reasoningFormat) message.reasoningFormat = reasoningFormat;
    if (pendingCalls.length > 0) message.tool_calls = pendingCalls;
    messages.push(message);

    for (const call of pendingCalls) {
      const result = resultsByCallId.get(call.id);
      if (!result) continue;
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        ...result,
      });
      resultsByCallId.delete(call.id);
    }
    thinking = [];
    reasoningFormat = undefined;
    partialText = '';
    pendingCalls = [];
  };

  events.forEach((event, index) => {
    const type = typeof event.type === 'string' ? event.type : '';

    if (type === 'thinking') {
      if (event.reasoningFormat === 'summary') reasoningFormat = 'summary';
      settledText = null;
      const body = text(event.text).trim();
      const last = thinking.at(-1);
      if (body && last && body.startsWith(last)) thinking[thinking.length - 1] = body;
      else if (body && !last?.startsWith(body)) thinking.push(body);
      return;
    }

    if (type === 'delta') {
      // The runner can publish the settled message again through persistence.
      if (text(event.text) === settledText) return;
      partialText = text(event.text);
      return;
    }

    if (type === 'response_restart') {
      reasoningFormat = undefined;
      settledText = null;
      partialText = '';
      thinking = [];
      return;
    }

    if (type === 'tool_call') {
      settledText = null;
      pendingCalls.push({
        id: callId(event.id, index),
        type: 'function',
        function: {
          name: text(event.name) || 'tool',
          arguments: argumentsJson(event.arguments),
        },
      });
      return;
    }

    if (type === 'tool_result') {
      const content = text(event.content ?? event.result);
      const result: Record<string, unknown> = { content };
      if (event.codeChange !== undefined) result.codeChange = event.codeChange;
      if (Array.isArray(event.attachments)) result.attachments = event.attachments;
      const id = typeof event.id === 'string' ? event.id.trim() : '';
      if (id) {
        resultsByCallId.set(id, result);
        return;
      }
      // No id: attach to the oldest call still waiting on one.
      const waiting = pendingCalls.find((call) => !resultsByCallId.has(call.id));
      if (waiting) resultsByCallId.set(waiting.id, result);
      return;
    }

    if (type === 'round_end') {
      if (event.reasoningFormat === 'summary') reasoningFormat = 'summary';
      // Some providers expose reasoning only on the completed response.
      // This is the complete round, including any streamed reasoning.
      const reasoning = text(event.reasoning).trim();
      if (reasoning) thinking = [reasoning];
      flushAssistant(text(event.text) || partialText);
      settledText = text(event.text);
      return;
    }

    if (type === 'attempt_end') {
      flushAssistant(partialText);
      end = {
        outcome: text(event.name) || 'ended',
        summary: text(event.summary),
      };
      return;
    }

    if (type === 'context_compaction') {
      flushAssistant(partialText);
      messages.push(...applyTurnEventToMessages([], event));
      return;
    }

    if (type === 'error') {
      const body = text(event.error ?? event.text ?? event.name).trim();
      if (!body) return;
      flushAssistant(partialText);
      messages.push({ role: 'assistant', content: body, isError: true });
      return;
    }
  });

  // Whatever was still open when the stream ran out — a live attempt, or one
  // that died before its last round closed.
  flushAssistant(partialText);

  return { messages, end };
}

/**
 * What the agent is doing right now, from the tail of its recorded events.
 * Drives the live status under the thread and the activity line on the card.
 */
export function liveTailPhase(
  events: readonly Record<string, unknown>[],
): { phase: 'thinking' | 'tools' | 'generating'; toolName?: string; reasoning?: string } {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const type = typeof event?.type === 'string' ? event.type : '';
    if (type === 'tool_call' || type === 'tool_streaming') {
      return { phase: 'tools', toolName: text(event.name) || 'tool' };
    }
    if (type === 'tool_result' || type === 'round_end' || type === 'delta' || type === 'response_restart') return { phase: 'generating' };
    if (type === 'thinking') {
      const reasoning = text(event.text).trim();
      return reasoning ? { phase: 'thinking', reasoning } : { phase: 'thinking' };
    }
  }
  return { phase: 'generating' };
}

/**
 * Cheap identity for "did the thread gain a tool/round, or only grow a thought?"
 *
 * Thinking text is omitted so a coalesced thought can patch in place without
 * treating every token as a new transcript.
 */
export function transcriptStructureKey(
  events: readonly Record<string, unknown>[],
): string {
  return events
    .map((event) => {
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === 'thinking') return 'thinking';
      // Prose snapshots must repaint the assistant row as their content grows.
      if (type === 'delta') return `delta:${text(event.text)}`;
      if (type === 'tool_call' || type === 'tool_result') {
        return `${type}:${text(event.id) || text(event.name)}`;
      }
      if (type === 'round_end') return `round_end:${text(event.index)}`;
      if (type === 'attempt_end') return `attempt_end:${text(event.name)}`;
      return type;
    })
    .join('|');
}
