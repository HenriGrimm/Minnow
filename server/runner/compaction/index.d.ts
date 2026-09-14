import type { ApiMessage } from '../../../src/types.js';

export {
  COMPACTION_HEADER_PREFIX,
  COMPACTION_MERGE_MARK,
  hasCompactionSummary,
  isRealUserRow,
  isSummaryOnlyRow,
  segmentTurns,
} from './segment.js';
export { ELIDE_MIN_CHARS, elideToolRow, isElidedToolStub } from './elide.js';
export { ingestRows, isFailureOutput } from './extract.js';
export { defaultSummaryBudgetTokens, formatCompactionSummary, MAX_SUMMARY_BUDGET_TOKENS } from './format.js';
export { cloneCompactionState, emptyCompactionState } from './merge.js';
export { projectMessages, stripCompactionSummary, unmergeSummaryRow } from './project.js';
export { RECALL_HISTORY_TOOL_DEFINITION, RECALL_HISTORY_TOOL_NAME, runRecallHistory } from './recall.js';

export declare const DEFAULT_HIGH_WATER = 0.8;
export declare const DEFAULT_LOW_WATER = 0.5;
export declare const DEFAULT_RECENT_TURNS = 2;
export declare const DEFAULT_KEEP_TOOL_ROUNDS = 4;

export type CompactionTrigger = 'auto' | 'overflow' | 'manual';

export interface CompactionFile {
  path: string;
  /** `created` | `modified` | `deleted` | `moved` | `copied` | `read`, in that order. */
  ops: string[];
  additions: number;
  deletions: number;
  row: number | null;
}

export interface CompactionTurn {
  row: number | null;
  user: string;
  assistant: string;
  tools: Record<string, number>;
}

export interface CompactionProblem {
  key: string;
  text: string;
  row: number | null;
  status: 'open' | 'resolved';
  resolvedRow?: number | null;
}

/** Machine sections merged checkpoint to checkpoint. JSON-safe and deterministic. */
export interface CompactionState {
  version: 1;
  goal: string;
  scopeChanges: Array<{ row: number | null; text: string }>;
  notes: string[];
  files: CompactionFile[];
  commits: Array<{ hash: string; subject: string; row: number | null }>;
  subAgents: Array<{ type: string; task: string; outcome: string; row: number | null }>;
  turns: CompactionTurn[];
  problems: CompactionProblem[];
  todos: string[];
  status: { lastAssistant: string; lastFileAction: string; lastCommand: string };
  folded: { fromRow: number | null; throughRow: number | null; turns: number; rows: number };
}

/** A checkpoint as the runner holds it. Row ids are transcript-store ids (chat history indices in main chat). */
export interface CompactionCheckpoint {
  version: 1;
  /** Rows with id ≤ this are folded into `summary`. */
  foldThroughRow: number | null;
  /** Tool results with id ≤ this are sent as recall stubs. */
  elideThroughRow: number | null;
  /** Exact text sent to the model. */
  summary: string;
  state: CompactionState;
  trigger: CompactionTrigger;
  tokensBefore: number;
  tokensAfter: number;
}

/** The `compaction` payload persisted on a `context` history row. */
export interface PersistedCompaction {
  version: 1;
  foldThroughIndex: number | null;
  elideThroughIndex?: number | null;
  summary: string;
  state: CompactionState;
  trigger: CompactionTrigger;
  tokensBefore: number;
  tokensAfter: number;
}

export interface CompactionConfig {
  highWater: number;
  lowWater: number;
  recentTurns: number;
  summaryBudgetTokens: number;
  keepToolRounds: number;
}

export interface CompactMessagesInput {
  messages: ApiMessage[];
  /** Message-estimate ceiling; the compaction targets `limit × lowWater`. */
  limit: number;
  /** Model window, for the default summary budget. */
  window?: number | null;
  config?: CompactionConfig;
  prev?: CompactionCheckpoint | PersistedCompaction | null;
  trigger?: CompactionTrigger;
  /** Row id of a message; defaults to its index. */
  idOf?: (row: ApiMessage, index: number) => number | null | undefined;
  /** Unprojected row for an id (merged / elided rows are restored from it). */
  originalOf?: (id: number) => ApiMessage | undefined;
  /** `/compact` focus text, kept under [User notes]. */
  notes?: string | null;
}

export interface CompactMessagesResult {
  changed: boolean;
  messages: ApiMessage[];
  ids: Array<number | null>;
  /** Rows the projection created (summary, merged request, stubs). */
  synthetic: Set<ApiMessage>;
  checkpoint: CompactionCheckpoint | null;
  tokensBefore: number;
  tokensAfter: number;
  droppedTurns: number;
  droppedRounds: number;
  elidedRows: number;
  /** The projection still overflowed and the longest rows were cut (not persisted). */
  truncated: boolean;
}

export declare function resolveCompactionConfig(
  agentConfig: { minRecentTurns?: number; highWater?: number; lowWater?: number; summaryBudgetTokens?: number } | null | undefined,
  windowTokens: number | null | undefined,
): CompactionConfig;
export declare function normalizeCompactionCheckpoint(raw: unknown): CompactionCheckpoint | null;
export declare function toPersistedCompaction(checkpoint: CompactionCheckpoint): PersistedCompaction;
export declare function latestCompactionCheckpoint(
  history: ReadonlyArray<unknown>,
): { checkpoint: CompactionCheckpoint; index: number } | null;
export declare function transcriptRowsWithIds<T = ApiMessage>(history: ReadonlyArray<unknown>): { rows: T[]; ids: number[] };
export declare function compactMessages(input: CompactMessagesInput): CompactMessagesResult;
export declare function formatCompactionStatus(
  result: Pick<CompactMessagesResult, 'droppedTurns' | 'droppedRounds' | 'elidedRows' | 'truncated' | 'tokensBefore' | 'tokensAfter'>,
): string;
