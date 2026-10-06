/**
 * Global orchestrator autopilot defaults in ~/.minnow/config.json (`autopilot` block).
 * Per-board overrides for leftover session blobs live on {@link OrchestrateBoardState};
 * live V2 boards use journaled status + concurrency. Resolution is
 * per-board ?? global ?? hard-coded fallback.
 */

import {
  foldAutopilotDefaultStatus,
} from '../lib/leftover-autonomy.mjs';
import { detectConfigServer } from './storage-mode';

/** Stored isolation sentinel `auto` means derive from board concurrency at resolve time. */
export type AutopilotIsolationMode = 'auto' | 'off' | 'per-task' | 'per-wave' | 'per-board';

/** Board default for agent shell sandbox (MIN-553); overridable per board. */
export type AutopilotShellSandboxMode = 'off' | 'prefer' | 'require';

export type AutopilotContinueSmartRoute = 'off' | 'conservative' | 'aggressive';

/** Persisted global autopilot defaults for orchestrate boards. */
export interface AutopilotMeta {
  /** New boards' Start default. Folded from the old Autopilot autonomy flags. */
  defaultStatus: 'running' | 'stopped';
  maxConcurrentTasks: number;
  isolationMode: AutopilotIsolationMode;
/** @deprecated Boards use toolSecurity.shellSandbox; kept for legacy config.json reads. */
  shellSandbox: AutopilotShellSandboxMode;
  maxTestAttempts: number;
  maxBuildAttempts: number;
  maxFinalTestAttempts: number;
  /** When Continue should auto-route to a fresh summarized chat instead of nudging. */
  continueSmartRoute: AutopilotContinueSmartRoute;
  plannerProviderId: string;
  plannerModelId: string;
  /** Max self-heal infra rounds before unconditional quarantine. */
  selfHealMaxRounds: number;
  /** Max env-fixer sub-agent attempts on an infra failure before quarantine. */
  maxEnvFixAttempts: number;
  /** When true, infra provisioning is attempted automatically on infra failures. */
  autoProvisionInfra: boolean;
  /** Timeout (ms) for infra provisioning commands. */
  infraProvisionTimeoutMs: number;
  /** Wall-clock cap (ms) for one board builder/tester attempt; 0 = no cap. */
  attemptWallClockMs: number;
  /** When false, stalling tasks are quarantined immediately instead of nudged. */
  afkAutoRestartStalls: boolean;
  /** When false, the worktree cd-guard rewrite is skipped. */
  guardCdOutsideWorktree: boolean;
}

const FALLBACK_MAX_CONCURRENT = 3;
const FALLBACK_MAX_TEST_ATTEMPTS = 3;
const FALLBACK_MAX_BUILD_ATTEMPTS = 2;
const FALLBACK_MAX_FINAL_TEST_ATTEMPTS = 3;

/** Mirrors `server/orchestrator/attempt-limits.js`. */
const DEFAULT_ATTEMPT_WALL_CLOCK_MS = 240 * 60 * 1000;
const MIN_ATTEMPT_WALL_CLOCK_MS = 5 * 60 * 1000;
const MAX_ATTEMPT_WALL_CLOCK_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_AUTOPILOT_META: AutopilotMeta = {
  defaultStatus: 'stopped',
  maxConcurrentTasks: FALLBACK_MAX_CONCURRENT,
  isolationMode: 'auto',
  shellSandbox: 'off',
  maxTestAttempts: FALLBACK_MAX_TEST_ATTEMPTS,
  maxBuildAttempts: FALLBACK_MAX_BUILD_ATTEMPTS,
  maxFinalTestAttempts: FALLBACK_MAX_FINAL_TEST_ATTEMPTS,
  continueSmartRoute: 'conservative',
  plannerProviderId: '',
  plannerModelId: '',
  selfHealMaxRounds: 4,
  maxEnvFixAttempts: 2,
  autoProvisionInfra: true,
  infraProvisionTimeoutMs: 180_000,
  attemptWallClockMs: DEFAULT_ATTEMPT_WALL_CLOCK_MS,
  afkAutoRestartStalls: true,
  guardCdOutsideWorktree: true,
};

const AUTOPILOT_META_STORAGE_KEY = 'minnow.autopilotMeta';

const ISOLATION_MODES = new Set<AutopilotIsolationMode>([
  'auto',
  'off',
  'per-task',
  'per-wave',
  'per-board',
]);

