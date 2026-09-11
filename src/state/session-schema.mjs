import { foldLeftoverBoardAutonomy } from '../lib/leftover-autonomy.mjs';

// ── Plan paths ───────────────────────────────────────────────────────────────

/** Inline copy of server/config/orchestrate-plan-path.js (avoid server→client coupling). */
const ORCHESTRATE_PLANS_PREFIX = 'documentation/plans/';
const ORCHESTRATE_PLANS_PREFIX_LEN = ORCHESTRATE_PLANS_PREFIX.length;

/**
 * @param {unknown} raw
 * @returns {string | undefined}
 */
function normalizeOrchestratePlanPath(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (!lower.endsWith('.md')) return undefined;
  if (!lower.startsWith(ORCHESTRATE_PLANS_PREFIX)) return undefined;
  const canonical = ORCHESTRATE_PLANS_PREFIX + trimmed.slice(ORCHESTRATE_PLANS_PREFIX_LEN);
  if (canonical.startsWith(`${ORCHESTRATE_PLANS_PREFIX}references/`)) return undefined;
  if (canonical.startsWith(`${ORCHESTRATE_PLANS_PREFIX}verification/`)) return undefined;
  return canonical;
}

/** Prefer Web Crypto (browser + Node); fall back for older runtimes. */
function randomChatId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

const PLACEHOLDER_CHAT_NAME = 'New chat';
/** Wire SessionState.version (not SQLite PRAGMA user_version). */
export const SESSION_SCHEMA_VERSION = 6;

// ── Chat fields ──────────────────────────────────────────────────────────────

/** Chat fields that must survive PUT/validate/PATCH. */
const CHAT_PASSTHROUGH_KEYS = new Set([
  'subAgentRuns',
  'todos',
  'todosUpdatedAt',
  'tokenLedger',
  'codeChangeTotals',
  'codeChangeBackfillAt',
  'lastContextTrim',
  'composerDraft',
  'pinnedSkill',
  'thinkingMode',
  'codeMapInjection',
  'brainNotesInjection',
  'contextDocumentsInjection',
  'injectedContext',
  'reasoningEffort',
  'uiDesignerMode',
  'pendingSteerMessage',
  'pendingMessageQueue',
  'pendingModeId',
  'turnError',
  'messageCount',
]);
const MAX_GOAL_CONDITION_CHARS = 4000;
const MAX_LOOP_PROMPT_CHARS = 4000;
const MIN_LOOP_INTERVAL_MS = 60_000;
const INITIAL_LOOP_AUTO_DELAY_MS = 120_000;
const LOOP_INTERVAL_TOKEN_RE = /^(\d+)(s|m|h|d)$/i;

/** Normalize workspace paths for stable keys (mirror src/lib/normalize-workspace-path.ts). */
export function normalizeWorkspacePath(fsPath) {
  if (typeof fsPath !== 'string') return '';
  let p = fsPath.trim().replace(/\\/g, '/');
  p = p.replace(/\/+/g, '/');
  if (/^[a-zA-Z]:\//.test(p)) {
    p = p.charAt(0).toUpperCase() + p.slice(1);
  }
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

function ensureLastActiveMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key === 'string' && typeof value === 'string' && value.trim()) {
      out[normalizeWorkspacePath(key)] = value.trim();
    }
  }
  return out;
}

/** Preserve app-scoped active chat ids without treating app ids as file paths.
 *  Drop the removed Calendar app key so leftover session blobs do not keep it. */
function ensureLastActiveAppMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const appId = typeof key === 'string' ? key.trim() : '';
    const chatId = typeof value === 'string' ? value.trim() : '';
    if (!appId || !chatId || appId === 'calendar' || appId === 'email') continue;
    out[appId] = chatId;
  }
  return out;
}

/** Valid operating mode ids (mirror src/chat/modes/types.ts). */
const MODE_IDS = [
  'general',
  'desktop',
  'email',
  'build',
  'plan',
  'super-plan',
  'orchestrate',
  'debug',
  'onboarding',
];
const DEFAULT_MODE_ID = 'build';

/** Normalize persisted or unknown mode ids. */
function normalizeModeId(value) {
  if (value === 'desktop' || value === 'email') return 'general';
  if (typeof value === 'string' && MODE_IDS.includes(value)) return value;
  return DEFAULT_MODE_ID;
}

/** Default expert picker when missing on older chats. */
function defaultExpertSelection() {
  return { mode: 'auto', expertId: null };
}

/** Coerce expert picker shape (mirror src/state/sessions.ts). */
function ensureExpertSelection(raw) {
  if (!raw || typeof raw !== 'object') return defaultExpertSelection();
  const row = /** @type {Record<string, unknown>} */ (raw);
  const mode = row.mode === 'manual' ? 'manual' : 'auto';
  const expertId =
    mode === 'manual' && typeof row.expertId === 'string' && row.expertId.trim()
      ? row.expertId.trim()
      : null;
  return { mode, expertId };
}

/** Coerce expert runtime snapshot (mirror src/state/sessions.ts ensureExpertRuntime). */
function ensureExpertRuntime(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const modelId = typeof row.modelId === 'string' ? row.modelId : '';
  const modeId = normalizeModeId(typeof row.modeId === 'string' ? row.modeId : undefined);
  const toolDenylist = Array.isArray(row.toolDenylist)
    ? row.toolDenylist.filter((t) => typeof t === 'string')
    : [];
  const enabledToolNames = Array.isArray(row.enabledToolNames)
    ? row.enabledToolNames.filter((t) => typeof t === 'string')
    : [];
  const warnings = Array.isArray(row.warnings)
    ? row.warnings.filter((t) => typeof t === 'string')
    : [];
  const toolAllowlist =
    row.toolAllowlist === null
      ? null
      : Array.isArray(row.toolAllowlist)
        ? row.toolAllowlist.filter((t) => typeof t === 'string')
        : null;
  return {
    ...(typeof row.providerId === 'string' && row.providerId.trim()
      ? { providerId: row.providerId.trim() }
      : {}),
    modelId,
    modeId,
    toolAllowlist,
    toolDenylist,
    enabledToolNames,
    memoryEnabled: row.memoryEnabled !== false,
    warnings,
    profileSource: row.profileSource === 'override' ? 'override' : 'inherit',
  };
}

