/**
 * The first user message of a /followup chat (MIN-206).
 *
 * A follow-up chat opens with the previous chat's context summary plus the task it
 * exists to do, so it needs no re-explaining. The text is sent with `parseSlash: false`
 * — a seeded summary must never be read as a slash skill.
 */

/** Max task text echoed into a seed message. */
export const MAX_FOLLOWUP_SEED_TASK_CHARS = 4000;

/** Max title seed taken from the task line. */
const MAX_TITLE_SEED_CHARS = 80;
/** Max task text carried by the deterministic fallback. */
const MAX_FALLBACK_TASK_CHARS = 200;

export interface ComposeFollowupSeedInput {
  sourceChatName: string;
  /** 1-based link number of the chat being created. */
  index: number;
  /** Total links requested by the user. */
  total: number;
  summary: string;
  taskText: string;
}

/** First user message for the follow-up chat. */
export function composeFollowupSeedMessage(input: ComposeFollowupSeedInput): string {
  const sourceName = input.sourceChatName.trim() || 'previous chat';
  const task = input.taskText.trim().slice(0, MAX_FOLLOWUP_SEED_TASK_CHARS);
  return [
    `Follow-up ${input.index}/${input.total} · continuing from "${sourceName}"`,
    '## Context from the previous chat',
    input.summary.trim(),
    '## Your task',
    task,
  ].join('\n\n');
}

/** Sidebar/title seed for the new chat: first line of the task. */
export function followupTitleSeed(taskText: string): string {
  const firstLine = taskText.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return firstLine.slice(0, MAX_TITLE_SEED_CHARS);
}

/**
 * Deterministic last resort when the utility model cannot produce a task:
 * reuse the most recent request from the summary.
 */
export function fallbackFollowupTask(summary: string): string {
  const requestsBlock = summary.split(/^User requests:$/m)[1] ?? '';
  const bullet = requestsBlock
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('- ') && line.length > 2);

  if (!bullet) return 'Continue the work from the previous chat.';

  const request = bullet.slice(2).trim().slice(0, MAX_FALLBACK_TASK_CHARS);
  return request
    ? `Continue the work from the previous chat: ${request}`
    : 'Continue the work from the previous chat.';
}
