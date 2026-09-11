/**
 * Shared data shapes for sessions, LM Studio API payloads, and UI metrics.
 * Mirrors structures in `documentation/archive/_extracted-app.js` (historical) / legacy `index.html`.
 */

import type { ModeId } from './chat/modes/types';
import type { ContextEnforcementPolicy } from './chat/context-budget';
import type { SuperPlanChatSummary } from './chat/super-plan/types';
import type { PinnedSkillState } from './skills/types';
import type { ChatTokenLedger } from './usage/types';
import type {
  SubAgentBudgetEvent,
  SubAgentStructuredOutcome,
} from './agents/sub-agent-structured-outcome';
import type { ThinkingResolvedMode, ThinkingTriState } from './agents/thinking-types';

// ── Messages ─────────────────────────────────────────────────────────────────

/** Per-model / per-chat reasoning effort level for header dropdown and send path. */
export type ReasoningEffortOption = 'off' | 'on' | 'low' | 'medium' | 'high' | 'max';

/** Persisted session blob schema version (`minnow-sessions-v1` key; version inside JSON). */
export const SESSION_SCHEMA_VERSION = 6 as const;

export type SessionSchemaVersion = typeof SESSION_SCHEMA_VERSION;

/** Roles stored in chat history (UI + localStorage). */
export type ChatRole = 'user' | 'assistant' | 'tool';

/** Roles sent to LM Studio chat completions (includes ephemeral system prompt). */
export type ApiChatRole = 'system' | ChatRole;