/**
 * Experts overhaul on one chat: expertId + runtime snapshot; drop legacy picker.
 * Whole-blob PUT applies this when version &lt; 6; PATCH applies it per dirty chat.
 * @param {Record<string, any>} chat
 */
export function migrateChatRowV5ToV6(chat) {
  const selection = chat.expertSelection;
  if (chat.kind === 'expert') {
    if (
      !chat.expertId?.trim() &&
      selection?.mode === 'manual' &&
      selection.expertId?.trim()
    ) {
      chat.expertId = selection.expertId.trim();
    }
    if (!chat.expertRuntime) {
      chat.expertRuntime = {
        ...(chat.providerId?.trim() ? { providerId: chat.providerId.trim() } : {}),
        modelId: chat.modelId ?? '',
        modeId: normalizeModeId(chat.modeId),
        toolAllowlist: null,
        toolDenylist: [],
        enabledToolNames: [],
        memoryEnabled: true,
        warnings: [],
        profileSource: 'inherit',
      };
    }
  }
  delete chat.expertSelection;
}

function newChatId() {
  return randomChatId();
}

// ── Board log ────────────────────────────────────────────────────────────────

const BOARD_TASK_STATUSES = new Set([
  'planned',
  'in_progress',
  'testing',
  'merging',
  'complete',
  'failed',
  'blocked',
  'quarantined',
]);
const BOARD_CATEGORIES = new Set(['build', 'fix', 'test', 'research']);

const BOARD_LOG_MAX = 500;
const BOARD_LOG_LEVELS = new Set(['info', 'warn', 'error']);
const BOARD_LOG_TYPES = new Set([
  'board_init',
  'mode_change',
  'auto_start',
  'auto_stop',
  'task_status',
  'task_started',
  'build_verdict',
  'test_verdict',
  'merge_result',
  'worktree_allocated',
  'worktree_released',
  'task_retry',
  'nudge',
  'task_error',
  'task_quarantined',
  'tool_call',
  'terminal_run',
  'dev_server',
  'phase_start',
  'phase_end',
  'slot_acquire',
  'slot_release',
  'hold_acquire',
  'hold_release',
  'hold_expiry',
  'concurrency_observation',
  'lifecycle_owner_set',
  'lifecycle_owner_clear',
  'board_terminal',
  'planner_report',
  'completion_notification',
  'interaction_required',
  'final_test_started',
  'final_test_verdict',
]);
const BOARD_LOG_DETAIL_STRING_KEYS = new Set([
  'branch',
  'toolName',
  'argsPreview',
  'resultPreview',
  'command',
  'runId',
  'chatId',
  'error',
  'summary',
  'phaseId',
  'slotId',
  'holdId',
  'ownerId',
  'reason',
  'reportId',
  'notificationId',
]);
const BOARD_LOG_DETAIL_NUMBER_KEYS = new Set([
  'attempt',
  'devPort',
  'apiPort',
  'exitCode',
  'lifecycleRun',
  'activeSlots',
  'activeHolds',
  'activeTotal',
  'concurrencyCap',
  'durationMs',
]);
const BOARD_LOG_DETAIL_STATUS_KEYS = new Set(['from', 'to']);
const BOARD_LOG_DETAIL_ENUMS = {
  verdict: new Set(['pass', 'fail']),
  attemptKind: new Set(['build', 'test', 'fixer', 'nudge']),
  cause: new Set(['root', 'dependency']),
  category: new Set(['infra', 'code', 'merge', 'stall', 'unknown']),
  mode: new Set(['manual', 'auto', 'sequential', 'afk']),
  outcome: new Set(['merged', 'conflict', 'error', 'skipped']),
  phase: new Set(['build', 'test', 'fixer', 'merge', 'final_test', 'planner']),
  holdKind: new Set(['merge', 'fixer', 'handoff', 'phase_rerun', 'other']),
  ownerKind: new Set(['chat', 'run', 'hold', 'planner', 'system']),
  terminalOutcome: new Set(['passed', 'blocked', 'stopped', 'failed']),
  interactionKind: new Set(['question', 'approval', 'confirmation', 'mode_switch', 'other']),
};
const BOARD_LOG_STRING_MAX = 2000;

function truncateBoardLogString(value, max = BOARD_LOG_STRING_MAX) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function ensureBoardLogDetail(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const out = {};
  for (const key of BOARD_LOG_DETAIL_STRING_KEYS) {
    if (typeof r[key] === 'string' && r[key].trim()) {
      out[key] = truncateBoardLogString(r[key]);
    }
  }
  for (const key of BOARD_LOG_DETAIL_NUMBER_KEYS) {
    if (typeof r[key] === 'number' && Number.isFinite(r[key])) {
      out[key] = r[key];
    }
  }
  for (const key of BOARD_LOG_DETAIL_STATUS_KEYS) {
    const val = typeof r[key] === 'string' ? r[key] : '';
    if (BOARD_TASK_STATUSES.has(val)) out[key] = val;
  }
  for (const [key, allowed] of Object.entries(BOARD_LOG_DETAIL_ENUMS)) {
    if (typeof r[key] === 'string' && allowed.has(r[key])) {
      out[key] = r[key];
    }
  }
  if (Array.isArray(r.failingTaskIds)) {
    const failingTaskIds = [];
    for (const item of r.failingTaskIds) {
      if (typeof item === 'string' && item.trim()) failingTaskIds.push(item.trim());
    }
    if (failingTaskIds.length) out.failingTaskIds = failingTaskIds;
  }
  return Object.keys(out).length ? out : undefined;
}

function ensureBoardLogEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : null;
  const typeRaw = typeof r.type === 'string' ? r.type.trim() : '';
  if (!id || ts === null || !BOARD_LOG_TYPES.has(typeRaw)) return null;
  const levelRaw = typeof r.level === 'string' ? r.level.trim() : 'info';
  const level = BOARD_LOG_LEVELS.has(levelRaw) ? levelRaw : 'info';
  const message =
    typeof r.message === 'string' ? truncateBoardLogString(r.message, BOARD_LOG_STRING_MAX) : '';
  const out = { id, ts, type: typeRaw, level, message };
  if (typeof r.taskId === 'string' && r.taskId.trim()) {
    out.taskId = r.taskId.trim();
  }
  const detail = ensureBoardLogDetail(r.detail);
  if (detail) out.detail = detail;
  return out;
}

