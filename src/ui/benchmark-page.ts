import { showToast } from './toast';
import '../styles/benchmark-page.css';
import '../styles/transcript-view.css';
import '../styles/sub-agent-drawer.css';

import type {
  BenchmarkCellResult,
  BenchmarkTier,
  CampaignProgressEvent,
  ModelAggregate,
} from '../benchmark/campaign-types.ts';
import { getStandardPack, hasFullTierPack, preloadBundledFullPacks, preloadMiniPacks, resolveStandardItems } from '../benchmark/standard/pack-loader.ts';
import { runBenchmarkCampaign } from '../benchmark/campaign-runner.ts';
import { loadImportedStandardDatasets } from '../benchmark/campaign-persistence.ts';
import {
  addTargetToRoster,
  getActiveTargetFromDom,
  loadRoster,
  removeTargetFromRoster,
  saveRoster,
} from '../benchmark/roster.ts';
import {
  initBenchmarkRosterPicker,
  readBenchmarkRosterPickerSelection,
  refreshBenchmarkRosterPicker,
} from './benchmark/roster-picker.ts';
import {
  initBenchmarkApp,
  navigateBenchmarkTab,
  notifyCampaignComplete,
  onBenchmarkHashChange,
} from './benchmark/benchmark-app.ts';
import {
  refreshOverviewPanel,
  setOverviewRunState,
  updateOverviewLiveAggregates,
} from './benchmark/overview-panel.ts';
import {
  attachCompletedRun,
  clearMultiModelCampaign,
  findSessionByTestId,
  getAllTargetSessions,
  getCampaignMaxConcurrency,
  getSelectedTargetKey,
  getTargetSession,
  initModelRunCards,
  initMultiModelCampaign,
  isMultiModelCampaignActive,
  markTargetDone,
  markTargetRunning,
  markTargetStopped,
  renderModelCards,
  setScheduleTogglesDisabled,
  syncScheduleSectionVisibility,
  targetKeyForRun,
  updateTargetProgress,
  type TargetLiveSession,
} from './benchmark/model-run-cards.ts';

import { aggregateRunScore, computeSuiteResultStats } from '../benchmark/scoring.ts';
import { runBenchmark, resolveBenchmarkSuites } from '../benchmark/runner.ts';
import {
  clearActiveBenchmarkSession,
  loadActiveBenchmarkSession,
  remainingSuiteIds,
  saveActiveBenchmarkSession,
  type ActiveBenchmarkSession,
} from '../benchmark/active-run-session.ts';
import {
  clearAllRuns,
  listRuns,
  loadRun,
  type BenchmarkRunSummary,
} from '../benchmark/persistence.ts';
import type {
  BenchmarkPreset,
  BenchmarkRun,
  BenchmarkProgressEvent,
  SuiteId,
  TestResult,
} from '../benchmark/types.ts';
import { getActiveModelIdFromDom } from '../benchmark/resolve-binding.ts';
import {
  closeBenchmarkTranscriptDrawer,
  openBenchmarkTranscriptDrawer,
  type BenchmarkTranscriptRunMeta,
} from './benchmark-transcript-drawer.ts';
import { SUITE_LABELS } from './benchmark-transcript-labels.ts';
import { setStatus } from './status';
import { appConfirm } from './app-dialog';
import { iconHtml } from './icon';
import { isOsAppHash, isOsEmbedded } from '../os/page-bridge';
import { isAppAvailable } from '../os/app-preferences';
import { requestCloseWindowApp, registerWindowTeardown } from '../os/window-mounted-apps';
import { navigateToDesktop } from '../os/router';

/** How a benchmark run was started from the run bar. */
export type BenchmarkStartMode = 'quick' | 'full' | 'selected';

/** History dropdown value to return from a saved-run view to the live panel. */
const HISTORY_CURRENT_VALUE = '__current__';

/** Display order for suite toggle buttons in the run bar. */
const SUITE_TOGGLE_ORDER: SuiteId[] = [
  'capability',
  'speed',
  'tools',
  'skills',
  'coding',
];

let abortController: AbortController | null = null;
/** Bumped on Stop or new Run so in-flight `startRun` finally blocks do not fight UI reset. */
let benchmarkRunGeneration = 0;
let lastRun: BenchmarkRun | null = null;
let historySummaries: BenchmarkRunSummary[] = [];

/** Tracks in-flight UI while a run is active. */
let liveRunActive = false;
/** Finished probes in the current (or last cancelled) run — used for transcript drill-down before `lastRun` is set. */
const liveTestResults = new Map<string, TestResult>();
/** Run header for the transcript drawer during an active or partial run. */
let liveRunDrawerMeta: BenchmarkTranscriptRunMeta | null = null;
let liveSuiteIds: SuiteId[] = [];
let liveTestsDone = 0;
let liveSuiteIndex = 0;
let liveTestsInSuite = 0;
/** Academic benchmark cells finished in the current run (keyed by cellId). */
const liveStandardCells = new Map<string, BenchmarkCellResult>();
/** Expected academic item count for the active run (for progress percentage). */
let liveStandardTotal = 0;
/** Academic pack ids selected when the current run started. */
let liveStandardPackIds: string[] = [];
/** Test card currently showing the running spinner (at most one). */
let liveCurrentTestId: string | null = null;
/** Metadata for the in-flight probe (used when marking Stopped on cancel). */
let liveCurrentTestMeta: { testId: string; suite: SuiteId; label: string } | null = null;
/** User is viewing a saved run in the main panel while a live run may still be updating. */
let browsingHistory = false;
/** Stable id for the in-flight run (matches persisted session and saved run). */
let liveRunId: string | null = null;
/** How the active run was started (for session restore labels). */
let liveStartMode: BenchmarkStartMode = 'selected';

function getBenchmarkRoot(): HTMLElement | null {
  return document.getElementById('benchmarkView');
}

function getChatShell(): HTMLElement | null {
  return document.getElementById('appBody');
}

function formatScore(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function formatMetric(n: number, suffix = ''): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 100) return `${Math.round(n)}${suffix}`;
  return `${n.toFixed(1)}${suffix}`;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusText(result: TestResult): string {
  if (result.skipped) return result.skipReason ?? 'Skipped';
  if (result.passed) return 'Pass';
  return 'Fail';
}

function iconSvg(kind: 'pass' | 'fail' | 'skip' | 'running' | 'pending'): string {
  const names = {
    pass: 'statusPass',
    fail: 'statusFail',
    skip: 'statusSkip',
    running: 'statusRunning',
    pending: 'statusPending',
  } as const;
  const spinClass = kind === 'running' ? ' benchmark-test-icon--spin' : '';
  return iconHtml(names[kind], { className: `benchmark-test-icon${spinClass}` });
}

function cardState(result: TestResult): string {
  if (result.skipped) return 'is-skip';
  if (result.passed) return 'is-pass';
  return 'is-fail';
}

function cardIconKind(result: TestResult): 'pass' | 'fail' | 'skip' {
  if (result.skipped) return 'skip';
  if (!result.passed) return 'fail';
  return 'pass';
}

function testCardDomId(testId: string, suffix: string): string {
  const slug = testId.replace(/[^a-zA-Z0-9-]/g, '-');
  return `benchmark-${suffix}-${slug}`;
}

function setSummaryVisible(visible: boolean): void {
  const el = document.getElementById('benchmarkSummary');
  if (el instanceof HTMLElement) {
    el.hidden = !visible;
  }
}

function renderStoppedTestCard(testId: string, suite: SuiteId, label: string): string {
  const titleId = testCardDomId(testId, 'title');
  const ariaLabel = `View transcript: ${label}, stopped`;
  return `<article class="benchmark-test-card is-stopped is-fail" data-test-id="${escapeHtml(testId)}" role="button" tabindex="0" aria-label="${escapeHtml(ariaLabel)}" aria-labelledby="${escapeHtml(titleId)}">
    <div class="benchmark-test-card-status" aria-hidden="true">${iconSvg('fail')}</div>
    <div class="benchmark-test-card-body">
      <h3 class="benchmark-test-card-title" id="${escapeHtml(titleId)}">${escapeHtml(label)}</h3>
    </div>
    <p class="benchmark-test-card-meta">Stopped</p>
  </article>`;
}

function renderRunningTestCard(testId: string, suite: SuiteId, label: string): string {
  const titleId = testCardDomId(testId, 'title');
  const ariaLabel = `View transcript: ${label}, running`;
  return `<article class="benchmark-test-card is-running is-current" data-test-id="${escapeHtml(testId)}" role="button" tabindex="0" aria-busy="true" aria-label="${escapeHtml(ariaLabel)}" aria-labelledby="${escapeHtml(titleId)}">
    <div class="benchmark-test-card-status" aria-hidden="true">${iconSvg('running')}</div>
    <div class="benchmark-test-card-body">
      <h3 class="benchmark-test-card-title" id="${escapeHtml(titleId)}">${escapeHtml(label)}</h3>
    </div>
    <p class="benchmark-test-card-meta">Running…</p>
  </article>`;
}

function renderTestCard(result: TestResult, animate = false): string {
  const state = cardState(result);
  const icon = cardIconKind(result);
  const meta = `${formatDurationMs(result.durationMs)} · ${statusText(result)}`;

  const titleId = testCardDomId(result.testId, 'title');
  const ariaLabel = `View transcript: ${result.label}, ${statusText(result)}`;

  return `<article class="benchmark-test-card ${state}${animate ? ' is-entering' : ''}" data-test-id="${escapeHtml(result.testId)}" role="button" tabindex="0" aria-label="${escapeHtml(ariaLabel)}" aria-labelledby="${escapeHtml(titleId)}">
    <div class="benchmark-test-card-status" aria-hidden="true">${iconSvg(icon)}</div>
    <div class="benchmark-test-card-body">
      <h3 class="benchmark-test-card-title" id="${escapeHtml(titleId)}">${escapeHtml(result.label)}</h3>
    </div>
    <p class="benchmark-test-card-meta">${escapeHtml(meta)}</p>
  </article>`;
}

