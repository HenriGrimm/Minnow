/**
 * Deterministic context summary handed to a /followup chat (MIN-206).
 *
 * No model call: the summary is assembled from rows the chat already holds — the
 * latest compaction checkpoint when the transcript was folded, the user's recent
 * requests, where the last reply ended, and the files the work touched. That keeps
 * a chain cheap (only the agent-chosen task needs a completion) and reproducible.
 */

import { extractMessageText } from '../../api/chat';
import { getPerFileChangeSummary } from '../../usage/code-change-ledger';
import type { Chat, Message } from '../../types';
import {
  latestCompactionCheckpoint,
  transcriptRowsWithIds,
} from '../../../server/runner/compaction/index.js';

/** Hard ceiling on the summary text injected into the next chat's first prompt. */
export const MAX_FOLLOWUP_SUMMARY_CHARS = 6000;

/** User requests kept in the summary (oldest first). */
const MAX_SUMMARY_USER_REQUESTS = 6;
const MAX_SUMMARY_REQUEST_CHARS = 400;
const MAX_SUMMARY_ASSISTANT_CHARS = 1200;
const MAX_SUMMARY_FILES = 10;

/** Flatten any message content shape to plain text. */
function rowText(row: Message): string {
  const content = (row as { content?: unknown }).content;
  return extractMessageText({ content }).trim();
}

/** Collapse whitespace so one row cannot inject blank-line structure. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function buildUserRequests(rows: Message[]): string {
  const requests: string[] = [];
  for (let i = rows.length - 1; i >= 0 && requests.length < MAX_SUMMARY_USER_REQUESTS; i -= 1) {
    const row = rows[i];
    if (row?.role !== 'user') continue;
    const text = oneLine(rowText(row), MAX_SUMMARY_REQUEST_CHARS);
    if (text) requests.unshift(`- ${text}`);
  }
  return requests.join('\n');
}

function buildWhereItEnded(rows: Message[]): string {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.role !== 'assistant') continue;
    const text = rowText(row);
    if (text) return text.length > MAX_SUMMARY_ASSISTANT_CHARS
      ? `${text.slice(0, MAX_SUMMARY_ASSISTANT_CHARS)}…`
      : text;
  }
  return '';
}

function buildFilesChanged(chat: Chat): string {
  const files = getPerFileChangeSummary(chat).slice(0, MAX_SUMMARY_FILES);
  return files
    .map((file) => `- ${file.path} (+${file.additions}/-${file.deletions})`)
    .join('\n');
}

/**
 * Context summary of `chat` for the follow-up chat it spawns.
 * Always returns a string; truncates at {@link MAX_FOLLOWUP_SUMMARY_CHARS}.
 */
export function buildFollowupContextSummary(chat: Chat): string {
  const parts: string[] = [];

  const header = [
    chat.name?.trim() ? `Chat: ${chat.name.trim()}` : '',
    chat.workspacePath?.trim() ? `Workspace: ${chat.workspacePath.trim()}` : '',
  ].filter(Boolean);
  if (header.length) parts.push(header.join('\n'));

  let rows: Message[] = [];
  try {
    rows = transcriptRowsWithIds<Message>(chat.history).rows;
  } catch {
    rows = Array.isArray(chat.history) ? chat.history : [];
  }

  const folded = latestCompactionCheckpoint(chat.history)?.checkpoint.summary?.trim();
  if (folded) parts.push(`Earlier context (folded):\n${folded}`);

  const requests = buildUserRequests(rows);
  if (requests) parts.push(`User requests:\n${requests}`);

  const ended = buildWhereItEnded(rows);
  if (ended) parts.push(`Where it ended:\n${ended}`);

  const files = buildFilesChanged(chat);
  if (files) parts.push(`Files changed:\n${files}`);

  const summary = parts.join('\n\n').trim();
  return summary.length > MAX_FOLLOWUP_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_FOLLOWUP_SUMMARY_CHARS)}…`
    : summary;
}