function ensureBoardWaveId(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

function ensureBoardCategory(raw) {
  return typeof raw === 'string' && BOARD_CATEGORIES.has(raw) ? raw : null;
}

// ── Board task ───────────────────────────────────────────────────────────────

function ensureBoardTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const title = typeof r.title === 'string' ? r.title : '';
  const wave = ensureBoardWaveId(r.wave);
  const category = ensureBoardCategory(r.category);
  const statusRaw = typeof r.status === 'string' ? r.status : '';
  if (!id || wave === null || !category || !BOARD_TASK_STATUSES.has(statusRaw)) return null;
  const out = { id, title, wave, category, status: statusRaw };
  if (typeof r.assignedRunId === 'string' && r.assignedRunId.trim()) {
    out.assignedRunId = r.assignedRunId.trim();
  }
  if (typeof r.startedAt === 'number') out.startedAt = r.startedAt;
  if (typeof r.endedAt === 'number') out.endedAt = r.endedAt;
  if (typeof r.filesChanged === 'number' && Number.isFinite(r.filesChanged)) {
    out.filesChanged = r.filesChanged;
  }
  if (typeof r.notes === 'string') out.notes = r.notes;
  if (typeof r.error === 'string') out.error = r.error;
  if (typeof r.lastRunId === 'string' && r.lastRunId.trim()) {
    out.lastRunId = r.lastRunId.trim();
  }
  if (Array.isArray(r.runHistory)) {
    const runHistory = [];
    for (const item of r.runHistory) {
      if (typeof item === 'string' && item.trim() && !runHistory.includes(item.trim())) {
        runHistory.push(item.trim());
      }
    }
    if (runHistory.length) out.runHistory = runHistory;
  }
  if (typeof r.chatId === 'string' && r.chatId.trim()) {
    out.chatId = r.chatId.trim();
  }
  if (typeof r.testChatId === 'string' && r.testChatId.trim()) {
    out.testChatId = r.testChatId.trim();
  }
  if (typeof r.fixerChatId === 'string' && r.fixerChatId.trim()) {
    out.fixerChatId = r.fixerChatId.trim();
  }
  if (typeof r.buildSpec === 'string' && r.buildSpec.trim()) {
    out.buildSpec = r.buildSpec.trim();
  }
  if (typeof r.testSpec === 'string' && r.testSpec.trim()) {
    out.testSpec = r.testSpec.trim();
  }
  if (Array.isArray(r.dependsOn)) {
    const dependsOn = [];
    for (const item of r.dependsOn) {
      if (typeof item === 'string' && item.trim()) dependsOn.push(item.trim());
    }
    if (dependsOn.length) out.dependsOn = dependsOn;
  }
  if (typeof r.testAttempts === 'number' && Number.isFinite(r.testAttempts)) {
    out.testAttempts = r.testAttempts;
  }
  if (typeof r.buildAttempts === 'number' && Number.isFinite(r.buildAttempts)) {
    out.buildAttempts = r.buildAttempts;
  }
  if (r.testVerdict === 'pass' || r.testVerdict === 'fail') {
    out.testVerdict = r.testVerdict;
  }
  if (typeof r.testSummary === 'string' && r.testSummary.trim()) {
    out.testSummary = r.testSummary.trim();
  }
  if (r.boardReport && typeof r.boardReport === 'object') {
    const br = /** @type {Record<string, unknown>} */ (r.boardReport);
    const outcome = typeof br.outcome === 'string' ? br.outcome.trim() : '';
    const summary = typeof br.summary === 'string' ? br.summary.trim() : '';
    if (
      (outcome === 'pass' || outcome === 'fail' || outcome === 'env_blocked') &&
      summary
    ) {
      const boardReport = { outcome, summary };
      if (Array.isArray(br.blockers)) {
        const blockers = [];
        for (const item of br.blockers) {
          if (typeof item === 'string' && item.trim()) blockers.push(item.trim());
        }
        if (blockers.length) boardReport.blockers = blockers;
      }
      out.boardReport = boardReport;
    }
  }
  if (typeof r.pendingBuildSeed === 'string' && r.pendingBuildSeed.trim()) {
    out.pendingBuildSeed = r.pendingBuildSeed.trim();
  }
  if (typeof r.worktreePath === 'string' && r.worktreePath.trim()) {
    out.worktreePath = r.worktreePath.trim();
  }
  if (typeof r.worktreeBranch === 'string' && r.worktreeBranch.trim()) {
    out.worktreeBranch = r.worktreeBranch.trim();
  }
  if (typeof r.devPort === 'number' && Number.isFinite(r.devPort)) {
    out.devPort = r.devPort;
  }
  if (typeof r.apiPort === 'number' && Number.isFinite(r.apiPort)) {
    out.apiPort = r.apiPort;
  }
  if (r.quarantine && typeof r.quarantine === 'object') {
    const q = /** @type {Record<string, unknown>} */ (r.quarantine);
    const QUARANTINE_CATEGORIES = new Set(['infra', 'code', 'merge', 'stall', 'unknown']);
    const category = typeof q.category === 'string' && QUARANTINE_CATEGORIES.has(q.category) ? q.category : null;
    const summary = typeof q.summary === 'string' ? q.summary : null;
    const at = typeof q.at === 'number' && Number.isFinite(q.at) ? q.at : null;
    if (category && summary !== null && at !== null) {
      const quarantine = { category, summary, at };
      if (Array.isArray(q.resolutionSteps)) {
        const steps = [];
        for (const s of q.resolutionSteps) {
          if (typeof s === 'string') steps.push(s);
        }
        quarantine.resolutionSteps = steps;
      } else {
        quarantine.resolutionSteps = [];
      }
      if (typeof q.logRef === 'string' && q.logRef.trim()) {
        quarantine.logRef = q.logRef.trim();
      }
      out.quarantine = quarantine;
    }
  }
  if (typeof r.selfHealRound === 'number' && Number.isFinite(r.selfHealRound)) {
    out.selfHealRound = r.selfHealRound;
  }
  if (typeof r.lastHealCategory === 'string' && r.lastHealCategory.trim()) {
    out.lastHealCategory = r.lastHealCategory.trim();
  }
  if (typeof r.buildOutcome === 'string' && r.buildOutcome.trim()) {
    out.buildOutcome = r.buildOutcome.trim();
  }
  if (Array.isArray(r.buildBlockers)) {
    const buildBlockers = [];
    for (const item of r.buildBlockers) {
      if (typeof item === 'string' && item.trim()) buildBlockers.push(item.trim());
    }
    if (buildBlockers.length) out.buildBlockers = buildBlockers;
  }
  return out;
}

