import { showToast } from '../ui/toast';
import { runSettingsAction } from '../ui/settings-controls';
/**
 * Research app controller — library-first workspace.
 *
 * One rail of runs, one main pane. The pane shows the composer when nothing is
 * selected, the evidence ledger while a run works, and the brief once it lands.
 * Selecting a run never leaves the surface, so reading an old brief while a new
 * run streams is a normal thing to do rather than a mode switch.
 */

import '../styles/research-page.css';

import { wrapUntrusted } from '../lib/untrusted.mjs';
import { loadResearchConfig } from '../config/research-config';
import { resolveResearchModelBinding } from './resolve-binding';
import { pushNotification } from '../notifications/push';
import {
  cancelResearch,
  fetchResearchDetail,
  fetchResearchResult,
  fetchResearchStatus,
  normalizeResearchActivityLog,
  researchReportUrl,
  startResearch,
  subscribeToResearchStream,
} from './client';
import {
  clearPersistedActiveResearchRunId,
  persistActiveResearchRunId,
  readPersistedActiveResearchRunId,
} from './active-run-persist';
import { renderResearchRail, researchDisplayTitle, setActiveResearchRow } from './library';
import {
  initResearchOptionChips,
  setResearchOptionChipsDisabled,
  syncResearchOptionChips,
} from './option-chips';
import { ResearchRunLedger } from './run-ledger';
import { formatRunSummary, normalizeResearchStats } from './run-summary';
import { renderResearchResultFromMarkdown } from './report-view';
import type {
  ResearchCategory,
  ResearchLibraryItem,
  ResearchScope,
  ResearchStartRequest,
  ResearchStats,
  ResearchStatus,
} from './types';
import {
  readResearchWorkspaceRoot,
  wireResearchWorkspaceScopeControls,
} from './workspace-scope-ui';
import { closeBenchmark } from '../ui/benchmark-page';
import { closeCompare } from '../ui/compare-page';
import { renderChatFromHistory } from '../ui/messages';
import { closeSettings } from '../ui/settings-page';
import { renderSidebar } from '../ui/sidebar';
import { setStatus } from '../ui/status';
import {
  mountResearchComposerModelTrigger,
  syncComposerModelTriggers,
} from '../ui/composer-model-trigger';
import { createAndActivateChat, scheduleSaveSessions } from '../state/sessions';
import { isOsAppHash, isOsShellEnabled } from '../os/page-bridge';
import { navigateToDesktop } from '../os/router';

type RunView = 'brief' | 'evidence';

let ledger: ResearchRunLedger | null = null;
let streamUnsubscribe: (() => void) | null = null;
let runAbort: AbortController | null = null;

/** Run currently shown in the main pane. Null means the composer is up. */
let activeId: string | null = null;
/** In-flight run. The server only persists a run once it finishes, so the rail
 *  would not list it otherwise. */
let liveRun: ResearchLibraryItem | null = null;
let running = false;
let runView: RunView = 'brief';

let railSearch = '';
let railArchived = false;
let knownRuns: ResearchLibraryItem[] = [];

let clockTimer: ReturnType<typeof setInterval> | null = null;
let runStartMs = 0;
let pendingAutoRun = false;
let controlsBound = false;

function getRoot(): HTMLElement | null {
  return document.getElementById('researchView');
}

