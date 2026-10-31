/**
 * Rebuild chat.codeChangeTotals from persisted tool history (no tool re-run).
 */

import { countLineChangeStats } from '../chat/prompts/text-diff';
import type {
  AssistantToolCallMessage,
  Chat,
  ChatCodeChangeTotals,
  CodeChangeStats,
  Message,
  SessionState,
  ToolCall,
  ToolResultMessage,
} from '../types';
import { normalizeCodeChangePayload } from './code-change-payload';
import {
  EMPTY_CODE_CHANGE_TOTALS,
  recomputeWorkspaceCodeChangeTotals,
} from './code-change-ledger';

const FILE_MUTATION_TOOLS = new Set([
  'save_file',
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
  'delete_path',
  'copy_file',
  'move_file',
]);

const GIT_SHA_RE = /\b[0-9a-f]{7,40}\b/i;

function addTotals(
  totals: ChatCodeChangeTotals,
  stats: CodeChangeStats | undefined,
): void {
  if (!stats || (stats.additions === 0 && stats.deletions === 0)) return;
  totals.additions += stats.additions;
  totals.deletions += stats.deletions;
}

function parseToolArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Best-effort stats from stored tool name + args (no server file read). */
function backfillStatsFromArgs(
  toolName: string,
  args: Record<string, unknown> | null,
): CodeChangeStats | undefined {
  if (!args) return undefined;

  if (toolName === 'save_file' && typeof args.content === 'string') {
    const path = typeof args.path === 'string' ? args.path : undefined;
    const stats = countLineChangeStats('', args.content);
    if (stats.additions === 0 && stats.deletions === 0) return undefined;
    return { ...stats, path, source: 'backfill' };
  }

  if (
    (toolName === 'append_file' || toolName === 'insert_at_line') &&
    typeof args.content === 'string'
  ) {
    const lines = args.content.replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => {
      if (i === a.length - 1 && l === '') return false;
      return true;
    });
    const path = typeof args.path === 'string' ? args.path : undefined;
    if (lines.length === 0) return undefined;
    return { additions: lines.length, deletions: 0, path, source: 'backfill' };
  }

  if (toolName === 'delete_path' && typeof args.path === 'string') {
    return undefined;
  }

  return undefined;
}

async function fetchGitCommitStats(sha: string): Promise<CodeChangeStats | undefined> {
  try {
    const res = await fetch('/api/tools/code-change-for-commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { codeChange?: unknown };
    const change = normalizeCodeChangePayload(body.codeChange);
    if (!change) return undefined;
    return { ...change, source: 'backfill' };
  } catch {
    return undefined;
  }
}

function extractGitShaFromResult(content: string): string | undefined {
  const match = content.match(GIT_SHA_RE);
  return match?.[0];
}

async function backfillFromToolPair(
  toolName: string,
  args: Record<string, unknown> | null,
  toolMsg: ToolResultMessage,
): Promise<CodeChangeStats | undefined> {
  const persisted = normalizeCodeChangePayload(toolMsg.codeChange);
  if (persisted) return persisted;

  if (toolName === 'git_commit') {
    const sha = extractGitShaFromResult(toolMsg.content);
    if (sha) return fetchGitCommitStats(sha);
    return undefined;
  }

  if (FILE_MUTATION_TOOLS.has(toolName)) {
    return backfillStatsFromArgs(toolName, args);
  }

  return undefined;
}

function buildToolCallMap(
  assistant: AssistantToolCallMessage,
): Map<string, { name: string; args: Record<string, unknown> | null }> {
  const map = new Map<string, { name: string; args: Record<string, unknown> | null }>();
  for (const tc of assistant.tool_calls ?? []) {
    const row = tc as ToolCall;
    map.set(row.id, {
      name: row.function.name,
      args: parseToolArgs(row.function.arguments),
    });
  }
  return map;
}

async function sumHistoryMessages(messages: Message[]): Promise<ChatCodeChangeTotals> {
  const totals: ChatCodeChangeTotals = { ...EMPTY_CODE_CHANGE_TOTALS };
  let pendingCalls = new Map<string, { name: string; args: Record<string, unknown> | null }>();

  for (const msg of messages) {
    if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls?.length) {
      pendingCalls = buildToolCallMap(msg as AssistantToolCallMessage);
      continue;
    }
    if (msg.role !== 'tool') continue;
    const toolMsg = msg as ToolResultMessage;
    const meta = pendingCalls.get(toolMsg.tool_call_id);
    if (!meta) continue;
    const stats = await backfillFromToolPair(meta.name, meta.args, toolMsg);
    addTotals(totals, stats);
  }

  return totals;
}

/**
 * Scan chat history (+ sub-agent messages) and set codeChangeTotals.
 * Does not mutate individual tool rows.
 */
export async function rebuildCodeChangeTotalsFromHistory(
  chat: Chat,
  options?: { force?: boolean },
): Promise<void> {
  // Canonical chats own these tool rows on the server. A viewer must not turn
  // reading their history into a stale session write (or estimate file edits).
  if (chat.chatCommandVersion === 1 || chat.agentConversation) return;
  if (!options?.force && chat.codeChangeBackfillAt && chat.codeChangeTotals) {
    return;
  }

  const totals = await sumHistoryMessages(chat.history ?? []);

  chat.codeChangeTotals =
    totals.additions > 0 || totals.deletions > 0 ? totals : { ...EMPTY_CODE_CHANGE_TOTALS };
  chat.codeChangeBackfillAt = Date.now();
}

/** Backfill chats missing totals after session hydrate. */
export async function runSessionCodeChangeBackfill(state: SessionState): Promise<void> {
  const workspaces = new Set<string>();
  for (const chat of state.chats) {
    if (chat.historyLoaded === false) {
      workspaces.add(chat.workspacePath ?? '');
      continue;
    }
    if (!chat.codeChangeBackfillAt && chat.history?.length) {
      await rebuildCodeChangeTotalsFromHistory(chat, { force: true });
    }
    workspaces.add(chat.workspacePath ?? '');
  }
  for (const ws of workspaces) {
    recomputeWorkspaceCodeChangeTotals(state, ws);
  }
}

/** On chat switch, backfill when totals were never computed. */
export async function ensureChatCodeChangeBackfillOnSwitch(chat: Chat): Promise<void> {
  if (chat.codeChangeBackfillAt && chat.codeChangeTotals) return;
  if (!chat.history?.length) return;
  await rebuildCodeChangeTotalsFromHistory(chat, { force: true });
}