function ensureOrchestrateFinalTest(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const statusRaw = typeof r.status === 'string' ? r.status.trim() : '';
  const status =
    statusRaw === 'pending' ||
    statusRaw === 'in_progress' ||
    statusRaw === 'passed' ||
    statusRaw === 'failed'
      ? statusRaw
      : undefined;
  if (!status) return undefined;
  const out = { status };
  if (typeof r.chatId === 'string' && r.chatId.trim()) {
    out.chatId = r.chatId.trim();
  }
  if (typeof r.attempts === 'number') out.attempts = r.attempts;
  if (r.recordedVerdict === 'pass' || r.recordedVerdict === 'fail') {
    out.recordedVerdict = r.recordedVerdict;
  }
  if (Array.isArray(r.failingTaskIds)) {
    const failingTaskIds = [];
    for (const item of r.failingTaskIds) {
      if (typeof item === 'string' && item.trim()) failingTaskIds.push(item.trim());
    }
    if (failingTaskIds.length) out.failingTaskIds = failingTaskIds;
  }
  if (typeof r.summary === 'string' && r.summary.trim()) {
    out.summary = r.summary.trim();
  }
  const runInstructions = ensureBoardRunInstructions(r.runInstructions);
  if (runInstructions) out.runInstructions = runInstructions;
  return out;
}