function getChatShell(): HTMLElement | null {
  return document.getElementById('appBody');
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Report surface ───────────────────────────────────────────────────────────

function resolveResearchReportUrl(researchId: string): string {
  const path = researchReportUrl(researchId);
  if (!path.startsWith('/') || path.startsWith('//')) {
    return path;
  }
  const origin = window.location?.origin;
  if (!origin || origin === 'null') {
    return path;
  }
  return `${origin}${path}`;
}

/**
 * Open the visual report outside the hidden workspace preview pane.
 * Electron uses the system browser so toolbar export (PDF/HTML) works reliably.
 */
function openResearchReportInNewSurface(url: string): void {
  if (window.minnow?.app.openExternal) {
    void window.minnow.app.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Open visual report in Electron preview or a new browser tab. */
export function openResearchReport(researchId: string): void {
  const url = resolveResearchReportUrl(researchId);
  if (isResearchPageOpen()) {
    openResearchReportInNewSurface(url);
    return;
  }
  void import('../ui/preview-panel').then((m) => {
    if (typeof window.minnow?.preview !== 'undefined') {
      void m.openUrlInPreviewPanel(url);
      return;
    }
    openResearchReportInNewSurface(url);
  });
}

function isResearchEmbeddedInCode(): boolean {
  const area = document.getElementById('chatArea');
  const root = getRoot();
  return Boolean(
    area?.classList.contains('chat-area--research') && root && area.contains(root),
  );
}

function notifyResearchPanelStatus(): void {
  if (!isResearchEmbeddedInCode()) return;
  void import('../ui/research-panel').then((m) => m.syncResearchPanelStatus());
}

// ── Rail ─────────────────────────────────────────────────────────────────────

async function refreshRail(): Promise<void> {
  const mount = el('researchRailList');
  if (!mount) {
    return;
  }
  knownRuns = await renderResearchRail({
    mount,
    search: railSearch,
    archived: railArchived,
    activeId,
    liveRuns: liveRun ? [liveRun] : [],
    onSelect: (id) => {
      void selectRun(id);
    },
    onOpenReport: openResearchReport,
    onDiscuss: (id) => {
      void discussResearchReport(id);
    },
    onRefine: (id, query) => {
      showAskPane();
      const input = el<HTMLTextAreaElement>('researchQuery');
      if (input && query.trim()) {
        input.value = query;
      }
      void startResearchRun({ continueFrom: id });
    },
    onChanged: () => {
      void refreshRail();
    },
  });
}

function findRun(id: string): ResearchLibraryItem | undefined {
  return knownRuns.find((run) => run.id === id);
}

// ── Panes ────────────────────────────────────────────────────────────────────

function showAskPane(): void {
  activeId = null;
  el('researchAskPane')?.removeAttribute('hidden');
  el('researchRunPane')?.setAttribute('hidden', '');
  const mount = el('researchRailList');
  if (mount) {
    setActiveResearchRow(mount, null);
  }
  syncResearchOptionChips();
  el<HTMLTextAreaElement>('researchQuery')?.focus();
  notifyResearchPanelStatus();
}

function showRunPane(): void {
  el('researchAskPane')?.setAttribute('hidden', '');
  el('researchRunPane')?.removeAttribute('hidden');
  notifyResearchPanelStatus();
}

/** Brief tab is shown only once a finished run has a saved report to read. */
function setBriefTabVisible(visible: boolean): void {
  const briefTab = el('researchViewBrief');
  if (!briefTab) {
    return;
  }
  briefTab.hidden = !visible;
  if (!visible && runView === 'brief') {
    setRunView('evidence');
  }
}

function setRunView(view: RunView): void {
  const briefTab = el('researchViewBrief');
  if (view === 'brief' && briefTab?.hidden) {
    view = 'evidence';
  }
  runView = view;
  const brief = el('researchResultMount');
  const evidence = el('researchProgressMount');
  const evidenceTab = el('researchViewEvidence');
  if (brief) {
    brief.hidden = view !== 'brief';
  }
  if (evidence) {
    evidence.hidden = view !== 'evidence';
  }
  briefTab?.classList.toggle('is-on', view === 'brief');
  briefTab?.setAttribute('aria-selected', view === 'brief' ? 'true' : 'false');
  evidenceTab?.classList.toggle('is-on', view === 'evidence');
  evidenceTab?.setAttribute('aria-selected', view === 'evidence' ? 'true' : 'false');
}

function setEvidenceCount(count: number): void {
  const tab = el('researchViewEvidence');
  if (!tab) {
    return;
  }
  let slot = tab.querySelector('.rs-segment__count');
  if (!count) {
    slot?.remove();
    return;
  }
  if (!slot) {
    slot = document.createElement('span');
    slot.className = 'rs-segment__count';
    tab.appendChild(slot);
  }
  slot.textContent = String(count);
}

// ── Run header ───────────────────────────────────────────────────────────────

const STATE_WORDS: Record<ResearchStatus, string> = {
  running: 'running',
  done: 'done',
  error: 'failed',
  cancelled: 'stopped',
};

/**
 * Questions long enough to wrap past two lines get a fold rather than an
 * ellipsis — the prompt is the run's identity, so it stays reachable.
 */
const TITLE_FOLD_CHARS = 150;

function setRunHeader(options: {
  title: string;
  status: ResearchStatus;
  stats?: string;
}): void {
  const title = el('researchRunTitle');
  const text = options.title || 'Untitled run';
  if (title) {
    title.textContent = text;
    title.classList.remove('is-expanded');
  }
  const more = el<HTMLButtonElement>('btnResearchRunTitleMore');
  if (more) {
    more.hidden = text.length <= TITLE_FOLD_CHARS;
    more.textContent = 'Show full question';
    more.setAttribute('aria-expanded', 'false');
  }
  const state = el('researchRunState');
  if (state) {
    state.className = `rs-state is-${options.status === 'error' ? 'error' : options.status}`;
    state.textContent = STATE_WORDS[options.status];
  }
  const stats = el('researchRunStats');
  if (stats) {
    stats.textContent = options.stats ?? '';
  }
}

function statsLine(stats: ResearchStats | undefined, sourceCount: number): string {
  return formatRunSummary(normalizeResearchStats(stats, sourceCount));
}

function renderRunActions(researchId: string, status: ResearchStatus, query: string): void {
  const host = el('researchRunActions');
  if (!host) {
    return;
  }
  host.replaceChildren();

  const add = (label: string, run: () => void): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rs-action';
    btn.textContent = label;
    btn.addEventListener('click', run);
    host.appendChild(btn);
  };

  if (status === 'running') {
    add('Stop', () => {
      void cancelActiveRun();
    });
    return;
  }

  add('Report', () => openResearchReport(researchId));
  add('Discuss', () => {
    void discussResearchReport(researchId);
  });
  add('Refine', () => {
    showAskPane();
    const input = el<HTMLTextAreaElement>('researchQuery');
    if (input && query.trim() && !input.value.trim()) {
      input.value = query;
    }
    void startResearchRun({ continueFrom: researchId });
  });
  add('Add to Brain', () => {
    const button = host.querySelector<HTMLButtonElement>('button:last-child');
    void runSettingsAction(button, 'Adding to Brain…', async () => {
      const m = await import('../ui/chat-brain-capture');
      await m.runResearchBrainCapture(researchId);
    });
  });
}

function startClock(options?: { startedAtMs?: number }): void {
  stopClock();
  if (options?.startedAtMs != null && Number.isFinite(options.startedAtMs)) {
    runStartMs = performance.now() - (Date.now() - options.startedAtMs);
  } else {
    runStartMs = performance.now();
  }
  clockTimer = setInterval(() => {
    const stats = el('researchRunStats');
    if (!stats || !running) {
      return;
    }
    const scanned = ledger?.getScanned() ?? 0;
    const parts = [formatClock(performance.now() - runStartMs)];
    if (scanned) {
      parts.push(`${scanned} source${scanned === 1 ? '' : 's'} found`);
    }
    const read = ledger?.getReadCount() ?? 0;
    if (read) {
      parts.push(`${read} read`);
    }
    stats.textContent = parts.join(' · ');
    setEvidenceCount(read);
  }, 500);
}

function stopClock(): void {
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

// ── Running state ────────────────────────────────────────────────────────────

function setRunningState(isRunning: boolean): void {
  running = isRunning;
  getRoot()?.classList.toggle('is-running', isRunning);

  const startBtn = el<HTMLButtonElement>('btnResearchStart');
  const cancelBtn = el<HTMLButtonElement>('btnResearchCancel');
  const queryInput = el<HTMLTextAreaElement>('researchQuery');

  if (startBtn) {
    startBtn.disabled = isRunning;
    if (isRunning) {
      startBtn.replaceChildren();
      const spinner = document.createElement('span');
      spinner.className = 'rs-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      startBtn.appendChild(spinner);
      startBtn.setAttribute('aria-label', 'Research running');
    } else {
      renderResearchStartButton();
    }
  }
  if (cancelBtn) {
    cancelBtn.hidden = !isRunning;
    cancelBtn.disabled = !isRunning;
  }
  if (queryInput) {
    queryInput.disabled = isRunning;
  }
  setResearchOptionChipsDisabled(isRunning);
  notifyResearchPanelStatus();
}

function renderResearchStartButton(): void {
  const startBtn = el<HTMLButtonElement>('btnResearchStart');
  if (!startBtn || running) {
    return;
  }
  startBtn.replaceChildren();
  const icon = document.createElement('i');
  icon.className = 'fi fi-rr-arrow-small-up icon-svg';
  icon.setAttribute('aria-hidden', 'true');
  icon.style.setProperty('--mn-icon-size', '20px');
  startBtn.appendChild(icon);
  startBtn.setAttribute('aria-label', 'Start research');
}

// ── Options ──────────────────────────────────────────────────────────────────

async function resolveResearchBinding(): Promise<{ providerId: string; model: string }> {
  return resolveResearchModelBinding();
}

function readStartOptions(): Omit<ResearchStartRequest, 'query' | 'continueFrom'> {
  const maxRoundsRaw = el<HTMLSelectElement>('researchMaxRounds')?.value;
  const maxRounds = maxRoundsRaw === 'auto' ? 0 : Number(maxRoundsRaw);
  const category = (el<HTMLSelectElement>('researchCategory')?.value ?? '') as ResearchCategory;
  const searchProvider = el<HTMLSelectElement>('researchSearchProvider')?.value?.trim();
  const scope = (el<HTMLSelectElement>('researchScope')?.value ?? 'web') as ResearchScope;
  const workspaceRoot = readResearchWorkspaceRoot(el<HTMLSelectElement>('researchWorkspace'), scope);
  return {
    maxRounds: Number.isFinite(maxRounds) ? maxRounds : 0,
    category,
    scope,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(searchProvider ? { searchProvider } : {}),
  };
}

// ── Loading a saved run ──────────────────────────────────────────────────────

function showBriefSkeleton(): void {
  const mount = el('researchResultMount');
  if (!mount) {
    return;
  }
  const skeleton = document.createElement('div');
  skeleton.className = 'rs-skeleton';
  const head = document.createElement('div');
  head.className = 'rs-skeleton__line rs-skeleton__line--head';
  skeleton.appendChild(head);
  for (let i = 0; i < 7; i += 1) {
    const line = document.createElement('div');
    line.className = 'rs-skeleton__line';
    skeleton.appendChild(line);
  }
  mount.replaceChildren(skeleton);
}

function showBriefNotice(label: string, message: string, isError = false): void {
  const mount = el('researchResultMount');
  if (!mount) {
    return;
  }
  const notice = document.createElement('div');
  notice.className = isError ? 'rs-notice rs-notice--error' : 'rs-notice';
  const head = document.createElement('span');
  head.className = 'rs-notice__label';
  head.textContent = label;
  notice.append(head, document.createTextNode(message));
  mount.replaceChildren(notice);
}

/** Refill the evidence ledger from the server when the Research UI remounts mid-run. */
async function ensureRunningLedgerHydrated(researchId: string): Promise<void> {
  const evidence = el('researchProgressMount');
  if (!evidence) {
    return;
  }
  if (ledger && ledger.getReadCount() > 0) {
    return;
  }
  try {
    const data = await fetchResearchDetail(researchId);
    if (liveRun?.id !== researchId) {
      return;
    }
    const activityLog = normalizeResearchActivityLog(data);
    ledger?.destroy();
    ledger = new ResearchRunLedger(evidence);
    if (activityLog.length) {
      ledger.hydrate(activityLog);
      ledger.setRunning(true);
      setEvidenceCount(ledger.getReadCount());
    } else {
      ledger.reset();
    }
  } catch {}
}

/** Select a run from the rail and paint it into the main pane. */
async function selectRun(researchId: string): Promise<void> {
  activeId = researchId;
  showRunPane();
  const mount = el('researchRailList');
  if (mount) {
    setActiveResearchRow(mount, researchId);
  }

  if (running && liveRun?.id === researchId) {
    setRunHeader({ title: researchDisplayTitle(liveRun), status: 'running' });
    renderRunActions(researchId, 'running', liveRun.query);
    setBriefTabVisible(false);
    setRunView('evidence');
    void ensureRunningLedgerHydrated(researchId);
    return;
  }

  const known = findRun(researchId);
  setRunHeader({
    title: researchDisplayTitle(known ?? { query: '' }),
    status: known?.status ?? 'done',
    stats: '',
  });
  el('researchRunActions')?.replaceChildren();
  setBriefTabVisible(false);
  setRunView('evidence');
  showBriefSkeleton();

  try {
    const data = await fetchResearchDetail(researchId);
    if (activeId !== researchId) {
      return;
    }
    const query = data.query?.trim() || known?.query || '';
    const headerTitle = researchDisplayTitle({
      title: typeof data.title === 'string' ? data.title : known?.title,
      query,
    });
    const status = data.status ?? 'done';

    setRunHeader({
      title: headerTitle,
      status,
      stats: statsLine(data.stats, data.sources?.length ?? 0),
    });
    renderRunActions(researchId, status, query);

    const evidence = el('researchProgressMount');
    if (evidence) {
      ledger?.destroy();
      ledger = new ResearchRunLedger(evidence);
      const activityLog = normalizeResearchActivityLog(data);
      if (activityLog.length) {
        ledger.hydrate(activityLog);
        setEvidenceCount(ledger.getReadCount());
      } else {
        ledger.reset();
        ledger.setRunning(false);
        const empty = document.createElement('p');
        empty.className = 'rs-ledger__empty';
        empty.textContent = 'This run finished before Minnow kept a working record.';
        evidence.replaceChildren(empty);
        setEvidenceCount(0);
      }
    }

    if (status === 'running') {
      liveRun = {
        id: researchId,
        query,
        status: 'running',
        startedAt: data.startedAt,
      };
      persistActiveResearchRunId(researchId);
      setRunningState(true);
      ledger?.setRunning(true);
      setBriefTabVisible(false);
      setRunView('evidence');
      const startedAtMs = researchStartedAtMs(data);
      startClock(startedAtMs != null ? { startedAtMs } : undefined);
      bindResearchStream(researchId, query);
      return;
    }

    const briefMount = el('researchResultMount');
    if (!briefMount) {
      return;
    }
    if (!data.result?.trim()) {
      setBriefTabVisible(false);
      showBriefNotice(
        status === 'error' ? 'Failed' : 'No brief',
        status === 'error'
          ? 'This run failed before writing a brief. The evidence it did gather is under Evidence.'
          : 'This run has no saved brief.',
        status === 'error',
      );
      if (hasActivityLog(data)) {
        setRunView('evidence');
      }
      return;
    }
    setBriefTabVisible(true);
    setRunView('brief');
    renderResearchResultFromMarkdown(briefMount, data.result, data.sources ?? [], query, {
      onFollowUp: (q) => {
        showAskPane();
        const input = el<HTMLTextAreaElement>('researchQuery');
        if (input) {
          input.value = q;
        }
        void startResearchRun({ continueFrom: researchId });
      },
    });
  } catch (err) {
    if (activeId !== researchId) {
      return;
    }
    const msg = err instanceof Error ? err.message : 'Could not load this run';
    setRunHeader({ title: researchDisplayTitle(known ?? { query: '' }), status: 'error', stats: '' });
    setBriefTabVisible(false);
    setRunView('evidence');
    showBriefNotice('Could not load', msg, true);
  } finally {
    notifyResearchPanelStatus();
  }
}

/** Whether a detail payload carried any activity rows. */
function hasActivityLog(data: { activityLog?: unknown }): boolean {
  return Array.isArray(data.activityLog) && data.activityLog.length > 0;
}

// ── Discuss spinoff ──────────────────────────────────────────────────────────

/** Client spinoff: new chat seeded with the report. */
export async function discussResearchReport(researchId: string): Promise<void> {
  try {
    const data = await fetchResearchResult(researchId);
    const binding = await resolveResearchBinding();
    const modelKey = binding.model;
    const chat = createAndActivateChat(modelKey);
    if (binding.providerId) {
      chat.providerId = binding.providerId;
    }
    const report = data.result?.trim() ?? '';
    const spinoffBody =
      'The following is a Deep Research report. Use it as context when answering my questions.\n\n' +
      wrapUntrusted(report, { source: 'research-report' });
    chat.history.push({ role: 'user', content: spinoffBody });
    chat.name = 'Research discussion';
    scheduleSaveSessions();

    if (isOsShellEnabled()) {
      closeResearch({ skipNavigate: true });
      const { navigateToCodeChat } = await import('../os/router');
      navigateToCodeChat();
    } else {
      closeResearch();
      renderChatFromHistory(chat);
    }

    renderSidebar();
    setStatus('ok', 'New chat started with research report');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Discuss failed';
    setStatus('err', msg);
  }
}

// ── Running ──────────────────────────────────────────────────────────────────

function teardownStream(): void {
  streamUnsubscribe?.();
  streamUnsubscribe = null;
  runAbort?.abort();
  runAbort = null;
}

/** Drop the SSE client only; the server run keeps going. */
function detachFromActiveResearchRun(): void {
  teardownStream();
}

function bindResearchStream(researchId: string, query: string): void {
  teardownStream();
  runAbort = new AbortController();
  streamUnsubscribe = subscribeToResearchStream(researchId, {
    signal: runAbort.signal,
    onProgress: (event) => {
      if (liveRun?.id !== researchId) {
        return;
      }
      ledger?.apply(event);
    },
    onEnd: (endEvent) => {
      const status = endEvent?.status ?? 'done';
      finishRun(researchId, query, status, endEvent?.message);
    },
    onTransportError: (err) => {
      const msg = err instanceof Error ? err.message : 'Stream error';
      finishRun(researchId, query, 'error', msg);
    },
  });
}

function researchStartedAtMs(detail: { startedAt?: string }): number | undefined {
  const raw = detail.startedAt;
  if (typeof raw === 'string' && raw.trim()) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) {
      return t;
    }
  }
  return undefined;
}

/**
 * Follow an in-flight run (new tab, reload, or return from another app).
 * Replays persisted activity and re-subscribes to SSE.
 */
async function attachToRunningResearch(
  researchId: string,
  query: string,
  options: { paintPane?: boolean } = {},
): Promise<void> {
  const paintPane = options.paintPane !== false;
  if (running && liveRun?.id === researchId && streamUnsubscribe) {
    return;
  }

  liveRun = {
    id: researchId,
    query,
    status: 'running',
    startedAt: liveRun?.startedAt ?? new Date().toISOString(),
  };
  activeId = researchId;
  persistActiveResearchRunId(researchId);
  setRunningState(true);

  let startedAtMs: number | undefined;
  const evidence = el('researchProgressMount');
  if (evidence) {
    try {
      const data = await fetchResearchDetail(researchId);
      if (paintPane && activeId !== researchId) {
        return;
      }
      startedAtMs = researchStartedAtMs(data);
      ledger?.destroy();
      ledger = new ResearchRunLedger(evidence);
      const activityLog = normalizeResearchActivityLog(data);
      if (activityLog.length) {
        ledger.hydrate(activityLog);
        ledger.setRunning(true);
        setEvidenceCount(ledger.getReadCount());
      } else {
        ledger.reset();
      }
    } catch {
      ledger?.destroy();
      ledger = new ResearchRunLedger(evidence);
      ledger.reset();
    }
  }

  if (paintPane) {
    showRunPane();
    setRunHeader({ title: query, status: 'running', stats: '0:00' });
    renderRunActions(researchId, 'running', query);
    setBriefTabVisible(false);
    setRunView('evidence');
    el('researchResultMount')?.replaceChildren();
  }

  startClock(startedAtMs != null ? { startedAtMs } : undefined);
  void refreshRail();
  bindResearchStream(researchId, query);
}

/** Reconnect after reload or when the Research surface is shown again. */
async function resumeActiveResearchIfNeeded(): Promise<void> {
  if (running && liveRun?.id) {
    if (!streamUnsubscribe) {
      bindResearchStream(liveRun.id, liveRun.query);
    }
    if (!activeId) {
      activeId = liveRun.id;
      showRunPane();
      setRunHeader({ title: researchDisplayTitle(liveRun), status: 'running' });
      renderRunActions(liveRun.id, 'running', liveRun.query);
      setBriefTabVisible(false);
      setRunView('evidence');
    }
    void refreshRail();
    return;
  }

  const persistedId = readPersistedActiveResearchRunId();
  if (!persistedId) {
    return;
  }

  try {
    const status = await fetchResearchStatus(persistedId);
    if (status.status !== 'running') {
      clearPersistedActiveResearchRunId();
      return;
    }
    const query = status.query?.trim() || 'Research in progress';
    await attachToRunningResearch(persistedId, query);
  } catch {
    clearPersistedActiveResearchRunId();
  }
}

async function startResearchRun(extra: { continueFrom?: string } = {}): Promise<void> {
  if (running) {
    return;
  }
  const query = el<HTMLTextAreaElement>('researchQuery')?.value?.trim();
  if (!query) {
    setStatus('err', 'Enter a research question');
    el<HTMLTextAreaElement>('researchQuery')?.focus();
    return;
  }

  teardownStream();
  setRunningState(true);

  try {
    const binding = await resolveResearchBinding();
    const body: ResearchStartRequest = {
      query,
      ...readStartOptions(),
      providerId: binding.providerId || undefined,
      model: binding.model || undefined,
      ...extra,
    };
    const { researchId } = await startResearch(body);

    persistActiveResearchRunId(researchId);
    liveRun = {
      id: researchId,
      query,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    activeId = researchId;

    showRunPane();
    setRunHeader({ title: query, status: 'running', stats: '0:00' });
    renderRunActions(researchId, 'running', query);
    setEvidenceCount(0);
    setBriefTabVisible(false);
    setRunView('evidence');

    const evidence = el('researchProgressMount');
    if (evidence) {
      ledger?.destroy();
      ledger = new ResearchRunLedger(evidence);
      ledger.reset();
    }
    el('researchResultMount')?.replaceChildren();
    startClock();
    void refreshRail();

    bindResearchStream(researchId, query);
  } catch (err) {
    setRunningState(false);
    stopClock();
    const msg = err instanceof Error ? err.message : 'Could not start research';
    setStatus('err', msg);
    if (liveRun) {
      liveRun.status = 'error';
    }
    void refreshRail();
  }
}

function finishRun(
  researchId: string,
  query: string,
  status: 'done' | 'error' | 'cancelled',
  message?: string,
): void {
  if (!running) {
    return;
  }
  setRunningState(false);
  stopClock();
  ledger?.complete(status, message);
  teardownStream();
  clearPersistedActiveResearchRunId();

  if (liveRun?.id === researchId) {
    liveRun.status = status;
  }

  if (status === 'done') {
    showToast('Research complete');
    void fetchResearchResult(researchId).then((data) => {
      const sources = data.sources?.length ?? 0;
      const title = query.slice(0, 60);
      pushNotification({
        kind: 'research',
        title: 'Research',
        preview: `Your research brief on ${title}${query.length > 60 ? '…' : ''} is ready — ${sources} sources.`,
        appId: 'research',
        dedupeKey: `research:${researchId}`,
      });
    });
    liveRun = null;
    void refreshRail();
    if (activeId === researchId) {
      void selectRun(researchId);
    }
    return;
  }

  if (status === 'cancelled') {
    setStatus('ok', 'Research stopped');
  } else {
    setStatus('err', message ?? 'Research failed');
  }

  if (activeId === researchId) {
    setRunHeader({
      title: query,
      status,
      stats: `${ledger?.getReadCount() ?? 0} read before stopping`,
    });
    renderRunActions(researchId, status, query);
    setBriefTabVisible(false);
    showBriefNotice(
      status === 'error' ? 'Failed' : 'Stopped',
      message ??
        (status === 'error'
          ? 'The run failed before writing a brief.'
          : 'You stopped this run before it wrote a brief.'),
      status === 'error',
    );
    setRunView('evidence');
  }
  void refreshRail();
}

async function cancelActiveRun(): Promise<void> {
  const id = liveRun?.id;
  if (!id) {
    return;
  }
  try {
    await cancelResearch(id);
  } catch {}
  teardownStream();
  if (running) {
    finishRun(id, liveRun?.query ?? '', 'cancelled');
  }
}

// ── Surface lifecycle ────────────────────────────────────────────────────────

function closeOtherOverlays(): void {
  closeSettings({ skipNavigate: true });
  closeBenchmark({ skipNavigate: true });
  closeCompare({ skipNavigate: true });
  void import('../ui/welcome-page').then((m) => {
    if (m.isWelcomePageOpen()) {
      m.closeWelcome({ skipHash: true });
    }
  });
  void import('../ui/experts/experts-hub').then((m) => {
    if (m.isExpertsPageOpen()) {
      m.closeExpertsHub({ skipNavigate: true });
    }
  });
}

/** Whether the Research surface is open. */
export function isResearchPageOpen(): boolean {
  if (isOsShellEnabled() && isResearchEmbeddedInCode()) {
    return true;
  }
  return getRoot()?.classList.contains('is-open') ?? false;
}

/** Close Research and return to chat or desktop. */
export function closeResearch(options?: { skipNavigate?: boolean }): void {
  if (isOsShellEnabled()) {
    if (isResearchEmbeddedInCode()) {
      void import('../ui/research-panel').then((m) => m.closeResearchPanel());
      return;
    }
    const root = getRoot();
    if (root) {
      detachFromActiveResearchRun();
      root.classList.remove('is-open');
      void import('../ui/preview-electron-visibility').then((m) =>
        m.syncElectronPreviewHostVisibility(),
      );
    }
    if (!options?.skipNavigate) {
      navigateToDesktop();
    }
    return;
  }

  const root = getRoot();
  const shell = getChatShell();
  if (!root || !shell) {
    return;
  }
  detachFromActiveResearchRun();
  root.classList.remove('is-open');
  shell.classList.remove('hidden');
  if (!options?.skipNavigate && window.location.hash.startsWith('#/research')) {
    window.location.hash = '#/';
  }
  void import('../ui/preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
}

export interface OpenResearchOptions {
  seed?: string;
  autoRun?: boolean;
}

function applyOpenOptions(options?: OpenResearchOptions): void {
  if (options?.seed) {
    showAskPane();
    const query = el<HTMLTextAreaElement>('researchQuery');
    if (query) {
      query.value = options.seed;
    }
  }
  if (options?.autoRun || pendingAutoRun) {
    pendingAutoRun = false;
    void startResearchRun();
  }
}

/** Show the Research app surface (OS shell app-host). */
export function showResearchPage(options?: OpenResearchOptions): void {
  if (window.location.hash.startsWith('#/settings')) {
    return;
  }

  void import('../ui/research-panel').then((m) => {
    m.teardownResearchPanelBeforeChatPaint();
  });

  const root = getRoot();
  if (!root) {
    return;
  }

  closeOtherOverlays();
  root.classList.add('is-open');
  void import('../ui/preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
  void refreshRail();
  applyOpenOptions(options);
  void resumeActiveResearchIfNeeded();
}

/** Open Research (`#/research` or OS `#/app/research`). */
export function openResearch(options?: OpenResearchOptions): void {
  if (isOsShellEnabled()) {
    void import('../os/router').then(({ launchApp }) => {
      launchApp('research', {
        seed: options?.seed,
        autoRun: options?.autoRun || pendingAutoRun,
      });
    });
    pendingAutoRun = false;
    return;
  }

  const root = getRoot();
  const shell = getChatShell();
  if (!root || !shell) {
    return;
  }

  closeOtherOverlays();
  root.classList.add('is-open');
  shell.classList.add('hidden');
  window.location.hash = '#/research';
  void import('../ui/preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
  void refreshRail();
  applyOpenOptions(options);
  void resumeActiveResearchIfNeeded();
}

function onHashChange(): void {
  const hash = window.location.hash;
  if (hash.startsWith('#/settings')) {
    return;
  }
  if (hash === '#/research' || hash.startsWith('#/research/')) {
    openResearch();
    return;
  }
  if (isOsShellEnabled() && isOsAppHash(hash)) {
    return;
  }
  if (isResearchPageOpen()) {
    closeResearch();
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

let railFilterTimer: ReturnType<typeof setTimeout> | null = null;

function bindStaticControls(): void {
  if (controlsBound) {
    return;
  }
  controlsBound = true;

  el('btnResearchStart')?.addEventListener('click', () => {
    void startResearchRun();
  });
  el('btnResearchCancel')?.addEventListener('click', () => {
    void cancelActiveRun();
  });
  el('btnResearchNew')?.addEventListener('click', () => {
    showAskPane();
  });

  const queryInput = el<HTMLTextAreaElement>('researchQuery');
  queryInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    void startResearchRun();
  });

  for (const seed of document.querySelectorAll<HTMLButtonElement>('[data-research-prompt]')) {
    seed.addEventListener('click', () => {
      const text = seed.getAttribute('data-research-prompt')?.trim();
      if (!text || !queryInput) {
        return;
      }
      queryInput.value = text;
      queryInput.focus();
      const gap = text.indexOf('…');
      if (gap >= 0) {
        queryInput.setSelectionRange(gap, gap + 1);
      }
    });
  }

  el('researchViewBrief')?.addEventListener('click', () => setRunView('brief'));
  el('researchViewEvidence')?.addEventListener('click', () => setRunView('evidence'));

  el('btnResearchRunTitleMore')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const title = el('researchRunTitle');
    const expanded = title?.classList.toggle('is-expanded') ?? false;
    button.textContent = expanded ? 'Show less' : 'Show full question';
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });

  el<HTMLInputElement>('researchRailFilter')?.addEventListener('input', (event) => {
    railSearch = (event.target as HTMLInputElement).value;
    if (railFilterTimer) {
      clearTimeout(railFilterTimer);
    }
    railFilterTimer = setTimeout(() => {
      void refreshRail();
    }, 140);
  });

  el<HTMLInputElement>('researchRailArchived')?.addEventListener('change', (event) => {
    railArchived = (event.target as HTMLInputElement).checked;
    void refreshRail();
  });

  el('btnResearchRailCollapse')?.addEventListener('click', () => {
    const root = getRoot();
    if (!root) {
      return;
    }
    const hidden = root.classList.toggle('is-rail-hidden');
    el('btnResearchRailCollapse')?.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  });

  el('btnResearchSettingsLink')?.addEventListener('click', () => {
    void import('../ui/settings-page').then((m) => m.openSettings('deep-research'));
  });

  const scopeSelect = el<HTMLSelectElement>('researchScope');
  const workspaceSelect = el<HTMLSelectElement>('researchWorkspace');
  const workspaceField = el('researchWorkspaceField');
  const workspaceBrowse = el<HTMLButtonElement>('btnResearchWorkspaceBrowse');
  if (scopeSelect && workspaceSelect && workspaceField) {
    wireResearchWorkspaceScopeControls({
      scopeSelect,
      workspaceField,
      workspaceSelect,
      browseBtn: workspaceBrowse,
    });
  }
}

/** Wire hash routing and controls (call once from main). */
export function initResearchPage(): void {
  bindStaticControls();
  mountResearchComposerModelTrigger();
  void loadResearchConfig().then(() => syncComposerModelTriggers());
  initResearchOptionChips();
  renderResearchStartButton();
  setRunView(runView);
  void refreshRail();
  void resumeActiveResearchIfNeeded();
  if (!isOsShellEnabled()) {
    window.addEventListener('hashchange', onHashChange);
    if (window.location.hash === '#/research' || window.location.hash.startsWith('#/research/')) {
      openResearch();
    }
  }
}

export function openResearchFromTopbar(): void {
  openResearch();
}

/** Queue auto-run after open (concierge seed). */
export function queueResearchAutoRun(): void {
  pendingAutoRun = true;
}

/** Shell embed: start a run (after controls are bound). */
export async function startResearchRunFromShell(
  extra: { continueFrom?: string } = {},
): Promise<void> {
  await startResearchRun(extra);
}

/** Shell embed: cancel the stream and return to the composer. */
export function closeResearchEmbeddedRun(): void {
  void cancelActiveRun();
  stopClock();
  ledger?.destroy();
  ledger = null;
  liveRun = null;
  el('researchResultMount')?.replaceChildren();
  showAskPane();
  notifyResearchPanelStatus();
}

/** Whether a research run is in progress. */
export function isResearchRunningForShell(): boolean {
  return running;
}

/** Cancel the active research run (shell embed). */
export async function cancelResearchRunForShell(): Promise<void> {
  await cancelActiveRun();
}

/** Test hook: whether Start is disabled during a run. */
export function isResearchStartDisabledForTests(): boolean {
  return el<HTMLButtonElement>('btnResearchStart')?.disabled === true;
}

/** Test hook: toggle running UI without calling the server. */
export function setResearchRunningForTests(isRunning: boolean): void {
  setRunningState(isRunning);
}

/** Test hook: toggle Brief segment visibility. */
export function setBriefTabVisibleForTests(visible: boolean): void {
  setBriefTabVisible(visible);
}

/** Test hook: reset module state between cases. */
export function resetResearchPanelStateForTests(): void {
  teardownStream();
  stopClock();
  ledger?.destroy();
  ledger = null;
  activeId = null;
  liveRun = null;
  running = false;
  runView = 'brief';
  railSearch = '';
  railArchived = false;
  knownRuns = [];
  controlsBound = false;
  pendingAutoRun = false;
  clearPersistedActiveResearchRunId();
  setBriefTabVisible(true);
}