/** Resolve a test result from a run by card `data-test-id`. */
export function resolveTestResultForCard(
  run: BenchmarkRun | null,
  testId: string,
): TestResult | null {
  if (!run) return null;
  for (const suite of run.suites) {
    const found = suite.tests.find((t) => t.testId === testId);
    if (found) return found;
  }
  return null;
}

function syntheticStoppedResult(testId: string, suite: SuiteId, label: string): TestResult {
  return {
    testId,
    suite,
    label,
    passed: false,
    skipped: false,
    durationMs: 0,
    score: 0,
    details: 'Benchmark run was stopped during this test.',
    transcriptMeta: {
      error: 'No transcript — the benchmark was stopped before this test finished.',
    },
  };
}

function syntheticRunningResult(testId: string, suite: SuiteId, label: string): TestResult {
  return {
    testId,
    suite,
    label,
    passed: false,
    skipped: false,
    durationMs: 0,
    score: 0,
    transcriptMeta: {
      error: 'This test is still running. Open again after it finishes to see the transcript.',
    },
  };
}

/** Resolve a test for transcript drill-down (live map, then saved run). */
export function resolveTestForTranscript(testId: string): TestResult | null {
  if (isMultiModelCampaignActive()) {
    const session = findSessionByTestId(testId);
    const fromSession = session?.testResults.get(testId);
    if (fromSession) return fromSession;
    if (session?.completedRun) {
      return resolveTestResultForCard(session.completedRun, testId);
    }
  }
  const live = liveTestResults.get(testId);
  if (live) return live;
  return resolveTestResultForCard(lastRun, testId);
}

/** Convert an Academic benchmark cell into a TestResult for the transcript drawer. */
function standardCellToTestResult(cell: BenchmarkCellResult): TestResult {
  return {
    testId: cell.testId,
    suite: 'capability',
    label: cell.label,
    passed: cell.passed,
    skipped: cell.skipped,
    durationMs: cell.durationMs,
    ttftMs: cell.ttftMs,
    tokPerSec: cell.tokPerSec,
    score: cell.score,
    details: cell.details,
    transcript: cell.transcript,
    transcriptMeta: cell.transcriptMeta,
  };
}

/** Resolve an Academic cell by `data-cell-id` for transcript drill-down. */
export function resolveStandardCellForTranscript(cellId: string): BenchmarkCellResult | null {
  return liveStandardCells.get(cellId) ?? null;
}

function transcriptRunMetaForCell(cell: BenchmarkCellResult): BenchmarkTranscriptRunMeta | null {
  if (isMultiModelCampaignActive()) {
    const session = getTargetSession(cell.targetKey);
    if (session?.drawerMeta) return session.drawerMeta;
  }
  return transcriptRunMeta();
}

function resolveTestFromCard(card: HTMLElement): TestResult | null {
  const cellId = card.dataset.cellId;
  if (cellId) {
    const cell = liveStandardCells.get(cellId);
    if (cell) return standardCellToTestResult(cell);
  }

  const testId = card.dataset.testId;
  if (!testId) return null;

  const found = resolveTestForTranscript(testId);
  if (found) return found;

  const suiteEl = card.closest<HTMLElement>('[data-suite]');
  const suite = suiteEl?.dataset.suite as SuiteId | undefined;
  const label =
    card.querySelector('.benchmark-test-card-title')?.textContent?.trim() ?? testId;
  if (!suite) return null;

  if (card.classList.contains('is-stopped')) {
    return syntheticStoppedResult(testId, suite, label);
  }
  if (card.classList.contains('is-running')) {
    return syntheticRunningResult(testId, suite, label);
  }
  return null;
}

function transcriptRunMeta(): BenchmarkTranscriptRunMeta | null {
  if (isMultiModelCampaignActive()) {
    const key = getSelectedTargetKey();
    const session = key ? getTargetSession(key) : null;
    if (session?.drawerMeta) return session.drawerMeta;
  }
  if (liveRunDrawerMeta) return liveRunDrawerMeta;
  if (!lastRun) return null;
  return {
    preset: lastRun.preset,
    modelId: lastRun.model.id,
    startedAt: lastRun.startedAt,
  };
}

function suiteStatsFromTests(tests: TestResult[]): ReturnType<typeof computeSuiteResultStats> {
  return computeSuiteResultStats(tests);
}

function buildPartialBenchmarkRun(
  meta: BenchmarkTranscriptRunMeta,
  results: Map<string, TestResult>,
  suiteIds: SuiteId[],
): BenchmarkRun {
  const suites: BenchmarkRun['suites'] = [];
  for (const suiteId of suiteIds) {
    const tests = [...results.values()].filter((t) => t.suite === suiteId);
    if (!tests.length) continue;
    suites.push({
      id: suiteId,
      label: SUITE_LABELS[suiteId],
      ...suiteStatsFromTests(tests),
      tests,
    });
  }

  return {
    id: `partial-${meta.startedAt}`,
    startedAt: meta.startedAt,
    durationMs: 0,
    preset: meta.preset,
    provider: { id: '', baseUrl: '' },
    model: { id: meta.modelId },
    totalScore: suites.length ? aggregateRunScore(suites) : 0,
    headlineTtftMs: 0,
    headlineTokPerSec: 0,
    modeMatrixPassed: 0,
    toolsPassed: suites.find((s) => s.id === 'tools')?.passed ?? 0,
    skillsPassed: suites.find((s) => s.id === 'skills')?.passed ?? 0,
    suites,
  };
}

function commitPartialRunFromLive(): void {
  if (!liveRunDrawerMeta || liveTestResults.size === 0) return;
  lastRun = buildPartialBenchmarkRun(liveRunDrawerMeta, liveTestResults, liveSuiteIds);
}

function completedSuitesFromLiveProgress(): BenchmarkRun['suites'] {
  if (!liveRunDrawerMeta || liveSuiteIndex <= 0) return [];
  return buildPartialBenchmarkRun(
    liveRunDrawerMeta,
    liveTestResults,
    liveSuiteIds.slice(0, liveSuiteIndex),
  ).suites;
}

function persistActiveRunSession(): void {
  if (!liveRunDrawerMeta || !liveRunId || !isLiveRunInProgress()) return;
  saveActiveBenchmarkSession({
    version: 1,
    runId: liveRunId,
    startedAt: liveRunDrawerMeta.startedAt,
    preset: liveRunDrawerMeta.preset,
    startMode: liveStartMode,
    suiteIds: liveSuiteIds,
    modelId: liveRunDrawerMeta.modelId,
    completedSuites: completedSuitesFromLiveProgress(),
    completedTests: [...liveTestResults.values()],
    status: 'running',
  });
}

function clearActiveRunPersistence(): void {
  clearActiveBenchmarkSession();
}

function applyActiveSessionToLiveState(session: ActiveBenchmarkSession): void {
  liveRunId = session.runId;
  liveStartMode = session.startMode;
  liveRunDrawerMeta = {
    preset: session.preset,
    modelId: session.modelId,
    startedAt: session.startedAt,
  };
  liveSuiteIds = [...session.suiteIds];
  liveSuiteIndex = session.completedSuites.length;
  liveTestsDone = session.completedTests.length;
  liveRunActive = true;
  liveCurrentTestId = null;
  liveCurrentTestMeta = null;
  liveTestResults.clear();
  for (const result of session.completedTests) {
    liveTestResults.set(result.testId, result);
  }
}

function openTranscriptForCard(card: HTMLElement): void {
  const cellId = card.dataset.cellId;
  if (cellId) {
    const cell = liveStandardCells.get(cellId);
    if (cell) {
      const meta = transcriptRunMetaForCell(cell);
      if (!meta) return;
      openBenchmarkTranscriptDrawer(standardCellToTestResult(cell), meta, {
        suiteLabel: standardPackLabel(cell.suiteId),
      });
      return;
    }
  }

  const test = resolveTestFromCard(card);
  const meta = transcriptRunMeta();
  if (!test || !meta) return;
  openBenchmarkTranscriptDrawer(test, meta);
}

function onBenchmarkTestCardClick(ev: MouseEvent): void {
  const card = (ev.target as HTMLElement).closest<HTMLElement>('.benchmark-test-card');
  if (!card) return;
  openTranscriptForCard(card);
}

function onBenchmarkTestCardKeydown(ev: KeyboardEvent): void {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const card = (ev.target as HTMLElement).closest<HTMLElement>('.benchmark-test-card');
  if (!card) return;
  ev.preventDefault();
  openTranscriptForCard(card);
}

function setProgressVisible(visible: boolean): void {
  const el = document.getElementById('benchmarkProgress');
  if (el instanceof HTMLElement) {
    el.hidden = !visible;
  }
}

function updateProgressBar(pct: number, label: string): void {
  const track = document.getElementById('benchmarkProgress');
  const fill = document.getElementById('benchmarkProgressFill');
  const labelEl = document.getElementById('benchmarkProgressLabel');
  const pctEl = document.getElementById('benchmarkProgressPct');
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));

  if (track) {
    track.setAttribute('aria-valuenow', String(clamped));
    track.setAttribute('aria-valuetext', label);
  }
  if (fill instanceof HTMLElement) {
    fill.style.width = `${clamped}%`;
  }
  if (labelEl) labelEl.textContent = label;
  if (pctEl) pctEl.textContent = `${clamped}%`;
}

function ensureSuiteSection(suiteId: SuiteId, running = false): HTMLElement | null {
  const mount = document.getElementById('benchmarkSuites');
  if (!mount) return null;

  let section = mount.querySelector<HTMLElement>(`[data-suite="${suiteId}"]`);
  if (!section) {
    section = document.createElement('section');
    section.className = `benchmark-suite-block${running ? ' is-active' : ''}`;
    section.dataset.suite = suiteId;
    section.innerHTML = `
      <header class="benchmark-suite-block-header">
        <h2>${escapeHtml(SUITE_LABELS[suiteId])}</h2>
        <span class="benchmark-suite-block-score" data-suite-score>—</span>
      </header>
      <div class="benchmark-test-grid" data-suite-tests></div>
    `;
    mount.appendChild(section);
  } else if (running) {
    section.classList.add('is-active');
  }

  return section.querySelector<HTMLElement>('[data-suite-tests]');
}