/** Verified project commands reported by the final tester. */
function ensureBoardRunInstructions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const out = {};
  for (const key of ['install', 'start', 'test', 'notes']) {
    const value = r[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function ensureOrchestrateBoard(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const planPath = typeof r.planPath === 'string' ? r.planPath.trim() : '';
  if (!planPath || !Array.isArray(r.tasks) || !Array.isArray(r.waves)) return undefined;
  const tasks = [];
  for (const item of r.tasks) {
    const task = ensureBoardTask(item);
    if (task) tasks.push(task);
  }
  if (!tasks.length) return undefined;
  const waves = [];
  for (const item of r.waves) {
    if (!item || typeof item !== 'object') continue;
    const w = /** @type {Record<string, unknown>} */ (item);
    const id = ensureBoardWaveId(w.id);
    const statusRaw = typeof w.status === 'string' ? w.status : 'planned';
    const status = BOARD_TASK_STATUSES.has(statusRaw) ? statusRaw : 'planned';
    if (id === null) continue;
    const wave = { id, status };
    if (typeof w.taskCount === 'number') wave.taskCount = w.taskCount;
    if (typeof w.completeCount === 'number') wave.completeCount = w.completeCount;
    if (w.collapsed === true) wave.collapsed = true;
    waves.push(wave);
  }
  if (!waves.length) return undefined;
  const startedAt = typeof r.startedAt === 'number' ? r.startedAt : Date.now();
  const lastUpdatedAt = typeof r.lastUpdatedAt === 'number' ? r.lastUpdatedAt : startedAt;
  const out = { planPath, tasks, waves, startedAt, lastUpdatedAt };
  if (typeof r.activeParentTurnId === 'string' && r.activeParentTurnId.trim()) {
    out.activeParentTurnId = r.activeParentTurnId.trim();
  }
  if (typeof r.timerAccumulatedMs === 'number') {
    out.timerAccumulatedMs = r.timerAccumulatedMs;
  }
  if (typeof r.timerSegmentStartedAt === 'number') {
    out.timerSegmentStartedAt = r.timerSegmentStartedAt;
  }
  if (typeof r.maxConcurrentTasks === 'number' && r.maxConcurrentTasks > 0) {
    out.maxConcurrentTasks = r.maxConcurrentTasks;
  }
  if (typeof r.modelProviderId === 'string' && r.modelProviderId.trim()) {
    out.modelProviderId = r.modelProviderId.trim().slice(0, 64);
  }
  if (typeof r.modelId === 'string' && r.modelId.trim()) {
    out.modelId = r.modelId.trim().slice(0, 200);
  }
  const REASONING_EFFORT = new Set(['off', 'on', 'low', 'medium', 'high', 'max']);
  if (typeof r.reasoningEffort === 'string' && REASONING_EFFORT.has(r.reasoningEffort)) {
    out.reasoningEffort = r.reasoningEffort;
  }
  const THINKING_MODE = new Set(['inherit', 'on', 'off']);
  if (typeof r.thinkingMode === 'string' && THINKING_MODE.has(r.thinkingMode)) {
    out.thinkingMode = r.thinkingMode;
  }
  if (typeof r.completionShownAt === 'number') {
    out.completionShownAt = r.completionShownAt;
  }
  if (r.dashboardDismissed === true) out.dashboardDismissed = true;
  if (typeof r.finishReport === 'string' && r.finishReport.trim()) {
    out.finishReport = r.finishReport.trim();
  }
  foldLeftoverBoardAutonomy(out, r);
  if (typeof r.worktreeSlug === 'string' && r.worktreeSlug.trim()) {
    out.worktreeSlug = r.worktreeSlug.trim().slice(0, 64);
  }
  const isolationModeRaw =
    typeof r.isolationMode === 'string' ? r.isolationMode.trim() : '';
  if (
    isolationModeRaw === 'off' ||
    isolationModeRaw === 'per-task' ||
    isolationModeRaw === 'per-wave' ||
    isolationModeRaw === 'per-board'
  ) {
    out.isolationMode = isolationModeRaw;
  }
  if (typeof r.integrationBranch === 'string' && r.integrationBranch.trim()) {
    out.integrationBranch = r.integrationBranch.trim();
  }
  const finalTest = ensureOrchestrateFinalTest(r.finalTest);
  if (finalTest) out.finalTest = finalTest;
  if (typeof r.isolationBaseRef === 'string' && r.isolationBaseRef.trim()) {
    out.isolationBaseRef = r.isolationBaseRef.trim();
  }
  const PROVISION_STATES = new Set(['idle', 'provisioning', 'ready', 'failed']);
  if (typeof r.provisionState === 'string' && PROVISION_STATES.has(r.provisionState)) {
    out.provisionState = r.provisionState;
  }
  if (Array.isArray(r.provisionedSignatures)) {
    const sigs = [];
    for (const s of r.provisionedSignatures) {
      if (typeof s === 'string' && s.trim()) sigs.push(s.trim());
    }
    if (sigs.length) out.provisionedSignatures = sigs;
  }
  if (Array.isArray(r.unresolvedIssues)) {
    const UNRESOLVED_ISSUES_MAX = 200;
    const issues = [];
    for (const item of r.unresolvedIssues) {
      if (!item || typeof item !== 'object') continue;
      const u = /** @type {Record<string, unknown>} */ (item);
      if (
        typeof u.taskId === 'string' && u.taskId.trim() &&
        typeof u.title === 'string' &&
        typeof u.category === 'string' &&
        typeof u.summary === 'string' &&
        Array.isArray(u.resolutionSteps) &&
        typeof u.createdAt === 'number'
      ) {
        issues.push({
          taskId: u.taskId.trim(),
          title: u.title,
          category: u.category,
          summary: u.summary,
          resolutionSteps: u.resolutionSteps.filter((s) => typeof s === 'string'),
          ...(typeof u.logRef === 'string' && u.logRef.trim() ? { logRef: u.logRef.trim() } : {}),
          createdAt: u.createdAt,
          ...(typeof u.attempts === 'number' ? { attempts: u.attempts } : {}),
        });
      }
    }
    if (issues.length) out.unresolvedIssues = issues.slice(-UNRESOLVED_ISSUES_MAX);
  }
  if (Array.isArray(r.log)) {
    const log = [];
    for (const item of r.log) {
      const e = ensureBoardLogEvent(item);
      if (e) log.push(e);
    }
    if (log.length) out.log = log.slice(-BOARD_LOG_MAX);
  }
  return out;
}

// ── Groups ───────────────────────────────────────────────────────────────────

/**
 * Normalize one ChatGroup row (sidebar folder / board). Returns null when invalid.
 * Shared by whole-blob PUT and PATCH /api/config/sessions.
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeGroupRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const workspacePath =
    typeof r.workspacePath === 'string'
      ? normalizeWorkspacePath(r.workspacePath)
      : '';
  if (!id || !name) return null;
  const orchestrateBoard = ensureOrchestrateBoard(r.orchestrateBoard);
  const orchestratePlanPath = normalizeOrchestratePlanPath(r.orchestratePlanPath);
  const viewMode = ensureViewMode(r.viewMode);
  const plannerChatId =
    typeof r.plannerChatId === 'string' && r.plannerChatId.trim()
      ? r.plannerChatId.trim()
      : undefined;
  return {
    id,
    name,
    workspacePath,
    collapsed: r.collapsed === true,
    order: typeof r.order === 'number' ? r.order : 0,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    ...(orchestrateBoard ? { orchestrateBoard } : {}),
    ...(orchestratePlanPath ? { orchestratePlanPath } : {}),
    ...(viewMode ? { viewMode } : {}),
    ...(plannerChatId ? { plannerChatId } : {}),
  };
}

/** Coerce persisted sidebar folders. */
function ensureGroupsFromRaw(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const group = normalizeGroupRow(item);
    if (group) out.push(group);
  }
  return out;
}

function ensureViewMode(raw) {
  return raw === 'chat' || raw === 'board' ? raw : undefined;
}

const GENERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Persisted backend generation id for reload re-subscribe. */
function ensureCurrentGenerationId(raw) {
  if (typeof raw !== 'string') return undefined;
  const id = raw.trim();
  return GENERATION_ID_RE.test(id) ? id : undefined;
}

/** Pipeline state from the retired in-renderer Super Plan controller; kept as-is so old sessions round-trip. */
function ensureSuperPlanPersisted(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const sp = /** @type {Record<string, unknown>} */ (raw);
  if (typeof sp.slug !== 'string' || !sp.slug.trim()) return undefined;
  if (typeof sp.prompt !== 'string') return undefined;
  if (typeof sp.activeStage !== 'string' || !sp.activeStage.trim()) return undefined;
  if (!sp.stages || typeof sp.stages !== 'object') return undefined;
  return sp;
}

const SUPER_PLAN_STATUSES = new Set([
  'created',
  'running',
  'waiting',
  'paused',
  'halted',
  'done',
  'cancelled',
  'failed',
  'legacy',
]);
const SUPER_PLAN_NEEDS_INPUT = new Set(['question', 'spec', 'accept', 'halted']);

/**
 * Coerce the Super Plan run summary a chat keeps (mirror
 * src/chat/super-plan/types.ts SuperPlanChatSummary). A summary written by the
 * retired v2 projection becomes a legacy row; the background poll replaces it
 * with the server's current answer.
 */
function ensureSuperPlanSummary(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = /** @type {Record<string, any>} */ (raw);
  if (typeof v.runId !== 'string' || !v.runId.trim()) return undefined;
  const text = (value) => (typeof value === 'string' ? value : '');
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const paths = {
    ...(text(v.planPath).trim() ? { planPath: v.planPath.trim() } : {}),
    ...(text(v.specPath).trim() ? { specPath: v.specPath.trim() } : {}),
  };
  if (SUPER_PLAN_STATUSES.has(v.status)) {
    return {
      runId: v.runId.trim(),
      title: text(v.title),
      slug: text(v.slug),
      prompt: text(v.prompt),
      status: v.status,
      stage: text(v.stage),
      stageLabel: text(v.stageLabel),
      activity: text(v.activity),
      needsInput: SUPER_PLAN_NEEDS_INPUT.has(v.needsInput) ? v.needsInput : null,
      ...(text(v.attentionKey) ? { attentionKey: v.attentionKey } : {}),
      finished: v.finished === true,
      ...paths,
      atMs: num(v.atMs),
      seq: num(v.seq),
    };
  }
  if (!v.stages || typeof v.stages !== 'object') return undefined;
  return {
    runId: v.runId.trim(),
    title: text(v.title),
    slug: text(v.slug),
    prompt: text(v.prompt),
    status: 'legacy',
    stage: '',
    stageLabel: '',
    activity: 'Made by an earlier version of Super Plan',
    needsInput: null,
    finished: v.finished === true,
    ...paths,
    atMs: num(v.atMs),
    seq: 0,
  };
}

/** Coerce /goal loop state (mirror src/state/sessions.ts ensureActiveGoal). */
function ensureActiveGoal(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const goal = /** @type {Record<string, unknown>} */ (raw);
  const conditionText =
    typeof goal.conditionText === 'string' ? goal.conditionText.trim() : '';
  if (!conditionText) return undefined;
  return {
    conditionText: conditionText.slice(0, MAX_GOAL_CONDITION_CHARS),
    startedAt:
      typeof goal.startedAt === 'number' && Number.isFinite(goal.startedAt)
        ? goal.startedAt
        : Date.now(),
    turnCount:
      typeof goal.turnCount === 'number' && Number.isFinite(goal.turnCount)
        ? Math.max(0, Math.floor(goal.turnCount))
        : 0,
    tokenBaseline:
      typeof goal.tokenBaseline === 'number' && Number.isFinite(goal.tokenBaseline)
        ? Math.max(0, Math.floor(goal.tokenBaseline))
        : 0,
    ...(typeof goal.lastReason === 'string' && goal.lastReason.trim()
      ? { lastReason: goal.lastReason.trim() }
      : {}),
    ...(goal.achieved === true ? { achieved: true } : {}),
  };
}

/** Coerce one /loop row (mirror src/state/sessions.ts ensureActiveLoopRow). */
function ensureActiveLoopRow(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const id =
    typeof row.id === 'number' && Number.isFinite(row.id)
      ? Math.max(1, Math.floor(row.id))
      : 0;
  if (id < 1) return undefined;

  const kind = row.kind === 'interval' || row.kind === 'auto' ? row.kind : null;
  if (!kind) return undefined;

  const promptText =
    typeof row.promptText === 'string'
      ? row.promptText.slice(0, MAX_LOOP_PROMPT_CHARS)
      : '';

  const dueAt =
    typeof row.dueAt === 'number' && Number.isFinite(row.dueAt)
      ? row.dueAt
      : Date.now();
  const createdAt =
    typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
      ? row.createdAt
      : Date.now();
  const expiresAt =
    typeof row.expiresAt === 'number' && Number.isFinite(row.expiresAt)
      ? row.expiresAt
      : createdAt + 7 * 24 * 60 * 60 * 1000;
  const runCount =
    typeof row.runCount === 'number' && Number.isFinite(row.runCount)
      ? Math.max(0, Math.floor(row.runCount))
      : 0;

  const loop = {
    id,
    promptText,
    kind,
    dueAt,
    createdAt,
    expiresAt,
    runCount,
  };

  if (kind === 'interval') {
    const intervalMs =
      typeof row.intervalMs === 'number' && Number.isFinite(row.intervalMs)
        ? Math.max(MIN_LOOP_INTERVAL_MS, Math.floor(row.intervalMs))
        : MIN_LOOP_INTERVAL_MS;
    loop.intervalMs = intervalMs;
  } else {
    const currentDelayMs =
      typeof row.currentDelayMs === 'number' && Number.isFinite(row.currentDelayMs)
        ? Math.min(
            3_600_000,
            Math.max(MIN_LOOP_INTERVAL_MS, Math.floor(row.currentDelayMs)),
          )
        : INITIAL_LOOP_AUTO_DELAY_MS;
    loop.currentDelayMs = currentDelayMs;
  }

  if (typeof row.lastOutputDigest === 'string' && row.lastOutputDigest.trim()) {
    loop.lastOutputDigest = row.lastOutputDigest.trim();
  }

  if (row.paused === true) {
    loop.paused = true;
    if (
      typeof row.pausedRemainingMs === 'number' &&
      Number.isFinite(row.pausedRemainingMs)
    ) {
      loop.pausedRemainingMs = Math.max(0, Math.floor(row.pausedRemainingMs));
    }
  }

  return loop;
}

/** Coerce active /loop rows on a chat. */
function ensureActiveLoops(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const loop = ensureActiveLoopRow(entry);
    if (!loop || seen.has(loop.id)) continue;
    seen.add(loop.id);
    out.push(loop);
  }
  return out.length ? out : undefined;
}

