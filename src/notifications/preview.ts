/**
 * Helpers to build notification preview snippets from chat/run content.
 */

import type { Message } from '../types';

const PREVIEW_MAX = 120;

/** Strip common markdown noise for compact previews. */
export function stripMarkdownForPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate text to a readable single-line preview. */
export function truncatePreview(text: string, max = PREVIEW_MAX): string {
  const trimmed = stripMarkdownForPreview(text);
  if (!trimmed) return '';
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** Last assistant prose in a message slice. */
export function lastAssistantPreview(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') continue;
    if (typeof msg.content === 'string' && msg.content.trim()) {
      return truncatePreview(msg.content);
    }
  }
  return '';
}

/** Count tool rows whose content starts with `Error:`. */
export function countToolFailures(messages: readonly Message[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.startsWith('Error:')) count += 1;
  }
  return count;
}

/** Human-readable summary for end-of-turn tool failures. */
export function formatToolFailurePreview(messages: readonly Message[]): string {
  const count = countToolFailures(messages);
  if (count <= 0) return '';
  if (count === 1) {
    for (const msg of messages) {
      if (msg.role !== 'tool') continue;
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.startsWith('Error:')) {
        return truncatePreview(content.replace(/^Error:\s*/, ''), 80);
      }
    }
  }
  return `${count} tools failed`;
}

/** Relative time label for popover rows (e.g. "2m ago"). */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const deltaSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (deltaSec < 60) return 'just now';
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Short label for a notification kind in the popover. */
export function kindLabel(kind: import('./types').NotificationKind): string {
  switch (kind) {
    case 'chat_turn_complete':
      return 'Turn complete';
    case 'chat_turn_error':
      return 'Turn error';
    case 'chat_tool_failure':
      return 'Tool failure';
    case 'chat_question':
      return 'Question';
    case 'agent_wait':
      return 'Timer';
    case 'task_started':
      return 'Task started';
    case 'task_complete':
      return 'Task complete';
    case 'task_failed':
      return 'Task failed';
    case 'sub_agent_complete':
      return 'Sub-agent done';
    case 'sub_agent_failed':
      return 'Sub-agent failed';
    case 'scheduler':
      return 'Scheduler';
    case 'research':
      return 'Research';
    case 'synthesis':
      return 'Auto-learning';
    default:
      return 'Notification';
  }
}