const SHELL_SANDBOX_MODES = new Set<AutopilotShellSandboxMode>([
  'off',
  'prefer',
  'require',
]);

const CONTINUE_SMART_ROUTE_MODES = new Set<AutopilotContinueSmartRoute>([
  'off',
  'conservative',
  'aggressive',
]);

let cachedAutopilot: AutopilotMeta | null = null;

function clampConcurrency(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(20, Math.max(1, Math.round(value)));
}

function clampAttempts(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(10, Math.max(1, Math.round(value)));
}

function clampSelfHealRounds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(6, Math.max(0, Math.round(value)));
}

function clampInfraTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(600_000, Math.max(30_000, Math.round(value)));
}

/** `0` = no cap; other values clamp to 5 min – 24 h. */
export function clampAttemptWallClockMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ATTEMPT_WALL_CLOCK_MS;
  if (value <= 0) return 0;
  return Math.min(MAX_ATTEMPT_WALL_CLOCK_MS, Math.max(MIN_ATTEMPT_WALL_CLOCK_MS, Math.round(value)));
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function parseIsolationMode(value: unknown): AutopilotIsolationMode {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (ISOLATION_MODES.has(raw as AutopilotIsolationMode)) {
    return raw as AutopilotIsolationMode;
  }
  return DEFAULT_AUTOPILOT_META.isolationMode;
}

function parseShellSandboxMode(value: unknown): AutopilotShellSandboxMode {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (SHELL_SANDBOX_MODES.has(raw as AutopilotShellSandboxMode)) {
    return raw as AutopilotShellSandboxMode;
  }
  return DEFAULT_AUTOPILOT_META.shellSandbox;
}

export function parseContinueSmartRoute(value: unknown): AutopilotContinueSmartRoute {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (CONTINUE_SMART_ROUTE_MODES.has(raw as AutopilotContinueSmartRoute)) {
    return raw as AutopilotContinueSmartRoute;
  }
  return DEFAULT_AUTOPILOT_META.continueSmartRoute;
}

function parseStringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Merge persisted `autopilot` with shipped defaults and clamps. */
export function parseAutopilotMeta(raw: unknown): AutopilotMeta {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_AUTOPILOT_META };
  }
  const block = raw as Record<string, unknown>;
  return {
    defaultStatus: foldAutopilotDefaultStatus(block),
    maxConcurrentTasks: clampConcurrency(
      block.maxConcurrentTasks,
      DEFAULT_AUTOPILOT_META.maxConcurrentTasks,
    ),
    isolationMode: parseIsolationMode(block.isolationMode),
    shellSandbox: parseShellSandboxMode(block.shellSandbox),
    maxTestAttempts: clampAttempts(
      block.maxTestAttempts,
      DEFAULT_AUTOPILOT_META.maxTestAttempts,
    ),
    maxBuildAttempts: clampAttempts(
      block.maxBuildAttempts,
      DEFAULT_AUTOPILOT_META.maxBuildAttempts,
    ),
    maxFinalTestAttempts: clampAttempts(
      block.maxFinalTestAttempts,
      DEFAULT_AUTOPILOT_META.maxFinalTestAttempts,
    ),
    continueSmartRoute: parseContinueSmartRoute(block.continueSmartRoute),
    plannerProviderId: parseStringField(block.plannerProviderId),
    plannerModelId: parseStringField(block.plannerModelId),
    selfHealMaxRounds: clampSelfHealRounds(
      block.selfHealMaxRounds,
      DEFAULT_AUTOPILOT_META.selfHealMaxRounds,
    ),
    maxEnvFixAttempts: clampAttempts(
      block.maxEnvFixAttempts,
      DEFAULT_AUTOPILOT_META.maxEnvFixAttempts,
    ),
    autoProvisionInfra: parseBool(block.autoProvisionInfra, DEFAULT_AUTOPILOT_META.autoProvisionInfra),
    infraProvisionTimeoutMs: clampInfraTimeoutMs(
      block.infraProvisionTimeoutMs,
      DEFAULT_AUTOPILOT_META.infraProvisionTimeoutMs,
    ),
    attemptWallClockMs: clampAttemptWallClockMs(block.attemptWallClockMs),
    afkAutoRestartStalls: parseBool(block.afkAutoRestartStalls, DEFAULT_AUTOPILOT_META.afkAutoRestartStalls),
    guardCdOutsideWorktree: parseBool(block.guardCdOutsideWorktree, DEFAULT_AUTOPILOT_META.guardCdOutsideWorktree),
  };
}