function updateSuiteScore(suiteId: SuiteId, passed: number, total: number, score: number): void {
  const mount = document.getElementById('benchmarkSuites');
  const scoreEl = mount?.querySelector(
    `[data-suite="${suiteId}"] [data-suite-score]`,
  );
  if (scoreEl) {
    scoreEl.textContent = `${passed}/${total} · ${formatScore(score)}`;
  }
}

function clearCurrentRunningTestCard(): void {
  if (!liveCurrentTestId) return;
  const prev = document.querySelector<HTMLElement>(
    `.benchmark-test-card.is-current[data-test-id="${CSS.escape(liveCurrentTestId)}"]`,
  );
  prev?.classList.remove('is-current');
  liveCurrentTestId = null;
  liveCurrentTestMeta = null;
}

/** Replace the in-flight card with an X icon and "Stopped" when the run is aborted. */
function markCurrentTestAsStopped(): void {
  const meta = liveCurrentTestMeta;
  if (!meta) return;

  liveTestResults.set(meta.testId, syntheticStoppedResult(meta.testId, meta.suite, meta.label));

  const grid = document.querySelector<HTMLElement>(
    `[data-suite="${meta.suite}"] [data-suite-tests]`,
  );
  const existing = grid?.querySelector(`[data-test-id="${CSS.escape(meta.testId)}"]`);
  const html = renderStoppedTestCard(meta.testId, meta.suite, meta.label);

  if (existing) {
    existing.outerHTML = html;
  } else if (grid) {
    grid.insertAdjacentHTML('beforeend', html);
  }

  liveCurrentTestId = null;
  liveCurrentTestMeta = null;
}

function upsertRunningTestCard(suiteId: SuiteId, testId: string, label: string): void {
  clearCurrentRunningTestCard();
  liveCurrentTestId = testId;
  liveCurrentTestMeta = { testId, suite: suiteId, label };

  const grid = ensureSuiteSection(suiteId, true);
  if (!grid) return;

  const existing = grid.querySelector(`[data-test-id="${CSS.escape(testId)}"]`);
  const html = renderRunningTestCard(testId, suiteId, label);

  if (existing) {
    existing.outerHTML = html;
  } else {
    grid.insertAdjacentHTML('beforeend', html);
  }

  const card = grid.querySelector<HTMLElement>(`[data-test-id="${CSS.escape(testId)}"]`);
  if (card) {
    requestAnimationFrame(() => card.classList.remove('is-entering'));
  }
}

function upsertLiveTestCard(result: TestResult): void {
  if (liveCurrentTestId === result.testId) {
    liveCurrentTestId = null;
    liveCurrentTestMeta = null;
  }
  const grid = ensureSuiteSection(result.suite, true);
  if (!grid) return;

  const existing = grid.querySelector(`[data-test-id="${CSS.escape(result.testId)}"]`);
  const html = renderTestCard(result, true);

  if (existing) {
    existing.outerHTML = html;
  } else {
    grid.insertAdjacentHTML('beforeend', html);
  }

  const card = grid.querySelector<HTMLElement>(`[data-test-id="${CSS.escape(result.testId)}"]`);
  if (card) {
    requestAnimationFrame(() => card.classList.remove('is-entering'));
  }
}

function progressStartLabel(mode: BenchmarkStartMode): string {
  if (mode === 'quick') return 'Starting Quick preset…';
  if (mode === 'full') return 'Starting Full preset…';
  return 'Starting benchmark…';
}

function runningStatusLabel(mode: BenchmarkStartMode): string {
  if (mode === 'quick') return 'Quick benchmark running…';
  if (mode === 'full') return 'Full benchmark running…';
  return 'Benchmark running…';
}

/** Preset stored on the run record for history and transcript drill-down. */
export function storedPresetForStartMode(mode: BenchmarkStartMode): BenchmarkPreset {
  if (mode === 'quick') return 'quick';
  if (mode === 'full') return 'full';
  return 'custom';
}

/** Quick/Full apply preset toggles; selected leaves toggles unchanged. */
export function applyStartModeToToggles(mode: BenchmarkStartMode): void {
  if (mode === 'quick') applyPresetToToggles('quick');
  else if (mode === 'full') applyPresetToToggles('full');
}

function runningTestProgressLabel(suiteId: SuiteId, label: string): string {
  return `${SUITE_LABELS[suiteId]} · ${label}`;
}

function initLiveRunUI(mode: BenchmarkStartMode, suiteIds: SuiteId[]): void {
  browsingHistory = false;
  liveRunActive = true;
  liveSuiteIds = suiteIds;
  liveTestsDone = 0;
  liveSuiteIndex = 0;
  liveTestsInSuite = 0;
  liveCurrentTestId = null;
  liveCurrentTestMeta = null;
  liveTestResults.clear();
  liveStandardCells.clear();
  liveStandardTotal = 0;
  liveStandardPackIds = [];

  const mount = document.getElementById('benchmarkSuites');
  if (mount) {
    mount.innerHTML = '';
    mount.classList.add('is-live');
  }

  setSummaryVisible(false);

  setProgressVisible(true);
  updateProgressBar(0, progressStartLabel(mode));
  updateBackToCurrentControl();
}

function finishLiveRunUI(options?: {
  markCurrentStopped?: boolean;
  commitPartial?: boolean;
}): void {
  if (options?.markCurrentStopped) {
    markCurrentTestAsStopped();
  }
  if (options?.commitPartial) {
    commitPartialRunFromLive();
  }
  liveRunActive = false;
  liveCurrentTestId = null;
  liveCurrentTestMeta = null;
  setProgressVisible(false);
  document.getElementById('benchmarkSuites')?.classList.remove('is-live');

  if (lastRun) {
    renderSummary(lastRun);
  } else if (options?.markCurrentStopped || options?.commitPartial) {
    renderSummary(null);
  }

  for (const section of document.querySelectorAll('.benchmark-suite-block.is-active')) {
    section.classList.remove('is-active');
  }
}

function liveProgressPercent(): number {
  const suiteCount = Math.max(liveSuiteIds.length, 1);
  const suiteBase = (liveSuiteIndex / suiteCount) * 100;
  const suiteSlice = 100 / suiteCount;
  const within =
    liveTestsInSuite > 0
      ? Math.min(suiteSlice * 0.92, (liveTestsInSuite / (liveTestsInSuite + 1)) * suiteSlice)
      : suiteSlice * 0.08;
  return Math.min(98, suiteBase + within);
}

function sessionProgressPercent(session: TargetLiveSession): number {
  const suiteCount = Math.max(session.suiteIds.length, 1);
  const suiteBase = (session.suiteIndex / suiteCount) * 100;
  const suiteSlice = 100 / suiteCount;
  const within =
    session.testsInSuite > 0
      ? Math.min(
          suiteSlice * 0.92,
          (session.testsInSuite / (session.testsInSuite + 1)) * suiteSlice,
        )
      : suiteSlice * 0.08;
  return Math.min(98, suiteBase + within);
}

function showSessionInMainPanel(session: TargetLiveSession): void {
  if (session.completedRun) {
    lastRun = session.completedRun;
    liveRunDrawerMeta = session.drawerMeta;
    setSummaryVisible(true);
    renderSummary(session.completedRun);
    renderSuites(session.completedRun);
    return;
  }
  lastRun = null;
  liveRunDrawerMeta = session.drawerMeta;
  setSummaryVisible(false);
  renderSuitesFromSession(session);
}

function renderSuitesFromSession(session: TargetLiveSession): void {
  const mount = document.getElementById('benchmarkSuites');
  if (!mount) return;

  mount.innerHTML = '';
  mount.classList.add('is-live');

  for (const suiteId of session.suiteIds) {
    const suiteTests = [...session.testResults.values()].filter((t) => t.suite === suiteId);
    const grid = ensureSuiteSection(suiteId, session.currentTestMeta?.suite === suiteId);
    if (!grid) continue;

    for (const result of suiteTests) {
      if (result.testId === session.currentTestId) continue;
      grid.insertAdjacentHTML('beforeend', renderTestCard(result, false));
    }

    if (session.currentTestMeta?.suite === suiteId) {
      const { testId, suite, label } = session.currentTestMeta;
      grid.insertAdjacentHTML(
        'beforeend',
        renderRunningTestCard(testId, suite, label),
      );
      const card = grid.querySelector<HTMLElement>(`[data-test-id="${CSS.escape(testId)}"]`);
      card?.classList.add('is-current');
    }

    const stats = suiteStatsFromTests(suiteTests);
    const total =
      stats.passed +
      stats.failed +
      stats.skipped +
      (session.currentTestMeta?.suite === suiteId ? 1 : 0);
    updateSuiteScore(suiteId, stats.passed, Math.max(total, 1), stats.score);
  }
}

function markSessionCurrentTestStopped(session: TargetLiveSession): void {
  const meta = session.currentTestMeta;
  if (!meta) return;
  session.testResults.set(
    meta.testId,
    syntheticStoppedResult(meta.testId, meta.suite, meta.label),
  );
  session.currentTestId = null;
  session.currentTestMeta = null;
  if (session.targetKey === getSelectedTargetKey()) {
    const grid = document.querySelector<HTMLElement>(
      `[data-suite="${meta.suite}"] [data-suite-tests]`,
    );
    const existing = grid?.querySelector(`[data-test-id="${CSS.escape(meta.testId)}"]`);
    const html = renderStoppedTestCard(meta.testId, meta.suite, meta.label);
    if (existing) existing.outerHTML = html;
    else grid?.insertAdjacentHTML('beforeend', html);
  }
}

