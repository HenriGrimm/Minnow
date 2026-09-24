/**
 * Prompt for the agent-chosen follow-up task (MIN-206).
 *
 * Used only when the chain advances without a user-supplied task; the first link
 * keeps the user's own prompt. Short, imperative output keeps the next chat's
 * seed message tight.
 */

import type { ApiMessage } from '../../types';

export function buildFollowupTaskMessages(summary: string): ApiMessage[] {
  return [
    {
      role: 'system',
      content:
        "You pick the single next task for a developer's follow-up chat. Reply with one imperative sentence naming the concrete next step. No preamble, no numbering, no markdown, no quotes.",
    },
    {
      role: 'user',
      content: `Here is what the previous chat did.\n\n${summary}\n\nWhat is the single most valuable next task?`,
    },
  ];
}