/** OpenAI-compatible function tool invocation (complete, after streaming finalize). */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** One fragment of a streaming `tool_calls` delta (indexed by `index`). */
export interface ChatCompletionToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** Token usage from LM Studio completion chunks or non-streaming responses. */
export interface Usage {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Inference timing and finish metadata for a single assistant turn. */
export interface Stats {
  tokens_per_second?: number;
  time_to_first_token?: number;
  generation_time?: number;
  stop_reason?: string;
  /** llama.cpp prefill throughput (`timings.prompt_per_second`). */
  prompt_tokens_per_second?: number;
  /**
   * Speculative-decoding acceptance, 0–1, from `timings.draft_n_accepted / draft_n`.
   * The only honest way to tell whether spec decoding is earning its memory.
   */
  draft_acceptance?: number;
}

/**
 * llama.cpp `timings`, present on every chunk when `timings_per_token` is set.
 * `draft_n` / `draft_n_accepted` appear only when `--spec-type` is not `none`.
 */
export interface LlamaTimings {
  cache_n?: number;
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_token_ms?: number | null;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_token_ms?: number | null;
  predicted_per_second?: number;
  draft_n?: number;
  draft_n_accepted?: number;
}

/**
 * llama.cpp prefill progress, emitted when the request carries `return_progress`.
 * `total` is present from the first chunk, so this is a real fraction — unlike
 * `/slots`, which reports the running count as both the part and the whole.
 * `cache` is the prefix served from the prompt cache, which is why `processed` can
 * start near `total` on a repeat prompt.
 */
export interface LlamaPromptProgress {
  total: number;
  cache: number;
  processed: number;
  time_ms: number;
}

/**
 * Pixels the user attached to a message, persisted so they survive a reload and
 * stay visible to the model on later turns. `content` still carries the matching
 * `[image: name]` placeholder for the transcript and for text-only models.
 */
export interface UserImageAttachment {
  /** Attachment name — matches the `[image: name]` placeholder in `content`. */
  name: string;
  /** `data:image/…;base64,…` payload sent as an `image_url` content part. */
  dataUrl: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
  /** Attached image bytes (drag-drop, paste, Design Mode crop). Vision models only. */
  images?: UserImageAttachment[];
  /** True when the row was injected via steer consume (interrupt-and-steer). */
  steer?: boolean;
  /** True when the row records a satisfied /goal completion condition. */
  goalAchieved?: boolean;
  /** Super Plan controller stage prompt — hidden from the chat transcript UI. */
  superPlanStage?: string;
  /** Programmatic resume prompt (sub-agent completion, onboarding kickoff, etc.). */
  hiddenFromTranscript?: boolean;
}

/** One build-agent progress item (todo_write). */
export interface ChatTodo {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Persistent /goal loop state on a chat (Claude Code–style completion condition). */
export interface ActiveGoalState {
  /** Completion condition text (max 4000 chars). */
  conditionText: string;
  startedAt: number;
  /** Evaluator passes after each goal-driven turn (display only). */
  turnCount: number;
  /** Ledger total at goal start — for "tokens since goal" display. */
  tokenBaseline: number;
  /** Evaluator rationale from the most recent pass. */
  lastReason?: string;
  /** Set when the evaluator confirms the condition; cleared via /goal clear. */
  achieved?: boolean;
}

/**
 * Persistent /loop timer on a chat (session-scoped repeating prompt).
 * Distinct from {@link ActiveGoalState} and from the chat send path (`runTurn`).
 */
export interface ActiveLoopState {
  /** Per-chat counter for loop panel stop controls. */
  id: number;
  /** Raw prompt including slash skills; empty string = maintenance loop. */
  promptText: string;
  kind: 'interval' | 'auto';
  /** Fixed interval when kind is interval. */
  intervalMs?: number;
  /** Self-paced delay when kind is auto; clamped [60_000, 3_600_000]. */
  currentDelayMs?: number;
  /** Epoch ms of next fire (persisted so reload/sleep survive). */
  dueAt: number;
  createdAt: number;
  /** createdAt + 7 days. */
  expiresAt: number;
  runCount: number;
  /** Auto-pacing comparison digest of last assistant output. */
  lastOutputDigest?: string;
  /** When true, ticker skips until resumed from the loop panel. */
  paused?: boolean;
  /** Ms until next fire, frozen while paused. */
  pausedRemainingMs?: number;
}

export type AnthropicThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/** Assistant history entry; may include per-bubble metric chips when restored. */
export interface AssistantMessage {
  thinkingBlocks?: AnthropicThinkingBlock[];
  role: 'assistant';
  content: string;
  /** Ordered reasoning segments from LM Studio (when Developer reasoning split is on). */
  thinking?: string[];
  /** Accumulated reasoning-active wall time for this reply (ms), not TTFT. */
  thinkingDurationMs?: number;
  /** User stopped generation before the model finished. */
  stopped?: boolean;
  /** Turn errored mid-stream; this row is the partial output that was kept. */
  failed?: true;
  /** Model hit max_tokens; user can continue the reply. */
  truncated?: true;
  stats?: Stats;
  usage?: Usage;
}

/** Assistant turn that requested one or more tool calls (`finish_reason: tool_calls`). */
export interface AssistantToolCallMessage {
  thinkingBlocks?: AnthropicThinkingBlock[];
  role: 'assistant';
  content: string | null;
  tool_calls: ToolCall[];
  /** Reasoning segments shown in UI; replayed to Anthropic when signature is set. */
  thinking?: string[];
  /** Accumulated reasoning-active wall time for this tool-call reply (ms), not TTFT. */
  thinkingDurationMs?: number;
  /**
   * Anthropic extended-thinking signature for this turn (required to replay tool_use
   * blocks when thinking stays enabled on follow-up Messages API requests.
   */
  thinkingSignature?: string;
  /** User stopped generation while this row's tool batch was still running. */
  stopped?: boolean;
  stats?: Stats;
  usage?: Usage;
}

/** Inline image attachment from server tools (e.g. browser_screenshot). */
export interface ToolImageAttachment {
  type: 'image';
  url: string;
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  alt?: string;
  /** PNG data URL so VLMs can see the pixels (the `url` path is UI-only). */
  dataUrl?: string;
}

/** How line stats were produced (UI tooltips / backfill accuracy). */
export type CodeChangeSource =
  | 'file-tool'
  | 'git-commit'
  | 'command-snapshot'
  | 'command-heuristic'
  | 'backfill';

/** Unified diff line for tool expando (matches prompt diff renderer). */
export interface CodeChangeDiffLine {
  type: 'unchanged' | 'add' | 'remove';
  text: string;
}

/** Per mutation tool: line adds/deletes (GitHub-style) plus optional diff body. */
export interface CodeChangeStats {
  additions: number;
  deletions: number;
  path?: string;
  paths?: string[];
  source?: CodeChangeSource;
  diffLines?: CodeChangeDiffLine[];
  diffTruncated?: boolean;
}

/** Cumulative line stats for one chat (file-write tools only). */
export interface ChatCodeChangeTotals {
  additions: number;
  deletions: number;
}

/** Tool execution result correlated to `tool_call_id` from the prior assistant turn. */
export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
  attachments?: ToolImageAttachment[];
  codeChange?: CodeChangeStats;
}

/** Result returned from executeTool (text + optional UI attachments). */
export interface ToolExecutionResult {
  content: string;
  attachments?: ToolImageAttachment[];
  codeChange?: CodeChangeStats;
}

/** Persisted context trim / compress notice (not sent to the model). */
export interface ContextNoticeMessage {
  role: 'context';
  policy: ContextEnforcementPolicy;
  droppedTurns: number;
  /** Text sent to the model inside the summary user row, if any. */
  summaryText?: string;
  createdAt: number;
}

export type PromptInjectionKind = 'brain-notes' | 'code-map' | 'context-documents';

/** Persisted Brain / code-map injection notice (not sent to the model). */
export interface InjectionNoticeMessage {
  role: 'injection';
  kind: PromptInjectionKind;
  /** Retrieved block as stored for the transcript (bounded; see `truncated`). */
  body: string;
  /** True when `body` was cut at the storage cap — replay must use `Chat.injectedContext`. */
  truncated?: boolean;
  createdAt: number;
}

export type Message =
  | UserMessage
  | AssistantMessage
  | AssistantToolCallMessage
  | ToolResultMessage
  | ContextNoticeMessage
  | InjectionNoticeMessage;

// ── API payloads ─────────────────────────────────────────────────────────────

/** Multimodal user/assistant payload part (attachments use in later waves). */
export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

/** API message body: plain string or multimodal parts. */
export type ApiMessageContent = string | ContentPart[] | null;

export interface ApiSystemMessage {
  role: 'system';
  content: string;
}

export interface ApiUserMessage {
  role: 'user';
  content: ApiMessageContent;
  /**
   * Ephemeral screenshot bytes after a tool result (not a history row).
   * Stripped before the provider POST.
   */
  toolImageFollowUp?: true;
}

export interface ApiAssistantMessage {
  reasoning_blocks?: AnthropicThinkingBlock[];
  role: 'assistant';
  content: ApiMessageContent;
  tool_calls?: ToolCall[];
  /** Outbound reasoning text for Anthropic tool-loop replay (not persisted in session). */
  reasoning?: string;
  /** DeepSeek thinking-mode replay on tool-loop turns (OpenCode Go / api.deepseek.com). */
  reasoning_content?: string;
  /** Anthropic thinking signature paired with `reasoning` for Messages API replay. */
  reasoning_signature?: string;
}

export interface ApiToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

/**
 * Flat snapshot of the last completed assistant turn for sidebar preview
 * and the bottom stats strip when switching chats.
 */
export interface LastStats {
  tokens_per_second: number | null;
  time_to_first_token: number | null;
  generation_time: number | null;
  stop_reason: string | null;
  total_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

/** Merged arch / quant / context shown in the stats strip (`resolveModelInfo`). */
export interface ModelInfo {
  arch?: string;
  quant?: string;
  context_length?: number;
}

/** @deprecated Migrated to chat.expertId — hydrated for legacy sessions only. */
export interface ExpertSelection {
  mode: 'auto' | 'manual';
  expertId: string | null;
}

/** Re-export for chat runtime snapshot typing. */
export type { ExpertRuntimeSnapshot } from './chat/experts/types';

// ── Terminal agents ──────────────────────────────────────────────────────────

/** One completed terminal run persisted on the chat (Step 10). */
export interface TerminalRunRecord {
  id: string;
  command: string;
  cwd: string;
  source: 'user' | 'agent';
  toolCallId?: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  /** Path relative to ~/.minnow (e.g. logs/terminal/<runId>.log). */
  logPath: string;
}

/** Lifecycle values persisted for sub-agent runs on the parent chat. */
export type PersistedSubAgentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Snapshot of a sub-agent run saved on the parent chat when the run reaches a
 * terminal state (for drawer restore after session reload).
 */
export interface PersistedSubAgentRun {
  runId: string;
  parentTurnId: string;
  /** Parent assistant tool_call id when known (optional). */
  parentToolCallId?: string;
  type: string;
  task: string;
  status: PersistedSubAgentStatus;
  summary: string;
  /** Structured handoff for drawer restore (MIN-43). */
  structuredOutcome?: SubAgentStructuredOutcome;
  budgetEvents?: SubAgentBudgetEvent[];
  error?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  toolTurns: number;
  /** Transcript (ApiMessage-shaped JSON); capped when persisting. */
  messages: unknown[];
  /** Board category when spawned from Orchestrate board (restore drawer/cards). */
  category?: BoardCategory;
  /** Linked board task id (e.g. W1-A). */
  boardTaskId?: string | null;
}

// ── Boards ───────────────────────────────────────────────────────────────────

/** Sub-agent category for board agent grid styling. */
export type BoardCategory = 'build' | 'fix' | 'test' | 'research';

/**
 * Leftover V1 board blob persisted on {@link ChatGroup}.
 * The V1 engine is gone; V2 boards live in `server/orchestrator/` and do not
 * write this. Kept so old sessions still hydrate. Autonomy is the V2 pair
 * (MIN-718): {@link OrchestrateBoardState.status} plus {@link OrchestrateBoardState.maxConcurrentTasks}.
 */
export interface OrchestrateBoardState {
  planPath: string;
  tasks: Array<{
    id: string;
    title: string;
    wave: number | string;
    category: BoardCategory;
    status: string;
    chatId?: string;
    testChatId?: string;
    fixerChatId?: string;
    fixerKind?: 'merge' | 'env';
    worktreePath?: string;
    error?: string;
    dependsOn?: string[];
    buildSpec?: string;
    testSpec?: string;
  }>;
  waves: Array<{
    id: number | string;
    status?: string;
    taskCount?: number;
    completeCount?: number;
    collapsed?: boolean;
  }>;
  startedAt: number;
  lastUpdatedAt: number;
  timerAccumulatedMs?: number;
  timerSegmentStartedAt?: number;
  activeParentTurnId?: string;
  /** Leftover concurrency integer. Sequential hydrates as 1. */
  maxConcurrentTasks?: number;
  /**
   * Leftover Running / Stopped. AFK and auto-run hydrate as running;
   * Manual and an explicit user stop hydrate as stopped.
   */
  status?: 'running' | 'stopped';
  modelProviderId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffortOption;
  thinkingMode?: ThinkingTriState;
  worktreeSlug?: string;
  skipPerTaskTesting?: boolean;
  isolationMode?: 'off' | 'per-task' | 'per-wave' | 'per-board';
  shellSandboxMode?: 'off' | 'prefer' | 'require';
  integrationBranch?: string;
  isolationBaseRef?: string;
  completionShownAt?: number;
  terminalBlocked?: boolean;
  wrapUpPending?: boolean;
  dashboardDismissed?: boolean;
  integrationLandedAt?: number;
  worktreesClearedAt?: number;
  finishReport?: string;
  finalTest?: {
    status: 'pending' | 'in_progress' | 'passed' | 'failed';
    chatId?: string;
    attempts?: number;
    recordedVerdict?: 'pass' | 'fail';
    failingTaskIds?: string[];
    summary?: string;
    runInstructions?: BoardRunInstructions;
  };
}

/** One leftover V1 task row on {@link OrchestrateBoardState} (session hydrate only). */
export type LeftoverBoardTask = OrchestrateBoardState['tasks'][number];

/** Verified project commands reported by the final integration tester. */
export interface BoardRunInstructions {
  install?: string;
  start?: string;
  test?: string;
  notes?: string;
}

/** Collapsible sidebar folder for chats in a workspace. */
export interface ChatGroup {
  id: string;
  name: string;
  /** Normalized absolute workspace root; groups are per-workspace. */
  workspacePath: string;
  collapsed: boolean;
  order: number;
  createdAt: number;
  /** Kanban + waves for Orchestrate plans owned by this folder. */
  orchestrateBoard?: OrchestrateBoardState;
  /** Workspace-relative plan path (documentation/plans/*.md). */
  orchestratePlanPath?: string;
  /** Main-column chat vs board rendering for this folder. */
  viewMode?: 'chat' | 'board';
  /** Leftover V1 planner chat id (hydrate only — V2 boards have no planner chat). */
  plannerChatId?: string;
}

// ── Bugs ─────────────────────────────────────────────────────────────────────

/** Bug tracker workflow column (MIN-16). */
export type BugColumn =
  | 'reported'
  | 'investigating'
  | 'planned'
  | 'fixing'
  | 'complete';

/** Bug severity for triage. */
export type BugSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Legacy bug-card shape (MIN-16).
 * Kept for one-time migration from `bugs/state.json` / `minnow-bugs-v1`
 * and for `bug_*` tool aliases that project Issues → this shape.
 */
export interface BugCard {
  id: string;
  title: string;
  description: string;
  severity: BugSeverity;
  column: BugColumn;
  /** Workspace folder this bug belongs to. */
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  /** Investigation / fix chat (created on Investigate). */
  chatId?: string;
  /** Debugger or planner summary notes shown on the card. */
  notes?: string;
  /** Workspace-relative fix plan (documentation/plans/bugs/<id>.md). */
  planPath?: string;
  investigateRunId?: string;
  planRunId?: string;
  /** Linked orchestrate fix run (after Start fix). */
  fixRunId?: string;
}

/** Persisted legacy bugs file shape (`~/.minnow/bugs/state.json`). */
export type BugsState = {
  version: 1;
  bugs: BugCard[];
};

/** @deprecated Legacy per-chat board; migrated to bugs/state.json then Issues. */
export interface BugBoardState {
  bugs: BugCard[];
  startedAt: number;
  lastUpdatedAt: number;
}

// ── Issues ───────────────────────────────────────────────────────────────────

/** Issues app card kind (MIN-261). Values come from Settings → Issues taxonomy. */
export type IssueType = string;

/** Issues workflow status (MIN-261). Values come from Settings → Issues taxonomy. */
export type IssueStatus = string;

/** Issues priority (MIN-261). Values come from Settings → Issues taxonomy. */
export type IssuePriority = string;

/** Well-known default type ids (seed taxonomy). */
export type DefaultIssueType = 'bug' | 'task' | 'idea' | 'note' | 'feature' | 'improvement';

/** Well-known default status ids (seed taxonomy). */
export type DefaultIssueStatus =
  | 'triage'
  | 'backlog'
  | 'todo'
  | 'planned'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'canceled';

/** Well-known default priority ids (seed taxonomy). */
export type DefaultIssuePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

/** File/line link; click opens the editor at the range. */
export interface IssueCodeRef {
  path: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
  note?: string;
}

/** Git/GitHub linkage chip on an issue. */
export interface IssueGitLink {
  kind: 'commit' | 'branch' | 'pr' | 'github-issue';
  ref: string;
  url?: string;
  title?: string;
  addedAt: number;
}

/** Typed relation between two issues (bidirectional via inverse kind on the target). */
export type IssueRelationKind =
  | 'related'
  | 'blocks'
  | 'blocked-by'
  | 'duplicate-of'
  | 'parent'
  | 'sub-issue';

/** Link from one issue card to another with a relation kind. */
export interface IssueIssueRef {
  issueId: string;
  kind: IssueRelationKind;
  note?: string;
  addedAt: number;
}

/** Where an issue came from — drives the Triage lane and its badge. */
export type IssueSource = 'user' | 'agent' | 'crash' | 'github';

/** Who is accountable for an issue. One human slot; agents live in {@link IssueAgentRun}. */
export interface IssueAssignee {
  /** Stable actor id. `me` is the local single-player user until multiplayer exists. */
  id: string;
  /** Display name captured at assign time so a removed teammate still renders. */
  label?: string;
  assignedAt: number;
}

/**
 * Live state of the work agent running on an issue.
 *
 * Deliberately narrow: Issues renders assigned / running / asked / PR / failed
 * and nothing about waves, slots, or integration branches. The Orchestrator
 * board remains the engine and the only place its internals are shown.
 */
export type IssueAgentPhase =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'review'
  | 'failed'
  | 'canceled'
  | 'done';

/** The `agent` slot on a card: which agent, what it is doing, and where its work lives. */
export interface IssueAgentRun {
  /** Work agent id from the agents registry. */
  agentId: string;
  phase: IssueAgentPhase;
  /** Human-readable current step ("Running tests"), not a derived guess. */
  step?: string;
  startedAt: number;
  updatedAt: number;
  /** Single-task board group backing this run. */
  boardGroupId?: string;
  boardTaskId?: string;
  /** Agent chat, so "answer from the row" can resume the right thread. */
  chatId?: string;
  /** Isolation for the run. */
  worktreePath?: string;
  branch?: string;
  /** Set once the agent has opened its PR and stopped. */
  prNumber?: number;
  prUrl?: string;
  /** Pending `ask_question` id, surfaced on the row as "needs you". */
  pendingQuestionId?: string;
  /** Plain-words failure reason; `envBlocked` separates broken env from broken code. */
  error?: string;
  envBlocked?: boolean;
}

/** One entry on an issue's comment timeline (appended, never overwritten). */
export interface IssueComment {
  id: string;
  authorKind: 'user' | 'agent' | 'system';
  /** Agent id or user label; absent for system entries. */
  author?: string;
  /** Markdown, same constrained subset as `IssueCard.description`. */
  body: string;
  createdAt: number;
  editedAt?: number;
}

/** Structured activity record (status changes, assignments, agent milestones). */
export interface IssueActivityEntry {
  id: string;
  kind: string;
  at: number;
  actorKind?: 'user' | 'agent' | 'system';
  actor?: string;
  /** Small kind-specific payload (`{ from, to }` for a status change). */
  data?: Record<string, string | number | boolean | null>;
}

/** File or image stored alongside the issue. */
export interface IssueAttachment {
  id: string;
  name: string;
  /** Path under ~/.minnow/issues/attachments; agents may read it. */
  path: string;
  mime?: string;
  bytes?: number;
  addedAt: number;
}

/** Grouping container with a progress rollup (deliberately not an Orchestrator board). */
export interface IssueProject {
  id: string;
  name: string;
  description?: string;
  color?: string;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Named filter tab across the top of the list. */
export interface IssueSavedView {
  id: string;
  name: string;
  /** Serialized filter state; shape owned by the list, not the store. */
  filters: Record<string, string | string[] | boolean | null>;
  groupBy?: string;
  order: number;
  /** Built-in views ship with the app and cannot be deleted. */
  builtIn?: boolean;
}

/**
 * Per-issue cap on {@link IssueActivityEntry} retained in state.json.
 *
 * Phase 0 decision: activity stays in the single debounced state.json rather
 * than moving to an append-only side file. Nothing writes activity yet, and a
 * second file with its own write path is the shape that broke MIN-354 v1.
 * The cap keeps the blob bounded; revisit in Phase 4 when agents start writing.
 */
export const ISSUE_ACTIVITY_CAP = 50;

/**
 * Fixed issue-label swatches. Catalog colors, not metric success/warning/danger.
 * Keep in sync with `ISSUE_LABEL_SWATCH_IDS` in `src/issues/label-catalog.ts`.
 */
export type IssueLabelSwatchId =
  | 'clay'
  | 'apricot'
  | 'pollen'
  | 'moss'
  | 'kelp'
  | 'tide'
  | 'dusk'
  | 'fig'
  | 'blush'
  | 'pebble';

/** One named label and its workspace color. */
export interface IssueLabelCatalogEntry {
  /** Canonical name (first-seen casing). */
  name: string;
  color: IssueLabelSwatchId;
}

/** One issue card in the Issues app (Linear-style tracker). */
export interface IssueCard {
  id: string;
  type: IssueType;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  labels: string[];
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  codeRefs?: IssueCodeRef[];
  gitLinks?: IssueGitLink[];
  issueRefs?: IssueIssueRef[];
  chatIds?: string[];
  planPath?: string;
  boardChatId?: string;
  investigateRunId?: string;
  planRunId?: string;
  notes?: string;
  /** Preserved bug id after bugs→issues migration. */
  legacyBugId?: string;
  /** Preserved bug severity after migration (shown as a label). */
  severity?: BugSeverity;