function upsertSessionRunningCard(session: TargetLiveSession, suiteId: SuiteId, testId: string, label: string): void {
  session.currentTestId = testId;
  session.currentTestMeta = { testId, suite: suiteId, label };
  if (session.targetKey !== getSelectedTargetKey()) return;

  const mount = document.getElementById('benchmarkSuites');
  if (!mount?.classList.contains('is-live')) {
    renderSuitesFromSession(session);
  }

  const grid = ensureSuiteSection(suiteId, true);
  if (!grid) return;
  const existing = grid.querySelector(`[data-test-id="${CSS.escape(testId)}"]`);
  const html = renderRunningTestCard(testId, suiteId, label);
  if (existing) existing.outerHTML = html;
  else grid.insertAdjacentHTML('beforeend', html);
  grid.querySelector<HTMLElement>(`[data-test-id="${CSS.escape(testId)}"]`)?.classList.add('is-current');
}

function upsertSessionLiveCard(session: TargetLiveSession, result: TestResult): void {
  if (session.currentTestId === result.testId) {
    session.currentTestId = null;
    session.currentTestMeta = null;
  }
  if (session.targetKey !== getSelectedTargetKey()) return;

  const grid = ensureSuiteSection(result.suite, true);
  if (!grid) return;
  const existing = grid.querySelector(`[data-test-id="${CSS.escape(result.testId)}"]`);
  const html = renderTestCard(result, true);
  if (existing) existing.outerHTML = html;
  else grid.insertAdjacentHTML('beforeend', html);
}

function onBenchmarkProgressForTarget(
  targetKey: string,
  event: BenchmarkProgressEvent,
): void {
  const session = getTargetSession(targetKey);
  if (!session) return;

  if (event.type === 'test-done') {
    session.testResults.set(event.result.testId, event.result);
  }

  if (browsingHistory || !liveRunActive) return;

  if (event.type === 'suite-start') {
    session.suiteIndex = session.suiteIds.indexOf(event.suiteId);
    session.testsInSuite = 0;
    const pct = sessionProgressPercent(session);
    session.progressPct = pct;
    session.progressLabel = `${event.label} suite`;
    updateTargetProgress(targetKey, pct, session.progressLabel);
    if (session.targetKey === getSelectedTargetKey()) {
      ensureSuiteSection(event.suiteId, true);
      updateProgressBar(pct, session.progressLabel);
    }
    return;
  }

  if (event.type === 'test-start') {
    upsertSessionRunningCard(session, event.suiteId, event.testId, event.label);
    const pct = sessionProgressPercent(session);
    const label = runningTestProgressLabel(event.suiteId, event.label);
    session.progressPct = pct;
    session.progressLabel = label;
    updateTargetProgress(targetKey, pct, label);
    if (session.targetKey === getSelectedTargetKey()) {
      updateProgressBar(pct, label);
    }
    return;
  }

  if (event.type === 'test-done') {
    session.testsDone += 1;
    session.testsInSuite += 1;
    upsertSessionLiveCard(session, event.result);
    const suiteTests = [...session.testResults.values()].filter(
      (t) => t.suite === event.result.suite,
    );
    const stats = suiteStatsFromTests(suiteTests);
    const total = stats.passed + stats.failed + stats.skipped;
    if (session.targetKey === getSelectedTargetKey()) {
      updateSuiteScore(event.result.suite, stats.passed, Math.max(total, 1), stats.score);
    }
    const pct = sessionProgressPercent(session);
    const label = `${SUITE_LABELS[event.result.suite]} · ${event.result.label}`;
    session.progressPct = pct;
    session.progressLabel = label;
    updateTargetProgress(targetKey, pct, label);
    if (session.targetKey === getSelectedTargetKey()) {
      updateProgressBar(pct, label);
    }
    return;
  }

  if (event.type === 'run-cancelled') {
    markSessionCurrentTestStopped(session);
    markTargetStopped(targetKey);
    return;
  }

  if (event.type === 'run-done') {
    session.completedRun = event.run;
    session.progressPct = 100;
    session.progressLabel = 'Complete';
    updateTargetProgress(targetKey, 100, session.progressLabel);
    if (session.targetKey === getSelectedTargetKey()) {
      for (const suite of event.run.suites) {
        updateSuiteScore(
          suite.id,
          suite.passed,
          suite.passed + suite.failed + suite.skipped,
          suite.score,
        );
        document.querySelector(`[data-suite="${suite.id}"]`)?.classList.remove('is-active');
      }
      updateProgressBar(100, 'Complete');
    }
  }
}

function onBenchmarkProgress(event: BenchmarkProgressEvent): void {
  if (event.type === 'test-done') {
    liveTestResults.set(event.result.testId, event.result);
  }

  if (browsingHistory || !liveRunActive) return;

  if (event.type === 'suite-start') {
    liveSuiteIndex = liveSuiteIds.indexOf(event.suiteId);
    liveTestsInSuite = 0;
    ensureSuiteSection(event.suiteId, true);
    updateProgressBar(liveProgressPercent(), `${event.label} suite`);
    persistActiveRunSession();
    return;
  }

  if (event.type === 'test-start') {
    upsertRunningTestCard(event.suiteId, event.testId, event.label);
    updateProgressBar(
      liveProgressPercent(),
      runningTestProgressLabel(event.suiteId, event.label),
    );
    return;
  }

  if (event.type === 'test-done') {
    liveTestsDone += 1;
    liveTestsInSuite += 1;
    upsertLiveTestCard(event.result);
    const suiteTests = [...liveTestResults.values()].filter(
      (t) => t.suite === event.result.suite,
    );
    const stats = suiteStatsFromTests(suiteTests);
    const total = stats.passed + stats.failed + stats.skipped;
    updateSuiteScore(event.result.suite, stats.passed, Math.max(total, 1), stats.score);
    updateProgressBar(
      liveProgressPercent(),
      `${SUITE_LABELS[event.result.suite]} · ${event.result.label}`,
    );
    persistActiveRunSession();
    return;
  }

  if (event.type === 'run-cancelled') {
    clearActiveRunPersistence();
    finishLiveRunUI({ markCurrentStopped: true, commitPartial: true });
    setRunning(false);
    return;
  }

  if (event.type === 'run-done') {
    browsingHistory = false;
    updateBackToCurrentControl();
    updateProgressBar(100, 'Complete');
    for (const suite of event.run.suites) {
      updateSuiteScore(
        suite.id,
        suite.passed,
        suite.passed + suite.failed + suite.skipped,
        suite.score,
      );
      const section = document.querySelector(`[data-suite="${suite.id}"]`);
      section?.classList.remove('is-active');
    }
    clearActiveRunPersistence();
    lastRun = event.run;
    renderSummary(lastRun);
    renderSuites(lastRun);
    if (liveStandardPackIds.length === 0) {
      finishLiveRunUI();
    }
    return;
  }
}

function renderSummary(run: BenchmarkRun | null): void {
  const root = document.getElementById('benchmarkSummary');
  if (!root) return;
  setSummaryVisible(true);
  if (!run) {
    root.innerHTML =
      '<p class="benchmark-empty">Pick Academic and/or Minnow tests above, then Run. Quick and Full apply Minnow presets.</p>';
    return;
  }
  const scoreClass =
    run.totalScore >= 0.85 ? 'is-good' : run.totalScore >= 0.6 ? 'is-warn' : 'is-bad';
  root.innerHTML = `
    <div class="benchmark-results-strip" role="group" aria-label="Run summary">
      <div class="benchmark-stat-cell">
        <span class="benchmark-stat-name">Overall score</span>
        <span class="benchmark-stat-val ${scoreClass}">${formatScore(run.totalScore)}</span>
      </div>
      <div class="benchmark-stat-cell">
        <span class="benchmark-stat-name" title="Time to first token">TTFT (median)</span>
        <span class="benchmark-stat-val">${formatDurationMs(run.headlineTtftMs)}</span>
      </div>
      <div class="benchmark-stat-cell">
        <span class="benchmark-stat-name" title="Tokens per second">Tok/s (median)</span>
        <span class="benchmark-stat-val">${formatMetric(run.headlineTokPerSec)}</span>
      </div>
      <div class="benchmark-stat-cell">
        <span class="benchmark-stat-name">Duration</span>
        <span class="benchmark-stat-val">${formatDurationMs(run.durationMs)}</span>
      </div>
    </div>
  `;
}

function renderSuites(run: BenchmarkRun): void {
  const mount = document.getElementById('benchmarkSuites');
  if (!mount) return;

  mount.classList.remove('is-live');
  mount.innerHTML = run.suites
    .map((suite) => {
      const cards = suite.tests.map((t) => renderTestCard(t, false)).join('');
      const total = suite.passed + suite.failed + suite.skipped;
      return `<section class="benchmark-suite-block" data-suite="${suite.id}">
        <header class="benchmark-suite-block-header">
          <h2>${escapeHtml(suite.label)}</h2>
          <span class="benchmark-suite-block-score">${suite.passed}/${total} · ${formatScore(suite.score)}</span>
        </header>
        <div class="benchmark-test-grid">${cards}</div>
      </section>`;
    })
    .join('');
}

function getStandardPackToggles(): string[] {
  const group = document.getElementById('benchmarkStandardToggles');
  if (!group) return [];
  return [...group.querySelectorAll<HTMLButtonElement>('.benchmark-standard-toggle')]
    .filter((btn) => btn.getAttribute('aria-pressed') === 'true')
    .map((btn) => btn.dataset.packId ?? '')
    .filter(Boolean);
}

/** True when at least one Minnow suite or Academic pack is selected on the Run tab. */
function hasSelectedBenchmarkWork(): boolean {
  return getSelectedSuites().length > 0 || getStandardPackToggles().length > 0;
}

function standardPackLabel(packId: string): string {
  return getStandardPack(packId)?.label ?? packId;
}