// ── Chat links ───────────────────────────────────────────────────────────────

/** Cap standing chat link chips so a drop loop cannot bloat the session blob. */
const MAX_CHAT_LINKS = 32;
const CHAT_LINK_PATH_MAX = 512;
const CHAT_LINK_URL_MAX = 2048;
const CHAT_LINK_LABEL_MAX = 200;
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Normalize one durable chat link chip (MIN-630). Returns null when invalid.
 * @param {unknown} raw
 * @returns {{ id: string, kind: 'file' | 'url', path?: string, url?: string, label: string, addedAt: number } | null}
 */
function ensureChatLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const kind = r.kind === 'url' ? 'url' : r.kind === 'file' ? 'file' : null;
  if (!kind) return null;

  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : '';
  if (!id) return null;

  const addedAt =
    typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) && r.addedAt > 0
      ? Math.floor(r.addedAt)
      : Date.now();

  if (kind === 'file') {
    const path =
      typeof r.path === 'string' ? r.path.trim().replace(/\\/g, '/') : '';
    if (!path || path.includes('\n') || path.length > CHAT_LINK_PATH_MAX) return null;
    if (path.startsWith('.minnow/attachments/')) return null;
    const labelRaw = typeof r.label === 'string' ? r.label.trim() : '';
    const fallback = path.split('/').filter(Boolean).pop() || path;
    const label = (labelRaw || fallback).slice(0, CHAT_LINK_LABEL_MAX);
    return { id, kind, path, label, addedAt };
  }

  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!url || url.length > CHAT_LINK_URL_MAX || !HTTP_URL_RE.test(url)) return null;
  const labelRaw = typeof r.label === 'string' ? r.label.trim() : '';
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    host = url;
  }
  const label = (labelRaw || host).slice(0, CHAT_LINK_LABEL_MAX);
  return { id, kind, url, label, addedAt };
}