  /** Accountable human. Separate from {@link agent} so a run never steals ownership. */
  assignee?: IssueAssignee;
  /** Work agent slot and its live state. */
  agent?: IssueAgentRun;
  /** Parent issue id; hierarchy is one level deep by design. */
  parentId?: string;
  /** Lexicographic manual order key within a group (Alt+↑/↓). */
  rank?: string;
  projectId?: string;
  comments?: IssueComment[];
  /** Capped at {@link ISSUE_ACTIVITY_CAP}, oldest dropped first. */
  activity?: IssueActivityEntry[];
  attachments?: IssueAttachment[];
  source?: IssueSource;
  /** Set when the issue left the Triage lane (accepted or declined). */
  triagedAt?: number;
  /** Leftover per-issue flag from retired Link + push. Ignored by sync. */
  githubSync?: boolean;
  /** Remote identity and the watermark conflict detection compares against. */
  github?: IssueGithubLink;
}

/**
 * The remote half of a synced issue.
 *
 * `syncedAt` is the watermark, and it is what makes mirror mode safe: an edit
 * on either side after this timestamp is a change, and a change on *both*
 * sides is a conflict the user resolves rather than a race the last writer
 * wins. Storing only "is it synced" would make that undecidable.
 */
export interface IssueGithubLink {
  number: number;
  url: string;
  /** `owner/repo` at the time of linking, so a moved remote is visible. */
  repo?: string;
  /** Local and remote were last known equal at this moment. */
  syncedAt: number;
  /** Remote `updatedAt` observed at the last sync. */
  remoteUpdatedAt?: number;
  /** Local `updatedAt` observed at the last sync. */
  localUpdatedAt?: number;
  /** Last local edit to title, description, labels, or closed state (excludes metadata). */
  localChangedAt?: number;
}

/** Per-workspace project key + counter for KEY-n allocation. */
export interface IssuesWorkspaceIdConfig {
  projectKey: string;
  nextId: number;
}

/**
 * Value always written to `version` on disk.
 *
 * Frozen at the highest revision every already-shipped reader can parse. Those
 * readers reset to an empty state on an unrecognized `version` — so writing a 3
 * there would erase every issue for anyone who rolls a release back. The real
 * revision travels in {@link IssuesState.schemaRevision}, which old readers
 * ignore. They lose fields they never modelled; they do not lose issues.
 */
export const ISSUES_COMPAT_VERSION = 2;

/** Current schema revision for ~/.minnow/issues/state.json. */
export const ISSUES_SCHEMA_VERSION = 3;

/**
 * Persisted Issues app state under ~/.minnow/issues/state.json.
 *
 * Both revision fields are `number`, not literal unions. Pinning them to the
 * known values is what let both parsers treat "newer than me" as "corrupt" and
 * reset to empty — the data-wipe shape that killed MIN-354 v1. Readers must
 * tolerate any revision and preserve what they do not understand.
 */
export interface IssuesState {
  /** Compatibility floor; see {@link ISSUES_COMPAT_VERSION}. */
  version: number;
  /** Real schema revision. Absent on files written before v3. */
  schemaRevision?: number;
  /** Legacy global counter for ISS-n (diagnostics / migration). */
  nextId: number;
  issues: IssueCard[];
  /** Key: normalizeWorkspacePath(absolute path). */
  workspaces?: Record<string, IssuesWorkspaceIdConfig>;
  projects?: IssueProject[];
  views?: IssueSavedView[];
  /** Workspace-wide name → color map. Same name is the same color on every issue. */
  labelCatalog?: IssueLabelCatalogEntry[];
}

/** Effective schema revision of a stored blob (`schemaRevision`, else `version`). */
export function issuesSchemaRevisionOf(raw: {
  version?: unknown;
  schemaRevision?: unknown;
}): number {
  const explicit = raw.schemaRevision;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 1) {
    return Math.floor(explicit);
  }
  const legacy = raw.version;
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 1) {
    return Math.floor(legacy);
  }
  return ISSUES_SCHEMA_VERSION;
}

// ── Turns ────────────────────────────────────────────────────────────────────

/** Stable id for one execution from a fork point (branch). */
export type TurnRunId = string;

/** Snapshot of inputs needed to replay or fork without re-reading UI globals. */
export interface TurnSnapshot {
  /** User row index at fork time (anchor). */
  forkHistoryIndex: number;
  /** Stored user content (includes skill tags). */
  userContent: string;
  /** Parsed skill id when present. */
  skillId: string | null;
  providerId: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  /** Resolved thinking on/off frozen for replay. */
  thinkingMode: ThinkingResolvedMode;
  /** Resolved reasoning effort frozen for replay (when dropdown applies). */
  reasoningEffort?: ReasoningEffortOption;
  modeId: ModeId;
  workAgentId: string | null;
  workAgentAuto: boolean;
  expertSelection?: ExpertSelection;
  uiDesignerMode?: 'plan' | 'implement';
  /** Composed system string from resolveOutboundSystemMessages. */
  composedSystemPrompt: string;
  userRulesContent?: string;
  /** Ordered tool function names enabled for this turn. */
  enabledToolNames: string[];
  /** @deprecated Ignored; retained for replay of older turn snapshots. */
  maxToolTurns?: number;
  /** SHA-256 hex of JSON.stringify(apiMessages prefix through fork). */
  historyPrefixHash: string;
  orchestratePlanPath?: string;
}

export type TurnRunStatus =
  | 'running'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'superseded';

/** Why a turn run ended with status `stopped` (user Stop vs timeout vs supervision). */
export type ChatStopReason = 'user' | 'timeout' | 'system';

/** One turn execution from a user-message fork point. */
export interface TurnRunRecord {
  runId: TurnRunId;
  /** One branch id per run (picker labels Branch 1, 2, …). */
  branchId: string;
  forkHistoryIndex: number;
  parentRunId?: TurnRunId;
  status: TurnRunStatus;
  createdAt: number;
  endedAt?: number;
  snapshot: TurnSnapshot;
  /** Inclusive indices in chat.history for assistant/tool rows from this run. */
  outputHistoryStart?: number;
  outputHistoryEnd?: number;
  /** Copy of assistant/tool rows produced by this run (for branch switch after truncate). */
  outputMessages?: Message[];
  generationIds?: string[];
  /** Sub-agent correlation id for this main turn. */
  parentTurnId?: string;
  /** Set when {@link status} is `stopped` — who/what aborted the turn. */
  stopReason?: ChatStopReason;
  /** Set when the turn ended because it hit a hard cap rather than finishing normally. */
  endReason?: 'max_tool_turns';
  /** User-facing failure detail when {@link status} is `failed` (survives history rollback). */
  errorMessage?: string;
  /**
   * MIN-409: dangling git commit of the working tree before this turn started.
   * Used by Undo to restore files without moving HEAD.
   */
  preTurnSnapshotSha?: string;
  /** Dangling git commit of the working tree after the turn settled. */
  postTurnSnapshotSha?: string;
  /** HEAD tip when the pre-turn snapshot was taken (divergence guard). */
  headShaAtTurn?: string;
  /** Absolute cwd used for snapshots (workspace root tools mutate). */
  snapshotCwd?: string;
}

// ── Chat ─────────────────────────────────────────────────────────────────────

/** Expert thread or legacy Expert Lab session (hidden from main sidebar). */
export type ChatKind = 'expert' | 'expert-lab';

/** Follow-up message queued while the agent turn is in progress (MIN-200). */
export interface QueuedComposerMessage {
  id: string;
  text: string;
  createdAt: number;
}

/**
 * Sidebar / boot row for a chat without message bodies (Phase C.1/C.2).
 * Hot columns + denormalized `messageCount` / `lastMessagePreview`, plus optional
 * cold `meta_json` fields and non-message children (runs, loops, …) for boot.
 * Do not make {@link Chat.history} optional — inflate with `history: []` + `historyLoaded: false`.
 */
export type ChatSummary = Omit<Chat, 'history' | 'historyLoaded' | 'lastStats' | 'modelInfo'> & {
  /** Denormalized COUNT of messages rows for this chat. */
  messageCount: number;
  /** Denormalized preview of the last message body (truncated). */
  lastMessagePreview: string;
  /** Sidebar order column (`chats.sort_index`). */
  sortIndex?: number;
  /** SHA-256 digest of message row hashes (skip sync when unchanged). */
  historyDigest?: string;
  lastStats?: LastStats | null;
  modelInfo?: ModelInfo;
};

/** Session blob from GET /api/config/sessions/summaries (chats omit `history`). */
export interface SessionSummariesState {
  version: SessionSchemaVersion;
  /** Monotonic store write counter, echoed back on write for conflict detection. */
  revision?: number;
  activeId: string | null;
  sidebarCollapsed: boolean;
  sidebarWidth?: number;
  chats: ChatSummary[];
  groups?: ChatGroup[];
  activeBoardGroupId?: string;
  lastBoardGroupId?: string;
  lastActiveChatIdByWorkspace?: Record<string, string>;
  lastActiveChatIdByApp?: Record<string, string>;
  codeChangeTotalsByWorkspace?: Record<string, ChatCodeChangeTotals>;
}

export interface Chat {
  id: string;
  name: string;
  /** expert = per-expert thread; expert-lab = legacy hidden session (migrated away). */
  kind?: ChatKind;
  /**
   * True when this chat holds background work (issue workflow, dev-server
   * Detect, scheduled run) rather than a user conversation (MIN-637). Background
   * chats are created without ever taking `activeId`, so they announce
   * themselves through the sidebar unread dot instead of stealing focus.
   */
  background?: true;
  /** Stable work-source id ({@link background} chats) — issue id, server id, schedule id. */
  backgroundKey?: string;
  /** Specialist id when kind === 'expert'. */
  expertId?: string;
  /** Normalized absolute workspace root at chat creation; '' = unassigned (legacy). */
  workspacePath: string;
  modelId: string;
  /** Optional per-chat provider override (Step 03). */
  providerId?: string;
  /** Operating mode for prompt + tool policy (Step 05); default build. */
  modeId?: ModeId;
  /** Sidebar group membership (optional). */
  groupId?: string;
  /** Workspace-relative plan path for Orchestrate mode (documentation/plans/*.md). */
  orchestratePlanPath?: string;
  /** @deprecated Legacy picker — use expertId on expert chats. */
  expertSelection?: ExpertSelection;
  /** Frozen runtime profile applied when this expert chat was created. */
  expertRuntime?: import('./chat/experts/types').ExpertRuntimeSnapshot;
  /** Tri-state thinking override for this chat (inherit uses work-agent / global stack). */
  thinkingMode?: ThinkingTriState;
  /** Tri-state code map injection override (inherit uses features.codeMapInjectionDefault). */
  codeMapInjection?: ThinkingTriState;
  /** Tri-state Brain notes (memory retrieve) override (inherit uses features.memoryInjection). */
  brainNotesInjection?: ThinkingTriState;
  /** Tri-state workspace context documents override (inherit uses features.contextDocumentsInjectionDefault). */
  contextDocumentsInjection?: ThinkingTriState;
  /**
   * First-turn injection bodies kept for follow-up compose, stored **untruncated**.
   * History `role: 'injection'` rows can be omitted from the runner view and are
   * capped for transcript storage; this snapshot replays exactly what turn 1 sent.
   */
  injectedContext?: Partial<Record<PromptInjectionKind, string>>;
  /** Per-chat reasoning effort override; unset resolves from catalog default + inherit stack. */
  reasoningEffort?: ReasoningEffortOption;
  /** Active Work Agent; null = default / auto from mode (Step 08). */
  workAgentId?: string | null;
  /** When true, mode switch picks defaultForModes agent (Step 08). */
  workAgentAuto?: boolean;
  /** UI Designer plan vs implement (Step 15); default plan. */
  uiDesignerMode?: 'plan' | 'implement';
  /** Per-chat terminal command history (Step 10). */
  terminalHistory?: TerminalRunRecord[];
  /** Settled sub-agent transcripts keyed per chat (Step 09 + visibility). */
  subAgentRuns?: PersistedSubAgentRun[];
  /**
   * @deprecated Board state lives on {@link ChatGroup}; stripped on load after v4→v5 migration.
   */
  orchestrateBoard?: OrchestrateBoardState;
  /** Weak link from planner chat to its board folder ({@link ChatGroup.id}). */
  boardGroupId?: string;
  /** Orchestrate board task id when this chat is a per-task worker thread. */
  boardTaskId?: string;
  /**
   * Per-request tool workspace root override (MIN-275). When set, this chat's tool
   * calls run scoped to this absolute path (its git worktree) instead of the global
   * Code workspace, isolating concurrent board task chats. Unset = shared workspace.
   */
  worktreeRoot?: string;
  /**
   * Git branch this chat operates on (MIN-276 composer branch selector). When
   * {@link worktreeRoot} is set, this is the worktree branch; otherwise the
   * workspace checkout branch the chat targets.
   */
  gitBranch?: string;
  /**
   * True when Minnow created the chat worktree at the managed slot (cleanup on
   * delete / detach to Local). False when attached to an existing worktree.
   */
  chatWorktreeManaged?: boolean;
  /** @deprecated Migrated to ~/.minnow/bugs/state.json — stripped on load. */
  bugBoard?: BugBoardState;
  /**
   * @deprecated Board view mode lives on {@link ChatGroup}; stripped on load after migration.
   */
  viewMode?: 'chat' | 'board';
  /** Backend-owned generation id for in-flight main chat completion (reload re-subscribe). */
  currentGenerationId?: string;
  /**
   * Persisted when a main-chat turn is in flight so the boot resume gate can still
   * prompt after a graceful Quit (which cancels generations and clears
   * {@link currentGenerationId}) or a crash mid-tools.
   */
  resumeInterrupted?: boolean;
  /** Queued steering correction for the in-flight turn (push-now; cleared on consume or stop). */
  pendingSteerMessage?: string;
  /** Follow-up messages queued while this chat is streaming (MIN-200). */
  pendingMessageQueue?: QueuedComposerMessage[];
  /** Active /goal completion loop; persists across reload until cleared. */
  activeGoal?: ActiveGoalState;
  /** Active /loop timers; persists across reload until stopped or expired (7 days). */
  activeLoops?: ActiveLoopState[];
  /** Next per-chat /loop id (monotonic). */
  nextLoopId?: number;
  /** Pipeline state from the retired in-renderer Super Plan controller. Never read; kept so old sessions round-trip. */
  superPlan?: unknown;
  /** Server-side Super Plan run this chat owns (`server/super-plan/`). */
  superPlanRunId?: string;
  /** Latest summary of that run, for the sidebar and the plan library. */
  superPlanView?: SuperPlanChatSummary;
  /** Build-agent progress checklist (todo_write); replace-all, cleared on /clear. */
  todos?: ChatTodo[];
  /** Epoch ms when todos were last written via todo_write. */
  todosUpdatedAt?: number;
  /** Queued mode switch from set_chat_mode during streaming (last write wins; flushed on stream end). */
  pendingModeId?: ModeId;
  /** Sidebar: green dot on inactive rows until the user opens this chat again. */
  unread?: boolean;
  /** Sidebar: red dot on inactive rows after a failed turn until the user opens this chat again. */
  turnError?: boolean;
  /** Epoch ms of last assistant message committed while this chat was active (unread baseline). */
  lastAssistantAt?: number;
  /**
   * Transcript messages. Always present (never optional) — unloaded chats use `[]`
   * with `historyLoaded: false` until `ensureChatHistoryLoaded` runs.
   */
  history: Message[];
  /**
   * When `false`, `history` is a placeholder and must be loaded via
   * `ensureChatHistoryLoaded` before read/mutate. Omitted/`true` means loaded
   * (whole-blob boot path, or after lazy fetch / local create).
   */
  historyLoaded?: boolean;
  /**
   * Denormalized server message count from summaries (C.2). Used for sidebar/rail
   * listing while `historyLoaded === false`; not a wire persistence field.
   */
  messageCount?: number;
  lastStats: LastStats | null;
  modelInfo: ModelInfo;
  /** Epoch ms of last committed user/assistant/tool history entry (sidebar sort). */
  lastMessageAt?: number;
  /** Epoch ms of last session metadata touch (prune, legacy fallback for sort). */
  updatedAt: number;
  /** Turn runs for replay / branch switching (schema v3). */
  runs?: TurnRunRecord[];
  /** forkHistoryIndex (string) → active branchId for the materialized transcript. */
  activeBranchByFork?: Record<string, string>;
  /** Unsent composer text shown as a draft row in the sidebar until the first send. */
  composerDraft?: string;
  /** Sticky slash skill for this chat (persists until cleared or replaced). */
  pinnedSkill?: PinnedSkillState | null;
  /** Cumulative token usage and optional USD cost (Feature #14). */
  tokenLedger?: ChatTokenLedger;
  /** Cumulative line add/delete from agent mutations in this chat. */
  codeChangeTotals?: ChatCodeChangeTotals;
  /** Epoch ms when history backfill last rebuilt codeChangeTotals. */
  codeChangeBackfillAt?: number;
  /** Hide Commit / Create PR strip actions after a successful ship from this chat. */
  codeChangeShipHandled?: boolean;
  /** Last context trim / compress stats. */
  lastContextTrim?: {
    archived?: number;
    recalled?: number;
    recallTokens?: number;
    policy?: ContextEnforcementPolicy;
    droppedTurns?: number;
    summaryPreview?: string;
    at?: number;
  };
  /**
   * Durable file/URL chips pinned on this chat (MIN-630). Survive reload and
   * are distinct from this-turn composer attachments.
   */
  links?: ChatLink[];
}

/** Kind of standing link chip pinned on a chat. */
export type ChatLinkKind = 'file' | 'url';

/**
 * One pinned chat link: a workspace file (editor tab) or an http(s) URL
 * (in-app browser tab). Same chip family as composer/transcript `.code-ref-link`.
 */
export interface ChatLink {
  id: string;
  kind: ChatLinkKind;
  /** Workspace-relative path when {@link kind} is `file`. */
  path?: string;
  /** Absolute http(s) URL when {@link kind} is `url`. */
  url?: string;
  /** Chip label (basename or host). */
  label: string;
  /** Epoch ms when the link was pinned. */
  addedAt: number;
}

export type {
  ChatTokenLedger,
  ProviderPricing,
  TokenLedgerBySource,
  TokenLedgerEntry,
  TokenLedgerSource,
  TokenLedgerTotals,
  TokenLedgerWriteSource,
} from './usage/types';

// ── Session ──────────────────────────────────────────────────────────────────

export interface SessionState {
  version: SessionSchemaVersion;
  activeId: string | null;
  sidebarCollapsed: boolean;
  /** Expanded chat sidebar width in px (persisted). */
  sidebarWidth?: number;
  chats: Chat[];
  /** Collapsible chat folders per workspace. */
  groups?: ChatGroup[];
  /** Folder whose board fills #chatArea when viewMode is board. */
  activeBoardGroupId?: string;
  /**
   * Board folder the user was last inside, kept after they navigate away so
   * re-entering Orchestrator lands back on it instead of the hub.
   * Unlike `activeBoardGroupId` this does *not* mean a board is mounted.
   */
  lastBoardGroupId?: string;
  /** Last selected chat per normalized workspace key ('' = unassigned bucket). */
  lastActiveChatIdByWorkspace?: Record<string, string>;
  /** Last selected chat per Minnow app id (e.g. `{ chat: '…' }` for the Chat app). */
  lastActiveChatIdByApp?: Record<string, string>;
  /** Cumulative agent line stats keyed by normalized workspace path. */
  codeChangeTotalsByWorkspace?: Record<string, ChatCodeChangeTotals>;
}

/** Built-in system prompt template for the settings drawer. */
export interface SystemPromptPreset {
  id: string;
  label: string;
  text: string;
}

/** `localStorage` payload under `minnow.systemPrompt`. */
export interface SystemPromptSettings {
  presetId: string;
  text: string;
}

// ── Completions ──────────────────────────────────────────────────────────────

/** Provenance for a detected model capability (feature #11). */
export type CapabilitySource = 'catalog' | 'probe' | 'assumed';

/** Per-model capability flags merged from catalog and probe. */
export interface ModelCapabilities {
  vision: boolean | null;
  tools: boolean | null;
  streaming: boolean | null;
  grammar: boolean | null;
  reasoning: boolean | null;
  /** Catalog `reasoning.allowed_options` when upstream exposes effort control. */
  reasoningAllowedOptions?: ReasoningEffortOption[];
  /** Catalog default reasoning effort when provided. */
  reasoningDefault?: ReasoningEffortOption;
  /** Value to send for `thinking.type` when enabled on openai-v1 providers (defaults to 'enabled'). MiniMax requires 'adaptive'. */
  reasoningThinkingEnabledValue?: 'enabled' | 'adaptive';
  contextLength: number | null;
  loadState: string | null;
  /** Resolved upstream API for this model (gateway auto-routing). */
  api?: import('./providers/types').ApiKind;
  sources?: Partial<Record<keyof ModelCapabilities | 'loadState', CapabilitySource>>;
  probeErrors?: Record<string, string>;
}

/** One model row from `GET /api/v0/models` (cached in `modelCache`). */
export interface LmModelRecord {
  id: string;
  type?: string;
  state?: string;
  quantization?: string;
  arch?: string;
  /** Catalog / architecture maximum. */
  max_context_length?: number;
  /** Allocated context for a loaded model (LM Studio UI setting). */
  loaded_context_length?: number;
  /** Merged catalog + probe capabilities (feature #11). */
  capabilities?: ModelCapabilities;
  /** LM Studio 0.4.8+ catalog reasoning block when present on models list row. */
  reasoning?: {
    allowed_options?: string[];
    default?: string;
  };
  /** Upstream catalog vision flag (`capabilities.vision` or `type: vlm`) before Minnow merge. */
  catalogVision?: boolean;
  /** Resolved upstream API (`openai-v1` vs `anthropic-v1`) for mixed gateways. */
  api?: import('./providers/types').ApiKind;
  /** OpenAI-compatible catalog owner when present (e.g. OpenRouter `owned_by`). */
  owned_by?: string;
  family?: string;
}

export interface LmModelsListResponse {
  data?: LmModelRecord[];
}

/** Outbound chat message (system prompt is not persisted in session history). */
export type ApiMessage =
  | ApiSystemMessage
  | ApiUserMessage
  | ApiAssistantMessage
  | ApiToolMessage;

export interface ChatCompletionsRequest {
  model?: string;
  messages: ApiMessage[];
  temperature: number;
  max_tokens: number;
  stream: boolean;
  stream_options?: { include_usage: boolean };
}

export interface ChatCompletionChoiceDelta {
  reasoning_blocks?: AnthropicThinkingBlock[];
  content?: string;
  /** LM Studio 0.3.23+ (gpt-oss / o3-mini style). */
  reasoning?: string;
  /** LM Studio experimental DeepSeek-style separate reasoning field. */
  reasoning_content?: string;
  /** Some Ollama-compatible gateways (e.g. MiniMax) emit thinking in this field. */
  thinking?: string;
  /** Anthropic extended-thinking signature (Minnow anthropic-v1 bridge extension). */
  reasoning_signature?: string;
  tool_calls?: ChatCompletionToolCallDelta[];
}

export interface ChatCompletionChoice {
  delta?: ChatCompletionChoiceDelta;
  message?: {
    content?: string;
    /** OpenAI structured-output JSON when `content` is empty. */
    parsed?: unknown;
    reasoning?: string;
    reasoning_content?: string;
  };
  finish_reason?: string | null;
}

/** Single SSE `data:` JSON object from `/api/v0/chat/completions`. */
export interface ChatCompletionChunk {
  choices?: ChatCompletionChoice[];
  stats?: Stats;
  usage?: Usage;
  model_info?: ModelInfo;
  model?: string;
  /** llama.cpp per-chunk timings (`timings_per_token`). */
  timings?: LlamaTimings;
  /** llama.cpp prefill progress (`return_progress`). */
  prompt_progress?: LlamaPromptProgress;
  error?: string | { message?: string; code?: string | number; type?: string };
}

/** Partial tool calls keyed by stream `index` while merging SSE deltas. */
export type ToolCallAccumulator = Record<number, Partial<ToolCall>>;

/** Accumulator while parsing a streaming completion (`mergeStreamMeta`). */
export interface StreamMeta {
  stats?: Stats;
  usage?: Usage;
  model_info?: ModelInfo;
  model?: string;
  finish_reason?: string;
  /** Latest llama.cpp timings seen on the stream. */
  timings?: LlamaTimings;
  /** Latest llama.cpp prefill progress seen on the stream. */
  prompt_progress?: LlamaPromptProgress;
}

/** Result of `finalizeResponseMeta` before pushing assistant history. */
export interface FinalizedResponseMeta {
  stats: Stats;
  usage: Usage;
  model_info: ModelInfo;
}