function countStandardItems(packIds: string[], tier: BenchmarkTier): number {
  let total = 0;
  for (const packId of packIds) {
    total += resolveStandardItems(packId, tier).length;
  }
  return total;
}

function validateFullTierSelection(
  standardPackIds: string[],
  tier: BenchmarkTier,
): string | null {
  if (tier !== 'full' || !standardPackIds.length) return null;
  const missing = standardPackIds.filter((id) => !hasFullTierPack(id));
  if (!missing.length) return null;
  const labels = missing.map((id) => standardPackLabel(id)).join(', ');
  return `Full dataset unavailable for ${labels}.`;
}

function standardCellProgressPercent(done: number): number {
  if (liveStandardTotal <= 0) return Math.min(95, done * 8);
  return Math.min(98, (done / liveStandardTotal) * 100);
}

function ensureStandardPackSection(packId: string, running = false): HTMLElement | null {
  const mount = document.getElementById('benchmarkSuites');
  if (!mount) return null;

  let section = mount.querySelector<HTMLElement>(`[data-suite="${packId}"]`);
  if (!section) {
    section = document.createElement('section');
    section.className = `benchmark-suite-block${running ? ' is-active' : ''}`;
    section.dataset.suite = packId;
    section.innerHTML = `
      <header class="benchmark-suite-block-header">
        <h2>${escapeHtml(standardPackLabel(packId))}</h2>
        <span class="benchmark-suite-block-score" data-suite-score>—</span>
      </header>
      <div class="benchmark-test-grid" data-suite-tests></div>
    `;
    mount.appendChild(section);
  } else if (running) {
    section.classList.add('is-active');
  }

  return section.querySelector<HTMLElement>('[data-suite-tests]');
}

function renderStandardCellCard(cell: BenchmarkCellResult, animate = false): string {
  const state = cell.skipped ? 'is-skip' : cell.passed ? 'is-pass' : 'is-fail';
  const icon = cell.skipped ? 'skip' : cell.passed ? 'pass' : 'fail';
  const status = cell.skipped ? 'Skipped' : cell.passed ? 'Pass' : 'Fail';
  const meta = `${formatDurationMs(cell.durationMs)} · ${status}`;
  const titleId = testCardDomId(cell.testId, 'title');
  const ariaLabel = `View transcript: ${cell.label}, ${status}`;

  return `<article class="benchmark-test-card ${state}${animate ? ' is-entering' : ''}" data-test-id="${escapeHtml(cell.testId)}" data-cell-id="${escapeHtml(cell.cellId)}" role="button" tabindex="0" aria-label="${escapeHtml(ariaLabel)}" aria-labelledby="${escapeHtml(titleId)}">
    <div class="benchmark-test-card-status" aria-hidden="true">${iconSvg(icon)}</div>
    <div class="benchmark-test-card-body">
      <h3 class="benchmark-test-card-title" id="${escapeHtml(titleId)}">${escapeHtml(cell.label)}</h3>
    </div>
    <p class="benchmark-test-card-meta">${escapeHtml(meta)}</p>
  </article>`;
}

function upsertStandardCellCard(cell: BenchmarkCellResult): void {
  const grid = ensureStandardPackSection(cell.suiteId, true);
  if (!grid) return;

  const existing = grid.querySelector(`[data-cell-id="${CSS.escape(cell.cellId)}"]`);
  const html = renderStandardCellCard(cell, true);
  if (existing) {
    existing.outerHTML = html;
  } else {
    grid.insertAdjacentHTML('beforeend', html);
  }

  const packCells = [...liveStandardCells.values()].filter((c) => c.suiteId === cell.suiteId);
  const passed = packCells.filter((c) => c.passed && !c.skipped).length;
  const total = packCells.length;
  const score = total ? passed / total : 0;
  updateSuiteScore(cell.suiteId as SuiteId, passed, total, score);

  const card = grid.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cell.cellId)}"]`);
  if (card) {
    requestAnimationFrame(() => card.classList.remove('is-entering'));
  }
}

function renderStandardCells(cells: BenchmarkCellResult[]): void {
  const mount = document.getElementById('benchmarkSuites');
  if (!mount) return;

  mount.classList.remove('is-live');
  mount.innerHTML = buildStandardCellsHtml(cells);
}

function appendStandardCellSections(cells: BenchmarkCellResult[]): void {
  const mount = document.getElementById('benchmarkSuites');
  if (!mount || !cells.length) return;

  mount.insertAdjacentHTML('beforeend', buildStandardCellsHtml(cells));
}

function buildStandardCellsHtml(cells: BenchmarkCellResult[]): string {
  const byPack = new Map<string, BenchmarkCellResult[]>();
  for (const cell of cells) {
    const list = byPack.get(cell.suiteId) ?? [];
    list.push(cell);
    byPack.set(cell.suiteId, list);
  }

  return [...byPack.entries()]
    .map(([packId, packCells]) => {
      const passed = packCells.filter((c) => c.passed && !c.skipped).length;
      const total = packCells.length;
      const score = total ? passed / total : 0;
      const cards = packCells.map((c) => renderStandardCellCard(c, false)).join('');
      return `<section class="benchmark-suite-block" data-suite="${escapeHtml(packId)}">
        <header class="benchmark-suite-block-header">
          <h2>${escapeHtml(standardPackLabel(packId))}</h2>
          <span class="benchmark-suite-block-score">${passed}/${total} · ${formatScore(score)}</span>
        </header>
        <div class="benchmark-test-grid">${cards}</div>
      </section>`;
    })
    .join('');
}

function renderSummaryFromAggregate(agg: ModelAggregate, durationMs: number): void {
  const root = document.getElementById('benchmarkSummary');
  if (!root) return;
  setSummaryVisible(true);
  const scoreClass =
    agg.totalScore >= 0.85 ? 'is-good' : agg.totalScore >= 0.6 ? 'is-warn' : 'is-bad';
  root.innerHTML = `
    <div class="benchmark-results-strip" role="group" aria-label="Run summary">
      <div class="benchmark-stat-cell">
        <span class="benchmark-stat-name">Overall score</span>
        <span class="benchmark-stat-val ${scoreClass}">${formatScore(agg.totalScore)}</span>
      </div>
      <div class="benchmark-stat-cell">
        <span class="benchmark-stat-name" title="Time to first token">TTFT (median)</span>
        <span class="benchmark-stat-val">${formatDurationMs(agg.headlineTtftMs)}</span>
      </div>
      <div class="benchmark-stat-cell">
        <span class="benchmark-stat-name" title="Tokens per second">Tok/s (median)</span>
        <span class="benchmark-stat-val">${formatMetric(agg.headlineTokPerSec)}</span>
      </div>
      <div class="benchmark-stat-cell">
        <span class="benchmark-stat-name">Duration</span>
        <span class="benchmark-stat-val">${formatDurationMs(durationMs)}</span>
      </div>
    </div>
  `;
}

function getStandardTier(): BenchmarkTier {
  const sel = document.getElementById('benchmarkStandardTier') as HTMLSelectElement | null;
  return sel?.value === 'full' ? 'full' : 'mini';
}

function renderRosterList(): void {
  const mount = document.getElementById('benchmarkRosterList');
  if (!mount) return;
  const roster = loadRoster();
  if (!roster.length) {
    mount.innerHTML = '<p class="benchmark-empty">No models yet. Pick a provider and model above, or use Use top-bar model.</p>';
    return;
  }
  mount.innerHTML = roster
    .map(
      (t) =>
        `<div class="benchmark-roster-chip" data-provider="${escapeHtml(t.providerId)}" data-model="${escapeHtml(t.modelId)}">
          <span>${escapeHtml(t.label ?? `${t.providerId} / ${t.modelId}`)}</span>
          <button type="button" class="benchmark-roster-remove" aria-label="Remove model">×</button>
        </div>`,
    )
    .join('');
  syncScheduleSectionVisibility(roster.length);
  for (const btn of mount.querySelectorAll<HTMLButtonElement>('.benchmark-roster-remove')) {
    btn.addEventListener('click', () => {
      const chip = btn.closest('.benchmark-roster-chip');
      const providerId = chip?.getAttribute('data-provider') ?? '';
      const modelId = chip?.getAttribute('data-model') ?? '';
      removeTargetFromRoster(providerId, modelId);
      renderRosterList();
      refreshOverviewPanel();
    });
  }
}

const liveCampaignAggregates: ModelAggregate[] = [];

