import { estimateTokensFromText } from '../chat/prompts/token-estimate-core';
import { getActiveChat } from '../state/sessions';
import type { Message } from '../types';

/** Default slice returned per call (~3k tokens). Page with offset_chars for more. */
export const RECALL_TURN_DEFAULT_MAX_CHARS = 12_000;

/** Hard ceiling even when max_chars asks for more. */
export const RECALL_TURN_MAX_CHARS = 120_000;

export type RecallTurnPart = { kind: 'message' | 'tool'; text: string; toolCallId?: string };

function serializeMessage(msg: Message): RecallTurnPart | null {
  if (msg.role === 'user' || msg.role === 'assistant') {
    return { kind: 'message', text: String(msg.content ?? '') };
  }
  if (msg.role === 'tool') {
    return {
      kind: 'tool',
      text: String(msg.content ?? ''),
      toolCallId: msg.tool_call_id ?? '',
    };
  }
  return null;
}

/** Render parts, replacing tool result bodies with a one-line placeholder. */
export function renderTurnParts(
  parts: RecallTurnPart[],
  includeToolResults: boolean,
): { text: string; toolCount: number; toolChars: number } {
  let toolCount = 0;
  let toolChars = 0;
  const rendered: string[] = [];

  for (const part of parts) {
    if (part.kind !== 'tool') {
      rendered.push(part.text);
      continue;
    }
    toolCount += 1;
    toolChars += part.text.length;
    const label = `[tool ${part.toolCallId ?? ''}]`;
    rendered.push(
      includeToolResults
        ? `${label}\n${part.text}`
        : `${label} ${part.text.length} chars elided`,
    );
  }

  return { text: rendered.join('\n\n'), toolCount, toolChars };
}

/** Collect messages for a user-turn index from runs output or history fallback. */
export function reassembleTurnFromChat(
  chat: ReturnType<typeof getActiveChat>,
  turnIndex: number,
): { parts: RecallTurnPart[]; source: 'runs' | 'history' } | null {
  const history = chat.history ?? [];
  let userTurn = -1;
  let start = -1;
  for (let i = 0; i < history.length; i += 1) {
    if (history[i].role !== 'user') continue;
    userTurn += 1;
    if (userTurn === turnIndex) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  let end = start + 1;
  while (end < history.length && history[end].role !== 'user') {
    end += 1;
  }

  const toParts = (messages: Message[]): RecallTurnPart[] =>
    messages
      .map(serializeMessage)
      .filter((part): part is RecallTurnPart => part !== null);

  const runs = chat.runs ?? [];
  for (const run of runs) {
    const out = run.outputMessages;
    if (!out?.length) continue;
    const parts = toParts(out);
    if (!parts.some((part) => part.text.trim())) continue;
    if (run.forkHistoryIndex === start) {
      return { parts, source: 'runs' };
    }
  }

  return { parts: toParts(history.slice(start, end)), source: 'history' };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Browser tool handler: recall_turn_full
 *
 * A tool-heavy turn replayed verbatim re-injects every tool result it contained,
 * so tool bodies are elided and the text is windowed unless the caller opts in.
 */
export function toolRecallTurnFull(args: Record<string, unknown>): string {
  const raw = args.turnIndex;
  const turnIndex =
    typeof raw === 'number' ? Math.floor(raw) : Math.floor(Number(raw));
  if (!Number.isFinite(turnIndex) || turnIndex < 0) {
    return 'Error: "turnIndex" must be a non-negative integer';
  }

  const chat = getActiveChat();
  const result = reassembleTurnFromChat(chat, turnIndex);
  if (!result) {
    return `Error: no turn found at index ${turnIndex}`;
  }

  const includeToolResults = args.include_tool_results === true;
  const maxChars = clampInt(
    args.max_chars,
    RECALL_TURN_DEFAULT_MAX_CHARS,
    200,
    RECALL_TURN_MAX_CHARS,
  );
  const offsetChars = clampInt(args.offset_chars, 0, 0, Number.MAX_SAFE_INTEGER);

  const { text, toolCount, toolChars } = renderTurnParts(result.parts, includeToolResults);
  const slice = text.slice(offsetChars, offsetChars + maxChars);
  const hasMore = offsetChars + slice.length < text.length;

  const header = [
    `Turn ${turnIndex} (source: ${result.source})`,
    `chars ${offsetChars}-${offsetChars + slice.length} of ${text.length}, ~${estimateTokensFromText(slice)} tokens in this slice`,
  ];
  if (toolCount > 0) {
    header.push(
      includeToolResults
        ? `${toolCount} tool result(s) included (${toolChars} chars)`
        : `${toolCount} tool result(s) elided (${toolChars} chars) — pass include_tool_results: true to include them`,
    );
  }
  if (hasMore) {
    header.push(
      `Truncated — pass offset_chars: ${offsetChars + slice.length} for the next slice, or raise max_chars`,
    );
  }

  return [header.join('\n'), '', slice].join('\n');
}
