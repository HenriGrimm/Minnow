import type { Message, ToolCall, ToolResultMessage } from '../types';
import { isToolResultFailure } from '../lib/tool-result-failure';
import { formatWorkDuration } from './transcript-turns';

/**
 * Deterministic tally for a collapsed chat turn ("Read 6 files · Ran 4 commands").
 * Reads persisted history only; the live DOM supplies nothing here, so it stays testable.
 * Spec: documentation/plans/compact-chat-turn-summary.md
 */

export type TurnSummaryKind =
  | 'read' | 'search' | 'edit' | 'run' | 'browse' | 'web' | 'agents' | 'asked' | 'other' | 'compacted' | 'thought';

export interface TurnSummaryEntry {
  kind: TurnSummaryKind;
  /** Distinct targets touched (calls, for families without a meaningful target). */
  count: number;
  text: string;
}

export interface TurnSummary {
  /** Visible entries in display order. */
  entries: TurnSummaryEntry[];
  /** Entries folded into "+N more". */
  overflow: number;
}

export interface SummarizeTurnOptions {
  /** History indices of checkpoints still drawn as the active divider. Defaults to the last one in history. */
  activeCompactions?: ReadonlySet<number>;
}

const MAX_ENTRIES = 4;

const ORDER: TurnSummaryKind[] = ['read', 'search', 'edit', 'run', 'browse', 'web', 'agents', 'asked', 'other', 'compacted', 'thought'];

/** `null` = bookkeeping calls that say nothing about the work. */
const KIND_BY_TOOL: Record<string, TurnSummaryKind | null> = {
  read_file: 'read', read_file_range: 'read', read_document: 'read', get_file_metadata: 'read', read_symbol: 'read',
  list_directory: 'search', find_files: 'search', grep: 'search', search_in_file: 'search', find_symbol: 'search',
  who_calls: 'search', repo_map: 'search', recall_history: 'search', brain_search: 'search',
  apply_patch: 'edit', save_file: 'edit', append_file: 'edit', insert_at_line: 'edit', replace_text_in_file: 'edit', delete_path: 'edit',
  move_file: 'edit', copy_file: 'edit', make_directory: 'edit', create_pdf: 'edit', create_word_document: 'edit',
  create_spreadsheet: 'edit',
  execute_command: 'run', start_background_command: 'run', run_javascript: 'run', run_python: 'run',
  web_search: 'web', wikipedia_search: 'web', fetch_web_content: 'web', rag_web_content: 'web',
  spawn_sub_agent: 'agents',
  ask_question: 'asked',
  todo_write: null, list_sub_agents: null, get_sub_agent_status: null,
};

function kindForTool(name: string, result: ToolResultMessage): TurnSummaryKind | null {
  if (name in KIND_BY_TOOL) return KIND_BY_TOOL[name];
  if (name.startsWith('browser_') || name === 'request_browser_origin_access') return 'browse';
  if (result.codeChange && changedPaths(result).length) return 'edit';
  return 'other';
}