function onCampaignProgress(event: CampaignProgressEvent): void {
  if (event.type === 'phase') {
    setOverviewRunState('running');
    return;
  }
  if (event.type === 'target-start') {
    markTargetRunning(event.targetKey);
    if (isMultiModelCampaignActive() && event.targetKey === getSelectedTargetKey()) {
      const session = getTargetSession(event.targetKey);
      if (session) showSessionInMainPanel(session);
    }
    return;
  }
  if (event.type === 'target-done') {
    const existing = liveCampaignAggregates.findIndex(
      (a) => a.targetKey === event.targetKey,
    );
    if (existing >= 0) liveCampaignAggregates[existing] = event.aggregate;
    else liveCampaignAggregates.push(event.aggregate);
    updateOverviewLiveAggregates([...liveCampaignAggregates]);
    refreshOverviewPanel();
    markTargetDone(event.targetKey, event.aggregate);
    return;
  }
  if (event.type === 'integration-progress') {
    if (isMultiModelCampaignActive()) {
      onBenchmarkProgressForTarget(event.targetKey, event.event);
    } else {
      onBenchmarkProgress(event.event);
    }
    return;
  }
  if (event.type === 'cell-done') {
    liveStandardCells.set(event.cell.cellId, event.cell);
    if (browsingHistory || !liveRunActive) return;
    upsertStandardCellCard(event.cell);
    const done = liveStandardCells.size;
    const label = `${standardPackLabel(event.cell.suiteId)} · ${event.cell.label}`;
    updateProgressBar(standardCellProgressPercent(done), label);
    return;
  }
  if (event.type === 'campaign-done') {
    setOverviewRunState('done', 100);
    updateOverviewLiveAggregates(event.campaign.aggregates);
    notifyCampaignComplete();
    for (const run of event.campaign.runs) {
      attachCompletedRun(targetKeyForRun(run), run);
    }
    if (isMultiModelCampaignActive()) {
      const key =
        getSelectedTargetKey() ??
        (event.campaign.runs[0] ? targetKeyForRun(event.campaign.runs[0]) : null);
      const session = key ? getTargetSession(key) : null;
      if (session) showSessionInMainPanel(session);
      else if (event.campaign.runs[0]) {
        lastRun = event.campaign.runs[0];
        renderSummary(lastRun);
        renderSuites(lastRun);
      } else if (event.campaign.cells.length) {
        const agg = event.campaign.aggregates[0];
        if (agg) renderSummaryFromAggregate(agg, event.campaign.durationMs);
        renderStandardCells([...liveStandardCells.values()]);
      }
      renderModelCards();
    } else if (event.campaign.runs[0]) {
      lastRun = event.campaign.runs[0];
      setSummaryVisible(true);
      renderSummary(lastRun);
      renderSuites(lastRun);
      if (event.campaign.cells.length) {
        for (const cell of event.campaign.cells) {
          liveStandardCells.set(cell.cellId, cell);
        }
        appendStandardCellSections([...liveStandardCells.values()]);
      }
    } else if (event.campaign.cells.length) {
      const agg = event.campaign.aggregates[0];
      if (agg) renderSummaryFromAggregate(agg, event.campaign.durationMs);
      renderStandardCells([...liveStandardCells.values()]);
    }
    finishLiveRunUI();
    void refreshHistorySelect();
    showToast(`Benchmark finished · ${event.campaign.targets.length} models`);
    return;
  }
  if (event.type === 'campaign-cancelled') {
    setOverviewRunState('idle');
    if (isMultiModelCampaignActive()) {
      for (const session of getAllTargetSessions()) {
        if (session.status !== 'done') {
          markSessionCurrentTestStopped(session);
          markTargetStopped(session.targetKey);
        }
      }
      const selected = getSelectedTargetKey();
      const session = selected ? getTargetSession(selected) : null;
      if (session) showSessionInMainPanel(session);
    }
  }
}

function getSuiteToggleButtons(): HTMLButtonElement[] {
  const group = document.getElementById('benchmarkSuiteToggles');
  if (!group) return [];
  return [...group.querySelectorAll<HTMLButtonElement>('.benchmark-suite-toggle')];
}

/** Reads pressed suite toggles (always visible; no hidden-panel guard). */
function getSelectedSuites(): SuiteId[] {
  return getSuiteToggleButtons()
    .filter((btn) => btn.getAttribute('aria-pressed') === 'true')
    .map((btn) => btn.dataset.suiteId as SuiteId)
    .filter((id): id is SuiteId => Boolean(id));
}

