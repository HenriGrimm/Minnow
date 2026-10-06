/**
 * `/followup` composer command parsing (MIN-206).
 *
 * Forms:
 *   /followup                       → one follow-up, task chosen by the agent
 *   /followup <prompt>              → one follow-up with that task
 *   /followup <n>                   → n follow-ups, first task agent-chosen
 *   /followup <n> <prompt>          → n follow-ups, first task is <prompt>
 *   /followup stop                  → clear an armed chain
 */

/** Hard cap on links a single command may chain. */
export const MAX_FOLLOWUP_CHAIN = 10;

/** Max stored follow-up task length (same cap as /goal conditions and /loop prompts). */
export const MAX_FOLLOWUP_TASK_CHARS = 4000;

const FOLLOWUP_CLEAR_ALIASES = new Set([
  'stop',
  'clear',
  'off',
  'cancel',
  'reset',
  'none',
]);

const COUNT_TOKEN_RE = /^\d+$/;

export type ParsedFollowupSlash =
  | { kind: 'clear' }
  | { kind: 'invalid'; message: string }
  | { kind: 'arm'; count: number; promptText: string };

/** True when composer text is a /followup command (case-insensitive token). */
export function isFollowupSlashCommand(text: string): boolean {
  return /(?:^|\s)\/followup\b/i.test(text.trim());
}

/** Reject follow-up tasks that themselves start another /followup (no nesting). */
export function isNestedFollowupPrompt(promptText: string): boolean {
  const trimmed = promptText.trim();
  if (!trimmed) return false;
  return /^\/followup\b/i.test(trimmed);
}

export function parseFollowupSlashInput(text: string): ParsedFollowupSlash | null {
  const trimmed = text.trim();
  const match = trimmed.match(/(?:^|\s)\/followup\b/i);
  if (!match || match.index == null) return null;

  const leadingWs = match[0].startsWith(' ') ? 1 : 0;
  const removeStart = match.index + leadingWs;
  const removeEnd = removeStart + match[0].length - leadingWs;
  const rest = `${trimmed.slice(0, removeStart)}${trimmed.slice(removeEnd)}`.trim();

  if (!rest) {
    return { kind: 'arm', count: 1, promptText: '' };
  }

  const tokens = rest.split(/\s+/);
  const first = (tokens[0] ?? '').toLowerCase();

  if (FOLLOWUP_CLEAR_ALIASES.has(first)) {
    return { kind: 'clear' };
  }

  if (COUNT_TOKEN_RE.test(first)) {
    const count = Number.parseInt(first, 10);
    if (!Number.isFinite(count) || count < 1 || count > MAX_FOLLOWUP_CHAIN) {
      return {
        kind: 'invalid',
        message: `Follow-up count must be between 1 and ${MAX_FOLLOWUP_CHAIN}`,
      };
    }
    const promptText = rest
      .slice((tokens[0] ?? '').length)
      .trim()
      .slice(0, MAX_FOLLOWUP_TASK_CHARS);
    return { kind: 'arm', count, promptText };
  }

  return {
    kind: 'arm',
    count: 1,
    promptText: rest.slice(0, MAX_FOLLOWUP_TASK_CHARS).trim(),
  };
}