function plural(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

function entryText(kind: TurnSummaryKind, count: number): string {
  switch (kind) {
    case 'read': return `Read ${plural(count, 'file')}`;
    case 'search': return plural(count, 'search', 'searches');
    case 'edit': return `Edited ${plural(count, 'file')}`;
    case 'run': return `Ran ${plural(count, 'command')}`;
    case 'browse': return plural(count, 'browser action');
    case 'web': return plural(count, 'web lookup');
    case 'agents': return `Spawned ${plural(count, 'agent')}`;
    case 'asked': return `Asked ${plural(count, 'question')}`;
    case 'other': return plural(count, 'other action');
    case 'compacted': return count === 1 ? 'Compacted' : `Compacted ${count}×`;
    case 'thought': return 'Thought';
  }
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function str(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function changedPaths(result: ToolResultMessage): string[] {
  const change = result.codeChange;
  if (!change) return [];
  if (change.path) return [change.path];
  return change.paths ?? [];
}

/** What the call acted on. Calls with the same key count once. */
function targetsFor(kind: TurnSummaryKind, call: ToolCall, args: Record<string, unknown>, result: ToolResultMessage): string[] {
  switch (kind) {
    case 'read':
    case 'edit': {
      const changed = changedPaths(result);
      if (changed.length) return changed.map(normalizePath);
      const path = str(args, 'path', 'source', 'from');
      return [path ? normalizePath(path) : call.id];
    }
    case 'search':
      return [`${call.function.name}:${str(args, 'pattern', 'query', 'symbol', 'name', 'path') ?? call.id}`];
    case 'run':
      return [str(args, 'command', 'code', 'script') ?? call.id];
    case 'web':
      return [str(args, 'query', 'url') ?? call.id];
    default:
      return [call.id];
  }
}

function isCompactionRow(msg: Message | undefined): boolean {
  return msg?.role === 'context' && (msg as { compaction?: { version?: number } }).compaction?.version === 1;
}

function questionCount(args: Record<string, unknown>): number {
  return Array.isArray(args.questions) && args.questions.length ? args.questions.length : 1;
}

/** Tally completed, successful calls in history rows `fork..end` (inclusive). */
export function summarizeTurn(
  history: readonly Message[],
  fork: number,
  end: number,
  options: SummarizeTurnOptions = {},
): TurnSummary {
  const results = new Map<string, ToolResultMessage>();
  for (let i = fork; i <= end; i++) {
    const msg = history[i];
    if (msg?.role === 'tool') results.set(msg.tool_call_id, msg);
  }

  let activeCompactions = options.activeCompactions;
  if (!activeCompactions) {
    let last = -1;
    for (let i = history.length - 1; i >= 0; i--) if (isCompactionRow(history[i])) { last = i; break; }
    activeCompactions = new Set([last]);
  }

  const tallies = new Map<TurnSummaryKind, { targets: Set<string>; weight: number }>();
  let compacted = 0;
  let thought = false;
  let thinkingMs = 0;
  for (let i = fork; i <= end; i++) {
    const msg = history[i];
    if (!msg) continue;
    if (isCompactionRow(msg)) {
      if (!activeCompactions.has(i)) compacted++;
      continue;
    }
    if (msg.role !== 'assistant') continue;
    if (msg.thinking?.some((segment) => segment.trim()) || msg.thinkingBlocks?.length || msg.thinkingDurationMs) thought = true;
    thinkingMs += msg.thinkingDurationMs ?? 0;
    if (!('tool_calls' in msg) || !msg.tool_calls?.length) continue;
    for (const call of msg.tool_calls) {
      const result = results.get(call.id);
      if (!result || isToolResultFailure(result.content)) continue;
      const kind = kindForTool(call.function.name, result);
      if (!kind) continue;
      const args = parseArgs(call);
      const tally = tallies.get(kind) ?? { targets: new Set<string>(), weight: 0 };
      for (const target of targetsFor(kind, call, args, result)) tally.targets.add(target);
      tally.weight += kind === 'asked' ? questionCount(args) : 1;
      tallies.set(kind, tally);
    }
  }

  const all: TurnSummaryEntry[] = [];
  for (const [kind, tally] of tallies) {
    const count = kind === 'asked' ? tally.weight : tally.targets.size;
    all.push({ kind, count, text: entryText(kind, count) });
  }
  if (compacted) all.push({ kind: 'compacted', count: compacted, text: entryText('compacted', compacted) });
  if (!tallies.size && thought) {
    all.push({ kind: 'thought', count: 1, text: thinkingMs > 0 ? `Thought for ${formatWorkDuration(thinkingMs)}` : 'Thought' });
  }
  all.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  const entries = all.slice(0, MAX_ENTRIES);
  return { entries, overflow: all.length - entries.length };
}

/** Plain-text form for accessible names. */
export function formatTurnSummary(summary: TurnSummary): string {
  const parts = summary.entries.map((entry) => entry.text);
  if (summary.overflow) parts.push(`+${summary.overflow} more`);
  return parts.join(' · ');
}

/** First sentence of assistant narration, markdown stripped, one line. */
export function narrationSentence(text: string, max = 120): string {
  const flat = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .trim();
  const firstLine = flat.split(/\n\s*\n|\n/).find((line) => line.trim()) ?? '';
  const sentence = /^.*?[.!?](?=\s|$)/.exec(firstLine.trim())?.[0] ?? firstLine.trim();
  const single = sentence.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