/** Option B: Quick/Full shortcuts set toggle state before run. */
function applyPresetToToggles(preset: BenchmarkPreset): void {
  const target = new Set(resolveBenchmarkSuites(preset));
  for (const btn of getSuiteToggleButtons()) {
    const id = btn.dataset.suiteId as SuiteId | undefined;
    if (!id) continue;
    const on = target.has(id);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function setSuiteTogglesDisabled(disabled: boolean): void {
  for (const btn of getSuiteToggleButtons()) {
    btn.toggleAttribute('disabled', disabled);
  }
}

function updateRunStopButton(running: boolean): void {
  const runBtn = document.getElementById('btnBenchmarkRun');
  if (!runBtn) return;
  runBtn.textContent = running ? 'Stop' : 'Run';
  const label = running ? 'Stop benchmark' : 'Run selected tests';
  runBtn.title = label;
  runBtn.setAttribute('aria-label', label);
}

function setRunning(running: boolean): void {
  const quick = document.getElementById('btnBenchmarkQuick');
  const full = document.getElementById('btnBenchmarkFull');
  const root = getBenchmarkRoot();
  quick?.toggleAttribute('disabled', running);
  full?.toggleAttribute('disabled', running);
  updateRunStopButton(running);
  setSuiteTogglesDisabled(running);
  setScheduleTogglesDisabled(running);
  root?.classList.toggle('is-running', running);
  syncClearHistoryButton();
}

function isBenchmarkRunActive(): boolean {
  return abortController != null && !abortController.signal.aborted;
}

function isLiveRunInProgress(): boolean {
  return liveRunActive || isBenchmarkRunActive();
}

function updateBackToCurrentControl(): void {
  const btn = document.getElementById('btnBenchmarkBackToCurrent');
  if (!btn) return;
  const show = browsingHistory && isLiveRunInProgress();
  btn.hidden = !show;
}

/** Rebuild the live suite panel from in-memory progress (after browsing saved history). */
function renderLiveRunFromState(): void {
  const mount = document.getElementById('benchmarkSuites');
  if (!mount) return;

  mount.innerHTML = '';
  mount.classList.add('is-live');

  setSummaryVisible(false);

  for (const suiteId of liveSuiteIds) {
    const suiteTests = [...liveTestResults.values()].filter((t) => t.suite === suiteId);
    const grid = ensureSuiteSection(suiteId, liveCurrentTestMeta?.suite === suiteId);
    if (!grid) continue;

    for (const result of suiteTests) {
      if (result.testId === liveCurrentTestId) continue;
      grid.insertAdjacentHTML(
        'beforeend',
        renderTestCard(result, false),
      );
    }

    if (liveCurrentTestMeta?.suite === suiteId) {
      upsertRunningTestCard(
        liveCurrentTestMeta.suite,
        liveCurrentTestMeta.testId,
        liveCurrentTestMeta.label,
      );
    }

    const stats = suiteStatsFromTests(suiteTests);
    const total =
      stats.passed +
      stats.failed +
      stats.skipped +
      (liveCurrentTestMeta?.suite === suiteId ? 1 : 0);
    updateSuiteScore(suiteId, stats.passed, Math.max(total, 1), stats.score);
  }

  setProgressVisible(liveRunActive);
  if (liveRunActive) {
    const label = liveCurrentTestMeta
      ? runningTestProgressLabel(liveCurrentTestMeta.suite, liveCurrentTestMeta.label)
      : 'Benchmark running…';
    updateProgressBar(liveProgressPercent(), label);
  }
}

function restoreCurrentRunView(): void {
  browsingHistory = false;
  const select = document.getElementById('benchmarkHistorySelect') as HTMLSelectElement | null;
  if (select && select.value !== '') {
    select.value = '';
  }
  updateBackToCurrentControl();

  if (isLiveRunInProgress()) {
    renderLiveRunFromState();
    setStatus('ok', 'Showing live benchmark run.');
    return;
  }

  if (lastRun) {
    renderSummary(lastRun);
    renderSuites(lastRun);
    setStatus('ok', `Showing latest run · ${formatScore(lastRun.totalScore)}`);
  }
}

function onRunStopClick(): void {
  if (isBenchmarkRunActive()) {
    stopRun();
    return;
  }
  abortController = null;
  void startRun('selected');
}

function syncLiveDrawerMetaFromRun(run: BenchmarkRun): void {
  liveRunDrawerMeta = {
    preset: run.preset,
    modelId: run.model.id,
    startedAt: run.startedAt,
  };
}

/** Enable Clear history when there is something to remove and no run is active. */
function syncClearHistoryButton(): void {
  const btn = document.getElementById('btnBenchmarkClearHistory') as HTMLButtonElement | null;
  if (!btn) return;
  const hasPersisted = historySummaries.length > 0;
  const hasPanelRun = Boolean(lastRun) || browsingHistory;
  btn.disabled = isBenchmarkRunActive() || (!hasPersisted && !hasPanelRun);
}

async function refreshHistorySelect(): Promise<void> {
  const select = document.getElementById('benchmarkHistorySelect') as HTMLSelectElement | null;
  if (!select) return;
  const previous = select.value;
  historySummaries = await listRuns();
  const currentOption = isLiveRunInProgress()
    ? `<option value="${HISTORY_CURRENT_VALUE}">Live run (in progress)</option>`
    : '';
  select.innerHTML =
    '<option value="">Open a saved run…</option>' +
    currentOption +
    historySummaries
      .filter((h) => h.id !== lastRun?.id)
      .map(
        (h) =>
          `<option value="${escapeHtml(h.id)}">${escapeHtml(h.startedAt)} · ${escapeHtml(h.modelId)} · ${formatScore(h.totalScore)}</option>`,
      )
      .join('');

  if (previous && historySummaries.some((h) => h.id === previous)) {
    select.value = previous;
  }
  syncClearHistoryButton();
}

async function onClearHistoryClick(): Promise<void> {
  if (isBenchmarkRunActive()) {
    setStatus('err', 'Stop the current run before clearing history.');
    return;
  }
  if (
    !(await appConfirm(
      'Delete all saved benchmark runs? This removes server and browser copies and cannot be undone.',
      { confirmLabel: 'Delete all', danger: true },
    ))
  ) {
    return;
  }

  await clearAllRuns();
  lastRun = null;
  browsingHistory = false;
  liveRunDrawerMeta = null;

  const select = document.getElementById('benchmarkHistorySelect') as HTMLSelectElement | null;
  if (select) select.value = '';

  closeBenchmarkTranscriptDrawer();
  clearMultiModelCampaign();
  renderSummary(null);
  const mount = document.getElementById('benchmarkSuites');
  if (mount) {
    mount.classList.remove('is-live');
    mount.innerHTML = '';
  }
  updateBackToCurrentControl();
  await refreshHistorySelect();
  showToast('Benchmark history cleared.');
}

/** Load a saved run into the main panel for viewing. */
async function onHistorySelectChange(): Promise<void> {
  const select = document.getElementById('benchmarkHistorySelect') as HTMLSelectElement | null;
  if (!select) return;

  const id = select.value;

  if (id === HISTORY_CURRENT_VALUE) {
    restoreCurrentRunView();
    return;
  }

  if (!id) {
    if (browsingHistory || isLiveRunInProgress()) {
      restoreCurrentRunView();
      return;
    }
    if (lastRun) {
      renderSummary(lastRun);
      renderSuites(lastRun);
    }
    return;
  }

  const loaded = await loadRun(id);
  if (!loaded) {
    setStatus('err', 'Could not load that benchmark run.');
    if (browsingHistory || isLiveRunInProgress()) {
      restoreCurrentRunView();
    } else if (lastRun) {
      renderSummary(lastRun);
      renderSuites(lastRun);
    }
    return;
  }

  browsingHistory = true;
  if (!isLiveRunInProgress()) {
    lastRun = loaded;
    syncLiveDrawerMetaFromRun(loaded);
  }
  renderSummary(loaded);
  renderSuites(loaded);
  updateBackToCurrentControl();
  setStatus('ok', `Loaded saved run · ${formatScore(loaded.totalScore)}`);
}

async function executeBenchmarkRun(options: {
  mode: BenchmarkStartMode;
  suiteIds: SuiteId[];
  preset: BenchmarkPreset;
  resume?: ActiveBenchmarkSession;
}): Promise<void> {
  const { mode, suiteIds, preset, resume } = options;

  if (resume) {
    await executeLegacyBenchmarkRun(options);
    return;
  }

  const targets = loadRoster();
  if (!targets.length) {
    setStatus('err', 'Add at least one model on the Run tab.');
    return;
  }

  const standardPackIds = getStandardPackToggles();
  const standardTier = getStandardTier();
  if (standardTier === 'full' && standardPackIds.length) {
    await preloadBundledFullPacks();
    await loadImportedStandardDatasets();
  }
  const fullTierError = validateFullTierSelection(standardPackIds, standardTier);
  if (fullTierError) {
    setStatus('err', fullTierError);
    return;
  }

  abortController?.abort();
  const generation = ++benchmarkRunGeneration;
  abortController = new AbortController();
  const runSignal = abortController.signal;
  setRunning(true);
  setStatus('ok', runningStatusLabel(mode));
  liveCampaignAggregates.length = 0;

  const startedAt = new Date().toISOString();
  if (targets.length > 1) {
    initMultiModelCampaign({ targets, suiteIds, preset, startedAt });
  } else {
    clearMultiModelCampaign();
  }

  const modelId = targets[0]?.modelId ?? 'unknown';
  liveRunId = startedAt.replace(/[:.]/g, '-');
  liveStartMode = mode;
  liveRunDrawerMeta = { preset, modelId, startedAt };

  initLiveRunUI(mode, suiteIds);
  if (isMultiModelCampaignActive()) {
    const first = getSelectedTargetKey();
    const session = first ? getTargetSession(first) : null;
    if (session) showSessionInMainPanel(session);
  }
  navigateBenchmarkTab('run', { replace: true });
  setOverviewRunState('running', 0);

  liveStandardPackIds = [...standardPackIds];
  liveStandardTotal = countStandardItems(standardPackIds, standardTier);
  liveStandardCells.clear();

  try {
    await runBenchmarkCampaign({
      targets,
      integrationSuites: suiteIds,
      standardPackIds,
      standardTier,
      preset,
      signal: runSignal,
      maxConcurrency: getCampaignMaxConcurrency(targets.length),
      persistPartialOnCancel: true,
      onProgress: (event) => {
        if (generation !== benchmarkRunGeneration) return;
        onCampaignProgress(event);
      },
    });
  } catch (err) {
    if (generation !== benchmarkRunGeneration) return;
    const aborted = runSignal.aborted;
    finishLiveRunUI({ markCurrentStopped: aborted, commitPartial: aborted });
    if (aborted) {
      setStatus('ok', 'Benchmark cancelled.');
      setOverviewRunState('idle');
    } else {
      setStatus('err', err instanceof Error ? err.message : String(err));
    }
  } finally {
    if (generation !== benchmarkRunGeneration) return;
    liveRunId = null;
    setRunning(false);
    abortController = null;
  }
}

async function executeLegacyBenchmarkRun(options: {
  mode: BenchmarkStartMode;
  suiteIds: SuiteId[];
  preset: BenchmarkPreset;
  resume?: ActiveBenchmarkSession;
}): Promise<void> {
  const { mode, suiteIds, preset, resume } = options;

  abortController?.abort();
  const generation = ++benchmarkRunGeneration;
  abortController = new AbortController();
  const runSignal = abortController.signal;
  setRunning(true);
  setStatus('ok', resume ? 'Resuming benchmark…' : runningStatusLabel(mode));

  const modelId = getActiveModelIdFromDom() ?? resume?.modelId ?? 'unknown';
  const startedAt = resume?.startedAt ?? new Date().toISOString();
  liveRunId = resume?.runId ?? startedAt.replace(/[:.]/g, '-');
  liveStartMode = resume?.startMode ?? mode;
  liveRunDrawerMeta = {
    preset,
    modelId,
    startedAt,
  };

  if (resume) {
    applyActiveSessionToLiveState(resume);
    renderLiveRunFromState();
    setProgressVisible(true);
    updateBackToCurrentControl();
  } else {
    initLiveRunUI(mode, suiteIds);
  }

  persistActiveRunSession();
  void refreshHistorySelect();

  const suitesToRun = resume ? remainingSuiteIds(resume) : suiteIds;
  if (!suitesToRun.length) {
    clearActiveRunPersistence();
    setRunning(false);
    abortController = null;
    return;
  }

  try {
    const run = await runBenchmark({
      preset,
      suites: suitesToRun,
      runId: liveRunId,
      resume: resume
        ? {
            runId: resume.runId,
            startedAt: resume.startedAt,
            priorSuites: resume.completedSuites,
          }
        : undefined,
      signal: runSignal,
      onProgress: (event) => {
        if (generation !== benchmarkRunGeneration) return;
        onBenchmarkProgress(event);
        if (event.type === 'run-cancelled') {
          setStatus('ok', 'Benchmark cancelled.');
          return;
        }
        if (event.type === 'run-done') {
          lastRun = event.run;
          liveRunId = event.run.id;
          syncLiveDrawerMetaFromRun(event.run);
          renderSummary(lastRun);
          renderSuites(lastRun);
          void refreshHistorySelect();
        }
      },
    });
    if (generation !== benchmarkRunGeneration) return;
    lastRun = run;
    liveRunId = run.id;
    renderSummary(run);
    renderSuites(run);
    await refreshHistorySelect();
    if (generation !== benchmarkRunGeneration) return;
    showToast(`Benchmark done · ${formatScore(run.totalScore)}`);
  } catch (err) {
    if (generation !== benchmarkRunGeneration) return;
    const aborted = runSignal.aborted;
    if (aborted) {
      clearActiveRunPersistence();
    }
    finishLiveRunUI({ markCurrentStopped: aborted, commitPartial: aborted });
    if (aborted) {
      setStatus('ok', 'Benchmark cancelled.');
      if (lastRun) {
        renderSummary(lastRun);
      } else {
        renderSummary(null);
      }
    } else {
      setStatus('err', err instanceof Error ? err.message : String(err));
      const mount = document.getElementById('benchmarkSuites');
      if (mount) {
        mount.innerHTML = `<p class="benchmark-empty benchmark-empty--err">${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
      }
    }
  } finally {
    if (generation !== benchmarkRunGeneration) return;
    liveRunId = null;
    setRunning(false);
    abortController = null;
  }
}

async function startRun(mode: BenchmarkStartMode): Promise<void> {
  const roster = loadRoster();
  if (!roster.length && !getActiveTargetFromDom()) {
    setStatus('err', 'Load a model in the top bar before running benchmarks.');
    return;
  }
  if (!roster.length) {
    const active = getActiveTargetFromDom();
    if (active) saveRoster([active]);
    renderRosterList();
  }

  applyStartModeToToggles(mode);

  if (!hasSelectedBenchmarkWork()) {
    setStatus('err', 'Select at least one Academic benchmark and/or Minnow test, or use Quick / Full.');
    return;
  }

  const selectedSuites = getSelectedSuites();
  const storedPreset = storedPresetForStartMode(mode);
  await executeBenchmarkRun({ mode, suiteIds: selectedSuites, preset: storedPreset });
}

async function resumeBenchmarkFromSession(session: ActiveBenchmarkSession): Promise<void> {
  if (isBenchmarkRunActive()) return;

  const remaining = remainingSuiteIds(session);
  if (!remaining.length) {
    clearActiveBenchmarkSession();
    return;
  }

  if (!getActiveModelIdFromDom()) {
    setStatus('err', 'Load a model to resume the benchmark.');
    return;
  }

  applyStartModeToToggles(session.startMode);
  await executeBenchmarkRun({
    mode: session.startMode,
    suiteIds: session.suiteIds,
    preset: session.preset,
    resume: session,
  });
}

function tryResumeBenchmarkFromSession(): void {
  const session = loadActiveBenchmarkSession();
  if (!session) return;
  if (session.campaignKind === 'capability-matrix') return;
  if (isBenchmarkRunActive()) return;
  void resumeBenchmarkFromSession(session);
}

function stopRun(): void {
  if (!abortController) return;
  benchmarkRunGeneration += 1;
  abortController.abort();
  abortController = null;
  clearActiveRunPersistence();
  liveRunId = null;
  if (isMultiModelCampaignActive()) {
    for (const session of getAllTargetSessions()) {
      if (session.status === 'running') {
        markSessionCurrentTestStopped(session);
        markTargetStopped(session.targetKey);
      }
    }
    const selected = getSelectedTargetKey();
    const session = selected ? getTargetSession(selected) : null;
    if (session) showSessionInMainPanel(session);
  }
  finishLiveRunUI({ markCurrentStopped: true, commitPartial: true });
  setRunning(false);
  setStatus('ok', 'Stopping benchmark…');
}

/** Test hook: abort controller for the in-flight benchmark run. */
export function getBenchmarkAbortControllerForTests(): AbortController | null {
  return abortController;
}

/** Test hook: wire abort controller without starting a full run. */
export function setBenchmarkAbortControllerForTests(controller: AbortController | null): void {
  abortController = controller;
}

/** Test hook: invoke Stop handler. */
export function stopRunForTests(): void {
  stopRun();
}

/** Test hook: mark the in-flight test card as stopped. */
export function markCurrentTestAsStoppedForTests(): void {
  markCurrentTestAsStopped();
}

/** Test hook: seed the active running test metadata. */
export function setLiveCurrentTestMetaForTests(
  meta: { testId: string; suite: SuiteId; label: string } | null,
): void {
  liveCurrentTestMeta = meta;
  liveCurrentTestId = meta?.testId ?? null;
}

/** Test hook: seed live Academic cell lookup state. */
export function seedLiveStandardCellsForTests(cells: BenchmarkCellResult[]): void {
  liveStandardCells.clear();
  for (const cell of cells) {
    liveStandardCells.set(cell.cellId, cell);
  }
}

/** Test hook: clear live Academic cell lookup state. */
export function clearLiveStandardCellsForTests(): void {
  liveStandardCells.clear();
}

/** Test hook: seed live transcript lookup state. */
export function seedLiveTranscriptStateForTests(options: {
  meta: BenchmarkTranscriptRunMeta;
  results?: TestResult[];
}): void {
  liveRunDrawerMeta = options.meta;
  liveTestResults.clear();
  for (const result of options.results ?? []) {
    liveTestResults.set(result.testId, result);
  }
}

/** Test hook: clear live transcript lookup state. */
export function clearLiveTranscriptStateForTests(): void {
  liveRunDrawerMeta = null;
  liveTestResults.clear();
}

/** Test hook: read suite toggle selection. */
export function getSelectedSuitesForTests(): SuiteId[] {
  return getSelectedSuites();
}

/** Test hook: whether Academic and/or Minnow work is selected. */
export function hasSelectedBenchmarkWorkForTests(): boolean {
  return hasSelectedBenchmarkWork();
}

/** Test hook: apply Quick/Full preset to suite toggles. */
export function applyPresetToTogglesForTests(preset: BenchmarkPreset): void {
  applyPresetToToggles(preset);
}

/** Test hook: suite ids used for toggle button order. */
export function getSuiteToggleOrderForTests(): readonly SuiteId[] {
  return SUITE_TOGGLE_ORDER;
}

/** Test hook: sync Run/Stop combined button label. */
export function updateRunStopButtonForTests(running: boolean): void {
  updateRunStopButton(running);
}

/** Test hook: seed live-run panel state for history-browse restore tests. */
export function seedLiveRunPanelForTests(options: {
  suiteIds: SuiteId[];
  results?: TestResult[];
  running?: { testId: string; suite: SuiteId; label: string } | null;
}): void {
  liveRunActive = true;
  liveSuiteIds = options.suiteIds;
  liveTestResults.clear();
  for (const result of options.results ?? []) {
    liveTestResults.set(result.testId, result);
  }
  liveCurrentTestId = options.running?.testId ?? null;
  liveCurrentTestMeta = options.running ?? null;
  document.body.innerHTML = `
    <div id="benchmarkSummary"></div>
    <div id="benchmarkProgress" hidden><div id="benchmarkProgressFill"></div></div>
    <div id="benchmarkSuites"></div>
    <button type="button" id="btnBenchmarkBackToCurrent" hidden>Current run</button>
  `;
}

/** Test hook: mark that the user is viewing saved history while a run is active. */
export function setBrowsingHistoryForTests(browsing: boolean): void {
  browsingHistory = browsing;
  updateBackToCurrentControl();
}

/** Test hook: restore the live benchmark panel. */
export function restoreCurrentRunViewForTests(): void {
  restoreCurrentRunView();
}

/** Test hook: whether the back-to-current control is visible. */
export function isBackToCurrentVisibleForTests(): boolean {
  const btn = document.getElementById('btnBenchmarkBackToCurrent');
  return btn instanceof HTMLElement && !btn.hidden;
}

function syncBenchmarkPageOnOpen(): void {
  renderRosterList();
  syncScheduleSectionVisibility(loadRoster().length);
  void refreshBenchmarkRosterPicker();
  void refreshHistorySelect();
  refreshOverviewPanel();
  if (browsingHistory) {
    updateBackToCurrentControl();
    return;
  }
  if (isLiveRunInProgress()) {
    setRunning(isBenchmarkRunActive());
    restoreCurrentRunView();
    return;
  }
  renderSummary(lastRun);
  if (lastRun) renderSuites(lastRun);
}

export function openBenchmark(): void {
  if (!isAppAvailable('bench')) {
    return;
  }
  const root = getBenchmarkRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  if (window.location.hash.startsWith('#/settings')) {
    return;
  }

  void import('./experts/experts-hub').then((m) => {
    if (m.isExpertsPageOpen()) m.closeExpertsHub({ skipNavigate: true });
  });
  void import('./welcome-page').then((m) => {
    if (m.isWelcomePageOpen()) m.closeWelcome({ skipHash: true });
  });
  void import('../research/panel').then((m) => {
    if (m.isResearchPageOpen()) m.closeResearch({ skipNavigate: true });
  });
  void import('./compare-page').then((m) => {
    if (m.isComparePageOpen()) m.closeCompare({ skipNavigate: true });
  });

  root.classList.add('is-open');
  if (!isOsEmbedded()) {
    shell.classList.add('hidden');
    window.location.hash = '#/benchmark';
  }
  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );

  syncBenchmarkPageOnOpen();
  initBenchmarkApp();
}

export function closeBenchmark(options?: { skipNavigate?: boolean }): void {
  const root = getBenchmarkRoot();
  const shell = getChatShell();
  if (!root || !shell) return;
  closeBenchmarkTranscriptDrawer();
  root.classList.remove('is-open');
  if (!isOsEmbedded()) {
    shell.classList.remove('hidden');
    if (!options?.skipNavigate && window.location.hash.startsWith('#/benchmark')) {
      window.location.hash = '#/';
    }
  } else if (!options?.skipNavigate) {
    if (!requestCloseWindowApp('bench')) {
      navigateToDesktop();
    }
  }
  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
}

/** Whether a benchmark is running (including while another page is open). */
export function isBenchmarkRunningInBackground(): boolean {
  return isLiveRunInProgress();
}

function onHashChange(): void {
  const hash = window.location.hash;
  if (hash.startsWith('#/settings')) return;
  onBenchmarkHashChange();
  if (hash === '#/benchmark' || hash.startsWith('#/benchmark/') || hash.startsWith('#/app/bench')) {
    openBenchmark();
    return;
  }
  if (isOsEmbedded() && isOsAppHash(hash)) return;
  const root = getBenchmarkRoot();
  if (root?.classList.contains('is-open')) {
    closeBenchmark();
  }
}

function onSuiteToggleClick(this: HTMLButtonElement): void {
  if (this.disabled) return;
  const pressed = this.getAttribute('aria-pressed') === 'true';
  this.setAttribute('aria-pressed', pressed ? 'false' : 'true');
}

/** Wire run-bar controls only (tests — no pack preload or roster init). */
export function wireBenchmarkRunBarForTests(): void {
  document.getElementById('btnBenchmarkQuick')?.addEventListener('click', () => {
    void startRun('quick');
  });
  document.getElementById('btnBenchmarkFull')?.addEventListener('click', () => {
    void startRun('full');
  });
  document.getElementById('btnBenchmarkRun')?.addEventListener('click', onRunStopClick);

  for (const btn of getSuiteToggleButtons()) {
    btn.addEventListener('click', onSuiteToggleClick);
  }

  for (const btn of document.querySelectorAll<HTMLButtonElement>('.benchmark-standard-toggle')) {
    btn.addEventListener('click', () => {
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', pressed ? 'false' : 'true');
    });
  }
}

export async function initBenchmarkPage(): Promise<void> {
  await preloadMiniPacks();
  registerWindowTeardown('bench', () => closeBenchmark({ skipNavigate: true }));
  wireBenchmarkRunBarForTests();

  document.getElementById('benchmarkHistorySelect')?.addEventListener('change', () => {
    void onHistorySelectChange();
  });
  document.getElementById('btnBenchmarkBackToCurrent')?.addEventListener('click', () => {
    restoreCurrentRunView();
  });
  document.getElementById('btnBenchmarkClearHistory')?.addEventListener('click', () => {
    void onClearHistoryClick();
  });

  document.getElementById('btnBenchmarkAddTarget')?.addEventListener('click', () => {
    const picked = readBenchmarkRosterPickerSelection();
    if (!picked) {
      setStatus('err', 'Select a provider and model.');
      return;
    }
    addTargetToRoster(picked);
    renderRosterList();
    refreshOverviewPanel();
  });

  document.getElementById('btnBenchmarkAddActiveModel')?.addEventListener('click', () => {
    const active = getActiveTargetFromDom();
    if (!active) {
      setStatus('err', 'No model loaded in the top bar.');
      return;
    }
    addTargetToRoster(active);
    renderRosterList();
    refreshOverviewPanel();
  });

  renderRosterList();
  initBenchmarkRosterPicker();
  initModelRunCards((session) => showSessionInMainPanel(session));
  void preloadBundledFullPacks().then(() => loadImportedStandardDatasets());

  const suitesMount = document.getElementById('benchmarkSuites');
  suitesMount?.addEventListener('click', onBenchmarkTestCardClick);
  suitesMount?.addEventListener('keydown', onBenchmarkTestCardKeydown);

  window.addEventListener('hashchange', onHashChange);
  tryResumeBenchmarkFromSession();
  if (window.location.hash === '#/benchmark') {
    openBenchmark();
  }
}

export function openBenchmarkFromTopbar(): void {
  openBenchmark();
}