/**
 * Normalize pinned chat links (MIN-630). Dedupes by path/URL. Empty → undefined.
 * @param {unknown} raw
 * @returns {Array<{ id: string, kind: 'file' | 'url', path?: string, url?: string, label: string, addedAt: number }> | undefined}
 */
export function ensureChatLinks(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const link = ensureChatLink(item);
    if (!link) continue;
    const key = link.kind === 'file' ? `file:${link.path}` : `url:${link.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
    if (out.length >= MAX_CHAT_LINKS) break;
  }
  return out.length ? out : undefined;
}

// ── Chat row ─────────────────────────────────────────────────────────────────

/**
 * Normalize one Chat row for persistence (whole-blob PUT and PATCH).
 * Null/invalid input yields a placeholder chat (same as historical ensureChatShape).
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeChatRow(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      id: newChatId(),
      name: PLACEHOLDER_CHAT_NAME,
      workspacePath: '',
      modelId: '',
      modeId: DEFAULT_MODE_ID,
      history: [],
      lastStats: null,
      modelInfo: {},
      updatedAt: Date.now(),
    };
  }

  const row = /** @type {Record<string, unknown>} */ (raw);
  const history = Array.isArray(row.history)
    ? row.history.filter((m) => m && typeof m === 'object' && m.role)
    : [];

  const terminalHistory = Array.isArray(row.terminalHistory)
    ? row.terminalHistory.filter((r) => r && typeof r === 'object')
    : undefined;

  const workspacePath =
    typeof row.workspacePath === 'string'
      ? normalizeWorkspacePath(row.workspacePath)
      : '';

  const currentGenerationId = ensureCurrentGenerationId(row.currentGenerationId);
  const resumeInterrupted = row.resumeInterrupted === true;

  const orchestratePlanPath = normalizeOrchestratePlanPath(row.orchestratePlanPath);
  const orchestrateBoard = ensureOrchestrateBoard(row.orchestrateBoard);
  const viewMode = ensureViewMode(row.viewMode);

  const runs = Array.isArray(row.runs)
    ? row.runs.filter((r) => r && typeof r === 'object')
    : undefined;
  const activeBranchByFork =
    row.activeBranchByFork && typeof row.activeBranchByFork === 'object'
      ? row.activeBranchByFork
      : undefined;
  const activeGoal = ensureActiveGoal(row.activeGoal);
  const activeLoops = ensureActiveLoops(row.activeLoops);
  const nextLoopId =
    typeof row.nextLoopId === 'number' && Number.isFinite(row.nextLoopId)
      ? Math.max(1, Math.floor(row.nextLoopId))
      : activeLoops?.length
        ? Math.max(...activeLoops.map((loop) => loop.id)) + 1
        : undefined;
  const superPlan = ensureSuperPlanPersisted(row.superPlan);
  const superPlanView = ensureSuperPlanSummary(row.superPlanView);
  // The server-side run this chat owns; the summary above is only its latest read.
  const superPlanRunId =
    typeof row.superPlanRunId === 'string' && row.superPlanRunId.trim()
      ? row.superPlanRunId.trim()
      : superPlanView?.runId;
  const expertRuntime = ensureExpertRuntime(row.expertRuntime);
  const links = ensureChatLinks(row.links);

  const out = {
    id: typeof row.id === 'string' && row.id ? row.id : newChatId(),
    name:
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : PLACEHOLDER_CHAT_NAME,
    // Stored appScope 'calendar' / 'email' (removed apps) is dropped.
    ...(row.background === true ? { background: true } : {}),
    ...(typeof row.backgroundKey === 'string' && row.backgroundKey.trim()
      ? { backgroundKey: row.backgroundKey.trim() }
      : {}),
    workspacePath,
    modelId: typeof row.modelId === 'string' ? row.modelId : '',
    ...(typeof row.providerId === 'string' && row.providerId.trim()
      ? { providerId: row.providerId.trim() }
      : {}),
    modeId: normalizeModeId(
      typeof row.modeId === 'string' ? row.modeId : undefined,
    ),
    ...(row.expertSelection && typeof row.expertSelection === 'object'
      ? { expertSelection: ensureExpertSelection(row.expertSelection) }
      : {}),
    ...(orchestratePlanPath ? { orchestratePlanPath } : {}),
    ...(typeof row.groupId === 'string' && row.groupId.trim()
      ? { groupId: row.groupId.trim() }
      : {}),
    ...(typeof row.boardGroupId === 'string' && row.boardGroupId.trim()
      ? { boardGroupId: row.boardGroupId.trim() }
      : {}),
    ...(typeof row.boardTaskId === 'string' && row.boardTaskId.trim()
      ? { boardTaskId: row.boardTaskId.trim() }
      : {}),
    ...(typeof row.worktreeRoot === 'string' && row.worktreeRoot.trim()
      ? { worktreeRoot: row.worktreeRoot.trim() }
      : {}),
    ...(typeof row.gitBranch === 'string' && row.gitBranch.trim()
      ? { gitBranch: row.gitBranch.trim() }
      : {}),
    ...(row.chatWorktreeManaged === true ? { chatWorktreeManaged: true } : {}),
    workAgentId:
      typeof row.workAgentId === 'string' && row.workAgentId.trim()
        ? row.workAgentId.trim()
        : null,
    workAgentAuto: row.workAgentAuto !== false,
    ...(orchestrateBoard ? { orchestrateBoard } : {}),
    ...(viewMode ? { viewMode } : {}),
    ...(runs?.length ? { runs } : {}),
    ...(activeBranchByFork ? { activeBranchByFork } : {}),
    ...(terminalHistory?.length ? { terminalHistory } : {}),
    ...(currentGenerationId ? { currentGenerationId } : {}),
    ...(resumeInterrupted ? { resumeInterrupted: true } : {}),
    ...(activeGoal ? { activeGoal } : {}),
    ...(activeLoops ? { activeLoops } : {}),
    ...(nextLoopId != null ? { nextLoopId } : {}),
    ...(superPlan ? { superPlan } : {}),
    ...(superPlanRunId ? { superPlanRunId } : {}),
    ...(superPlanView ? { superPlanView } : {}),
    ...(row.kind === 'expert' ? { kind: 'expert' } : {}),
    ...(row.kind === 'expert-lab' ? { kind: 'expert-lab' } : {}),
    ...(typeof row.expertId === 'string' && row.expertId.trim()
      ? { expertId: row.expertId.trim() }
      : {}),
    ...(expertRuntime ? { expertRuntime } : {}),
    ...(row.unread === true ? { unread: true } : {}),
    ...(typeof row.lastAssistantAt === 'number' &&
    Number.isFinite(row.lastAssistantAt) &&
    row.lastAssistantAt > 0
      ? { lastAssistantAt: row.lastAssistantAt }
      : {}),
    ...(links ? { links } : {}),
    history,
    lastStats: row.lastStats && typeof row.lastStats === 'object' ? row.lastStats : null,
    modelInfo: row.modelInfo && typeof row.modelInfo === 'object' ? row.modelInfo : {},
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
    lastMessageAt:
      typeof row.lastMessageAt === 'number'
        ? row.lastMessageAt
        : typeof row.updatedAt === 'number'
          ? row.updatedAt
          : Date.now(),
  };

  for (const key of CHAT_PASSTHROUGH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) {
      out[key] = row[key];
    }
  }

  return out;
}

// ── Session scalars ──────────────────────────────────────────────────────────

/**
 * Normalize session-level scalars (everything except chats/groups).
 *
 * - `mode: 'full'` (default): whole-blob PUT — fill defaults for required keys.
 * - `mode: 'partial'`: PATCH scalars — only include keys present on `raw`
 *   (absent keys mean unchanged; never delete by omission).
 *
 * @param {unknown} raw
 * @param {{ mode?: 'full' | 'partial' }} [options]
 * @returns {Record<string, unknown>}
 */
export function normalizeSessionScalars(raw, options = {}) {
  const mode = options.mode === 'partial' ? 'partial' : 'full';
  if (!raw || typeof raw !== 'object') {
    if (mode === 'partial') return {};
    throw new Error('Invalid session scalars');
  }

  const parsed = /** @type {Record<string, unknown>} */ (raw);
  const has = (key) => Object.prototype.hasOwnProperty.call(parsed, key);

  /** @type {Record<string, unknown>} */
  const out = {};

  if (mode === 'full' || has('version')) {
    out.version = SESSION_SCHEMA_VERSION;
  }

  if (mode === 'full' || has('activeId')) {
    out.activeId = typeof parsed.activeId === 'string' ? parsed.activeId : '';
  }

  if (mode === 'full' || has('sidebarCollapsed')) {
    out.sidebarCollapsed = !!parsed.sidebarCollapsed;
  }

  if (mode === 'full' || has('lastActiveChatIdByWorkspace')) {
    out.lastActiveChatIdByWorkspace = ensureLastActiveMap(
      parsed.lastActiveChatIdByWorkspace,
    );
  }

  if (mode === 'full' || has('lastActiveChatIdByApp')) {
    out.lastActiveChatIdByApp = ensureLastActiveAppMap(parsed.lastActiveChatIdByApp);
  }

  if (mode === 'full') {
    if (typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)) {
      out.sidebarWidth = Math.min(520, Math.max(200, Math.round(parsed.sidebarWidth)));
    }
    if (
      typeof parsed.activeBoardGroupId === 'string' &&
      parsed.activeBoardGroupId.trim()
    ) {
      out.activeBoardGroupId = parsed.activeBoardGroupId.trim();
    }
    if (typeof parsed.lastBoardGroupId === 'string' && parsed.lastBoardGroupId.trim()) {
      out.lastBoardGroupId = parsed.lastBoardGroupId.trim();
    }
    if (
      parsed.codeChangeTotalsByWorkspace &&
      typeof parsed.codeChangeTotalsByWorkspace === 'object' &&
      !Array.isArray(parsed.codeChangeTotalsByWorkspace)
    ) {
      out.codeChangeTotalsByWorkspace = parsed.codeChangeTotalsByWorkspace;
    }
  } else {
    if (has('sidebarWidth')) {
      if (typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)) {
        out.sidebarWidth = Math.min(520, Math.max(200, Math.round(parsed.sidebarWidth)));
      } else if (parsed.sidebarWidth == null) {
        out.sidebarWidth = null;
      }
    }
    if (has('activeBoardGroupId')) {
      if (
        typeof parsed.activeBoardGroupId === 'string' &&
        parsed.activeBoardGroupId.trim()
      ) {
        out.activeBoardGroupId = parsed.activeBoardGroupId.trim();
      } else {
        out.activeBoardGroupId = null;
      }
    }
    if (has('lastBoardGroupId')) {
      if (typeof parsed.lastBoardGroupId === 'string' && parsed.lastBoardGroupId.trim()) {
        out.lastBoardGroupId = parsed.lastBoardGroupId.trim();
      } else {
        out.lastBoardGroupId = null;
      }
    }
    if (has('codeChangeTotalsByWorkspace')) {
      if (
        parsed.codeChangeTotalsByWorkspace &&
        typeof parsed.codeChangeTotalsByWorkspace === 'object' &&
        !Array.isArray(parsed.codeChangeTotalsByWorkspace)
      ) {
        out.codeChangeTotalsByWorkspace = parsed.codeChangeTotalsByWorkspace;
      } else {
        out.codeChangeTotalsByWorkspace = null;
      }
    }
  }

  return out;
}
