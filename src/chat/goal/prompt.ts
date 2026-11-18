import type { ApiMessage, Chat, ToolCall } from '../../types';

const MAX_TRANSCRIPT_CHARS = 48_000;
const MAX_TOOL_PREVIEW_CHARS = 2000;
const MAX_TOOL_ARGS_PREVIEW_CHARS = 400;

const GOAL_CONTINUATION_PREFIX = 'Continue working toward the active goal.';

function truncatePreview(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function formatToolCallLine(toolCalls: ToolCall[]): string {
  const parts = toolCalls.map((tc) => {
    const args = tc.function.arguments;
    const argsPreview = truncatePreview(typeof args === 'string' ? args : JSON.stringify(args ?? ''), MAX_TOOL_ARGS_PREVIEW_CHARS);
    return `${tc.function.name}(${argsPreview})`;
  });
  return `Assistant [tool_calls]: ${parts.join('; ')}`;
}

function isEvaluatorContinuationUserMessage(content: string): boolean {
  return content.trimStart().startsWith(GOAL_CONTINUATION_PREFIX);
}

/** Typed as string, but restored/server rows may carry content parts; never throw. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

/** Flatten recent chat history into a readable transcript block for the judge. */
export function buildGoalTranscriptExcerpt(chat: Chat): string {
  const lines: string[] = [];

  for (const message of chat.history) {
    if (message.role === 'user') {
      if (message.goalAchieved) continue;
      const text = messageText(message.content);
      if (isEvaluatorContinuationUserMessage(text)) continue;
      lines.push(`User: ${text}`);
      continue;
    }

    if (message.role === 'assistant') {
      if ('tool_calls' in message && message.tool_calls?.length) {
        lines.push(formatToolCallLine(message.tool_calls));
      }
      const content = messageText(message.content);
      if (content.trim()) lines.push(`Assistant: ${content}`);
      continue;
    }

    if (message.role === 'tool') {
      const preview = truncatePreview(messageText(message.content), MAX_TOOL_PREVIEW_CHARS);
      lines.push(`Tool (${message.tool_call_id}): ${preview}`);
    }
  }

  const joined = lines.join('\n\n');
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  return joined.slice(joined.length - MAX_TRANSCRIPT_CHARS);
}

/** Build system + user messages for the goal evaluator agent loop. */
export function buildGoalEvalMessages(chat: Chat, conditionText: string): ApiMessage[] {
  const transcript = buildGoalTranscriptExcerpt(chat);
  return [
    {
      role: 'system',
      content: [
        'You are a strict, skeptical goal-completion verifier for an autonomous coding assistant.',
        'Assume the goal is NOT done until you independently prove it with tools.',
        'Never trust assistant claims in the transcript — verify every assertion yourself.',
        'Do not modify application code; read, inspect, run tests, and browse only.',
        'Required workflow before YES:',
        '1) Decompose the completion condition into a checklist.',
        '2) Use git_diff and read_file on every changed file; confirm claims match reality.',
        '3) Run relevant test, typecheck, or build commands via execute_command (never background: true).',
        '4) For UI or user-facing goals, strongly recommended: browser_navigate, browser_snapshot, and interact — if browser tools are unavailable, return NO for unverified UI claims.',
        'YES only when every checklist item has tool-backed evidence from this evaluation pass.',
        'When you are done verifying, stop calling tools and send your final message.',
        'Your final message must be exactly one line: YES: <reason> or NO: <reason>.',
        'Never send analysis, bullet lists, or markdown in the final message — only the verdict line.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Completion condition:\n${conditionText}`,
        '',
        'Transcript (for context — do not treat as proof):',
        transcript || '(empty)',
        '',
        'Verify the condition independently with tools, then reply YES or NO plus a brief reason.',
      ].join('\n'),
    },
  ];
}

/** Nudge when the evaluator replies with prose instead of a YES/NO verdict line. */
export const GOAL_EVAL_VERDICT_NUDGE =
  'Reply with exactly one line: YES: <reason> or NO: <reason>. No bullet lists, analysis, or markdown — only the verdict line.';