function readLocalAutopilotMeta(): AutopilotMeta {
  try {
    const raw = localStorage.getItem(AUTOPILOT_META_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AUTOPILOT_META };
    return parseAutopilotMeta(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AUTOPILOT_META };
  }
}

function writeLocalAutopilotMeta(config: AutopilotMeta): void {
  localStorage.setItem(AUTOPILOT_META_STORAGE_KEY, JSON.stringify(config));
}

async function fetchAutopilotFromServer(): Promise<AutopilotMeta> {
  const res = await fetch('/api/config/meta', { cache: 'no-store' });
  if (!res.ok) return readLocalAutopilotMeta();
  const meta = (await res.json()) as Record<string, unknown>;
  return parseAutopilotMeta(meta.autopilot);
}

/** Load global autopilot meta (cached until reset). */
export async function loadAutopilotMeta(): Promise<AutopilotMeta> {
  if (cachedAutopilot) {
    return parseAutopilotMeta(cachedAutopilot);
  }

  const serverUp = await detectConfigServer();
  cachedAutopilot = serverUp
    ? await fetchAutopilotFromServer()
    : readLocalAutopilotMeta();
  writeLocalAutopilotMeta(cachedAutopilot);
  return cachedAutopilot;
}

/** Last loaded value or localStorage fallback before first async load. */
export function getAutopilotMetaSync(): AutopilotMeta {
  return parseAutopilotMeta(cachedAutopilot ?? readLocalAutopilotMeta());
}

/** Clear cache (tests). */
export function resetAutopilotMetaCache(): void {
  cachedAutopilot = null;
}

/** Override cache for tests (no localStorage). */
export function setAutopilotMetaForTests(config: Partial<AutopilotMeta>): void {
  cachedAutopilot = parseAutopilotMeta({
    ...DEFAULT_AUTOPILOT_META,
    ...config,
  });
}

/** Global per-task test-failure threshold (no per-board override). */
export function resolveMaxTaskTestAttempts(): number {
  return getAutopilotMetaSync().maxTestAttempts ?? FALLBACK_MAX_TEST_ATTEMPTS;
}

/** Global per-task build-failure threshold (no per-board override). */
export function resolveMaxTaskBuildAttempts(): number {
  return getAutopilotMetaSync().maxBuildAttempts ?? FALLBACK_MAX_BUILD_ATTEMPTS;
}

/** Global final integration test threshold (no per-board override). */
export function resolveMaxFinalTestAttempts(): number {
  return getAutopilotMetaSync().maxFinalTestAttempts ?? FALLBACK_MAX_FINAL_TEST_ATTEMPTS;
}

/** Max self-heal infra rounds before unconditional quarantine. */
export function resolveSelfHealMaxRounds(): number {
  return getAutopilotMetaSync().selfHealMaxRounds;
}

/** Max env-fixer sub-agent attempts on an infra failure before quarantine. */
export function resolveMaxEnvFixAttempts(): number {
  return getAutopilotMetaSync().maxEnvFixAttempts ?? DEFAULT_AUTOPILOT_META.maxEnvFixAttempts;
}

/** Whether infra auto-provisioning is enabled. */
export function resolveAutoProvisionInfra(): boolean {
  return getAutopilotMetaSync().autoProvisionInfra;
}

/** Timeout (ms) for infra provisioning commands. */
export function resolveInfraProvisionTimeoutMs(): number {
  return getAutopilotMetaSync().infraProvisionTimeoutMs;
}

/** Whether stalling tasks should be auto-nudged (true) or quarantined immediately (false). */
export function resolveAfkAutoRestartStalls(): boolean {
  return getAutopilotMetaSync().afkAutoRestartStalls;
}

/** Whether the worktree cd-guard rewrite is active (client-side resolver for parity). */
export function resolveGuardCdOutsideWorktree(): boolean {
  return getAutopilotMetaSync().guardCdOutsideWorktree;
}

/** Persist partial global autopilot via PUT /api/config/meta and mirror locally. */
export async function saveAutopilotMeta(
  patch: Partial<AutopilotMeta>,
): Promise<AutopilotMeta> {
  const current = await loadAutopilotMeta();
  const merged = parseAutopilotMeta({ ...current, ...patch });

  cachedAutopilot = merged;
  writeLocalAutopilotMeta(merged);

  await fetch('/api/config/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autopilot: merged }),
  });

  return merged;
}
