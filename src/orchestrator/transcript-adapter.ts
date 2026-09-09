/**
 * Board attempt transcripts, in the shape the chat renderer already speaks.
 *
 * An attempt is recorded as a JSONL stream of turn events (`thinking`,
 * `tool_call`, `tool_result`, `round_end`, `attempt_end`, `error`). The chat
 * transcript renderer takes API-shaped messages. This is the seam between them,
 * so a board attempt reads like every other thread in the app instead of like a
 * log file.
 */

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
 * that round, which is the only place assistant text survives — the streaming
 * deltas are filtered out before they reach the transcript.
 */
export function adaptAttemptTranscript(
  events: readonly Record<string, unknown>[],
): AdaptedTranscript {
  const messages: unknown[] = [];
  let thinking: string[] = [];
  let pendingCalls: PendingToolCall[] = [];
  const resultsByCallId = new Map<string, string>();
  let end: AttemptOutcomeLine | null = null;

  /** Close the current assistant turn, carrying its thinking and tool calls. */
  const flushAssistant = (content: string): void => {
    if (!content && thinking.length === 0 && pendingCalls.length === 0) return;
    const message: Record<string, unknown> = { role: 'assistant', content };
    if (thinking.length > 0) message.reasoning = thinking.join('\n\n');
    if (pendingCalls.length > 0) message.tool_calls = pendingCalls;
    messages.push(message);

    for (const call of pendingCalls) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: resultsByCallId.get(call.id) ?? '',
      });
      resultsByCallId.delete(call.id);
    }
    thinking = [];
    pendingCalls = [];
  };

  events.forEach((event, index) => {
    const type = typeof event.type === 'string' ? event.type : '';

    if (type === 'thinking') {
      const body = text(event.text).trim();
      if (body) thinking.push(body);
      return;
    }

    if (type === 'tool_call') {
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
      const id = typeof event.id === 'string' ? event.id.trim() : '';
      if (id) {
        resultsByCallId.set(id, content);
        return;
      }
      // No id: attach to the oldest call still waiting on one.
      const waiting = pendingCalls.find((call) => !resultsByCallId.has(call.id));
      if (waiting) resultsByCallId.set(waiting.id, content);
      return;
    }

    if (type === 'round_end') {
      flushAssistant(text(event.text));
      return;
    }

    if (type === 'attempt_end') {
      flushAssistant('');
      end = {
        outcome: text(event.name) || 'ended',
        summary: text(event.summary),
      };
      return;
    }

    if (type === 'error') {
      const body = text(event.error ?? event.text ?? event.name).trim();
      if (!body) return;
      flushAssistant('');
      messages.push({ role: 'assistant', content: body, isError: true });
      return;
    }
  });

  // Whatever was still open when the stream ran out — a live attempt, or one
  // that died before its last round closed.
  flushAssistant('');

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
    if (type === 'tool_result' || type === 'round_end') return { phase: 'generating' };
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
      if (type === 'tool_call' || type === 'tool_result') {
        return `${type}:${text(event.id) || text(event.name)}`;
      }
      if (type === 'round_end') return `round_end:${text(event.index)}`;
      if (type === 'attempt_end') return `attempt_end:${text(event.name)}`;
      return type;
    })
    .join('|');
}
