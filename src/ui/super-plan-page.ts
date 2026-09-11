import { renderSuperPlanGate } from './super-plan-gate';
import {
  ActivityLogBuffer,
  formatActivityTimestamp,
  type ActivityLogEntry,
} from '../research/activity-log';
import { PlanActivityCollector } from './plan-activity-collector';
import { SuperPlanTranscript } from './super-plan-transcript';
import {
  getSuperPlanCheckpointKind,
  isSuperPlanAdvancing,
  isSuperPlanStalled,
} from '../chat/super-plan/client';
import {
  mountComposerModelTrigger,
  unmountSuperPlanComposerModelTrigger,
} from './composer-model-trigger';
import {
  SUPER_PLAN_STAGE_LABELS,
  SUPER_PLAN_DISPLAY_ORDER,
  type SuperPlanStageId,
  type SuperPlanState,
} from '../chat/super-plan/types';
const shouldSkipSuperPlanStage = (stage: string, config: { grillEnabled: boolean; researchEnabled: boolean; impeccable: string }, _ui?: boolean): boolean => (stage === 'grill' && !config.grillEnabled) || (stage === 'research' && !config.researchEnabled) || (stage === 'impeccable' && config.impeccable === 'never') || ['draft2', 'review2', 'finalize'].includes(stage);
import {
  formatRelativeTime,
  groupPlanLibraryEntries,
  listSuperPlanLibrary,
  planLibraryStateLabel,
  resolveSuperPlanDisplayTitle,
  titleFromPlanPath,
  type PlanLibraryEntry,
} from '../chat/super-plan/plan-library';
import {
  getSuperPlanConfigSync,
  saveSuperPlanConfig,
  type SuperPlanConfig,
  type SuperPlanImpeccableMode,
  type SuperPlanResearchDepth,
} from '../config/super-plan-meta';
import type { ResearchScope } from '../research/types';
import {
  mountPlanPreviewContent,
  readPlanArtifactMarkdown,
} from '../chat/plans/plan-preview';
import { findChatById } from '../state/sessions';
import type { Chat } from '../types';
import { scheduleAnimationFrame } from '../lib/schedule-animation-frame';
import { bindComposerAutoResize } from './composer-auto-resize';
import { cancelComposerExpandFor, initComposerExpand } from './composer-expand';

export const SUPER_PLAN_PAGE_ROOT_ID = 'superPlanPage';
export const SUPER_PLAN_PAGE_QUESTIONS_ID = 'orchestratePlanScreenQuestions';

/** Which body the reading column is showing. */
type SegmentId = 'activity' | 'spec' | 'plan';

export interface SuperPlanPageHandlers {
  onStart: (prompt: string) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSkipInterview: () => void;
  onConfirmSpec: () => void;
  onReviseSpec: () => void;
  onRetryStage: () => void;
  onSkipStage: () => void;
  onCancelPipeline: () => void;
  onRework: (stageId: SuperPlanStageId) => void;
  onOrchestrate: (planPath: string) => void;
  onBuild: (planPath: string) => void;
  onRevisePlan: (planPath: string) => void;
  onOpenSettings?: () => void;
  /** Rail selection: a run row carries a chatId, a file row carries only a path. */
  onSelectRun: (chatId: string) => void;
  onOpenPlanFile: (path: string) => void;
  onNewPlan: () => void;
  /** Rail context menu: remove the plan file and/or its run chat. */
  onDeleteEntry: (entry: PlanLibraryEntry) => void;
}

export interface SuperPlanPageOptions {
  chatId: string;
  /** `compose` before a run exists, `run` for a live or finished pipeline, and `doc` for a plan file the rail found on disk with no run behind it. */
  mode: 'compose' | 'run' | 'doc';
  savedPrompt?: string;
  errorMessage?: string;
  /** Plan path for `doc` mode. */
  docPath?: string;
  handlers: SuperPlanPageHandlers;
}

const SEED_PROMPTS = [
  'Add offline queueing to the sync layer',
  'Split the settings drawer into its own app',
  'Replace the polling notifier with SSE',
];

const RESEARCH_DEPTH_LABEL: Record<SuperPlanResearchDepth, string> = {
  auto: 'auto',
  quick: 'quick',
  standard: 'standard',
  deep: 'deep',
};

const RESEARCH_SCOPE_LABEL: Record<ResearchScope, string> = {
  web: 'web',
  codebase: 'codebase',
  both: 'web + code',
};

let page: SuperPlanPage | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function svg(paths: string, size = 14): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.5');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = paths;
  return el;
}

const ICON_PLUS = '<path d="M8 3.5v9M3.5 8h9"/>';
const ICON_SEND = '<path d="M8 13V3.5M4 7l4-3.5L12 7"/>';
const ICON_CHEVRON_LEFT = '<path d="M9.5 4 6 8l3.5 4"/>';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Right-click menu on a library row — same affordances as chat rows in the sidebar. */
function showSuperPlanRowContextMenu(
  x: number,
  y: number,
  entry: PlanLibraryEntry,
  onDelete: (entry: PlanLibraryEntry) => void,
): void {
  const existing = document.getElementById('superPlanRowContextMenu');
  existing?.remove();

  const menu = document.createElement('div');
  menu.id = 'superPlanRowContextMenu';
  menu.className = 'chat-group-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const closeMenu = (): void => {
    menu.remove();
    document.removeEventListener('pointerdown', onPointerDownOutside, true);
    document.removeEventListener('keydown', onKey);
  };
  const onPointerDownOutside = (e: PointerEvent): void => {
    if (menu.contains(e.target as Node)) return;
    closeMenu();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeMenu();
  };

  const deleteItem = document.createElement('button');
  deleteItem.type = 'button';
  deleteItem.textContent = 'Delete';
  deleteItem.className = 'chat-context-menu__item--danger';
  deleteItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    onDelete(entry);
  });

  menu.appendChild(deleteItem);
  document.body.appendChild(menu);

  window.setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDownOutside, true);
    document.addEventListener('keydown', onKey);
  }, 0);
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Wall-clock start of the pipeline, resilient across reloads. */
function pipelineStartMs(sp: SuperPlanState): number | null {
  if (sp.runStartedAt) return sp.runStartedAt;
  const starts = SUPER_PLAN_DISPLAY_ORDER.map((id) => sp.stages[id]?.startedAt ?? 0).filter(
    (t) => t > 0,
  );
  return starts.length ? Math.min(...starts) : null;
}

type RunState = 'running' | 'waiting' | 'paused' | 'stalled' | 'error' | 'cancelled' | 'done';

function resolveRunState(chat: Chat): RunState {
  const sp = chat.superPlanView;
  if (!sp) return 'done';
  if (sp.cancelled) return 'cancelled';
  const record = sp.stages[sp.activeStage];
  if (record?.status === 'error') return 'error';
  if (sp.paused) return 'paused';
  if (record?.status === 'blocked_user') return 'waiting';
  if (sp.activeStage === 'present' && record?.status === 'done') return 'done';
  if (isSuperPlanStalled(chat) && !isSuperPlanAdvancing(chat.id)) return 'stalled';
  return 'running';
}

const RUN_STATE_WORD: Record<RunState, string> = {
  running: 'running',
  waiting: 'needs you',
  paused: 'paused',
  stalled: 'stalled',
  error: 'failed',
  cancelled: 'stopped',
  done: 'done',
};

/** Class suffix shared with the rail so one state reads the same in both places. */
function stateClass(state: RunState): string {
  if (state === 'stalled') return 'is-paused';
  if (state === 'cancelled') return 'is-cancelled';
  return `is-${state}`;
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** True when this stage has produced a file the reading column may open. */
function stageHasWrittenArtifact(
  record: SuperPlanState['stages'][SuperPlanStageId] | undefined,
): boolean {
  if (!record) return false;
  if (record.artifactPath?.trim()) return true;
  return record.status === 'blocked_user' || record.status === 'done';
}

function specPathOf(sp: SuperPlanState): string {
  const record = sp.stages.spec_confirm;
  const fromStage = record?.artifactPath?.trim() || '';
  if (fromStage) return fromStage;
  return stageHasWrittenArtifact(record) ? sp.specPath?.trim() || '' : '';
}

function planPathOf(sp: SuperPlanState): string {
  const present = sp.stages.present?.artifactPath?.trim() || '';
  if (present) return present;
  const draft2 = sp.stages.draft2?.artifactPath?.trim() || '';
  if (draft2) return draft2;
  const draft1 = sp.stages.draft1?.artifactPath?.trim() || '';
  if (draft1) return draft1;
  const written =
    stageHasWrittenArtifact(sp.stages.present) ||
    sp.stages.draft1?.status === 'done' ||
    sp.stages.draft2?.status === 'done';
  return written ? sp.planPath?.trim() || '' : '';
}

function researchPathOf(sp: SuperPlanState): string {
  const record = sp.stages.research;
  const fromStage = record?.artifactPath?.trim() || '';
  if (fromStage) return fromStage;
  return record?.status === 'done' ? sp.researchPath?.trim() || '' : '';
}

/** Identity of the markdown currently painted in `.sp-doc` (path + payload). */
function docSignature(path: string, markdown: string): string {
  return `${path}#${markdown.length}:${markdown.slice(0, 24)}`;
}

/** Backoff after empty preview reads. */
const DOC_RETRY_DELAYS_MS = [0, 80, 200, 400, 800, 1600];

/** Allow Node to exit while clocks/retries are pending (browser timers ignore this). */
function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null): void {
  if (timer && typeof timer === 'object' && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

// ── SuperPlanPage ────────────────────────────────────────────────────────────

class SuperPlanPage {
  readonly root: HTMLElement;
  private readonly handlers: SuperPlanPageHandlers;
  private readonly mode: 'compose' | 'run' | 'doc';
  private chatId: string;
  private errorMessage?: string;
  private docPath: string;

  /** Null until the user picks a segment; after that the run stops switching under them. */
  private manualSegment: SegmentId | null = null;
  private segment: SegmentId = 'activity';

  private buffer: ActivityLogBuffer | null = null;
  private collector: PlanActivityCollector | null = null;
  private transcript: SuperPlanTranscript | null = null;
  private transcriptEl: HTMLElement | null = null;
  private ledgerDisclosure: HTMLDetailsElement | null = null;
  private unsubBuffer: (() => void) | null = null;
  private renderedEntryIds = new Set<string>();
  private firstLedgerPaint = true;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private railObserver: ResizeObserver | null = null;
  private runPaneObserver: ResizeObserver | null = null;
  /** Drops Super Plan composer auto-resize listeners when the page unmounts. */
  private unbindComposerResize: (() => void) | null = null;

  private libraryEntries: PlanLibraryEntry[] = [];
  private libraryError?: string;
  private filterText = '';

  private docCache = new Map<string, string>();
  private docRequested = new Set<string>();
  /** Bumped on each preview fetch and on retarget so a late 404 cannot clobber a later hit. */
  private docFetchId = 0;
  private docRetryCount = new Map<string, number>();
  private docRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpecPath = '';
  private lastPlanPath = '';
  private renderedDocSig = '';
  /** Set in destroy() so an in-flight library fetch cannot paint a dead page. */
  private destroyed = false;

  private railList!: HTMLElement;
  private mainEl!: HTMLElement;
  private headTitle: HTMLElement | null = null;
  private headMore: HTMLButtonElement | null = null;
  private headStateEl: HTMLElement | null = null;
  private headStatsEl: HTMLElement | null = null;
  private segmentEls = new Map<SegmentId, HTMLButtonElement>();
  private activityCountEl: HTMLElement | null = null;
  private bodyMain: HTMLElement | null = null;
  private ledgerEl: HTMLElement | null = null;
  private ledgerEmptyEl: HTMLElement | null = null;
  private docEl: HTMLElement | null = null;
  private noticeEl: HTMLElement | null = null;
  private stagesEl: HTMLElement | null = null;
  private artifactsEl: HTMLElement | null = null;
  private questionsHost: HTMLElement | null = null;
  private dockEl: HTMLElement | null = null;
  private dockCopy: HTMLElement | null = null;
  private dockActions: HTMLElement | null = null;
  private actionRefs = new Map<string, HTMLButtonElement>();

  constructor(options: SuperPlanPageOptions) {
    this.handlers = options.handlers;
    this.mode = options.mode;
    this.chatId = options.chatId;
    this.errorMessage = options.errorMessage;
    this.docPath = options.docPath?.trim() ?? '';

    this.root = el('div', 'super-plan-page');
    this.root.id = SUPER_PLAN_PAGE_ROOT_ID;
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Super Plan');

    const shell = el('div', 'sp-shell');
    shell.append(this.buildRail(), this.buildMain(options));
    this.root.appendChild(shell);
    if (this.mode === 'compose') initComposerExpand(this.root);

    void this.loadLibrary();
    this.autoCollapseRailWhenNarrow();
    if (this.mode === 'run') {
      this.startCollector();
      this.startTicker();
    }
  }

  /** Below 660px the rail overlays the pane instead of sitting beside it, so leaving it open would cover the run. */
  private autoCollapseRailWhenNarrow(): void {
    if (typeof ResizeObserver !== 'function') return;
    let wasNarrow: boolean | null = null;
    const applyNarrow = scheduleAnimationFrame(() => {
      const width = this.root.clientWidth;
      if (width <= 0) return;
      const narrow = width < 660;
      if (narrow === wasNarrow) return;
      wasNarrow = narrow;
      this.root.classList.toggle('is-rail-hidden', narrow);
    });
    const observer = new ResizeObserver(() => applyNarrow());
    observer.observe(this.root);
    this.railObserver = observer;
  }

  private observeRunPaneMetrics(head: HTMLElement, body: HTMLElement): void {
    if (typeof ResizeObserver !== 'function') return;
    const publish = (): void => {
      body.style.setProperty('--sp-runhead-h', `${Math.round(head.offsetHeight)}px`);
      body.style.setProperty('--sp-runbody-h', `${Math.round(body.clientHeight)}px`);
    };
    const observer = new ResizeObserver(scheduleAnimationFrame(publish));
    observer.observe(head);
    observer.observe(body);
    publish();
    this.runPaneObserver = observer;
  }

  /** Narrow layouts overlay the rail, so picking a plan should get out of the way. */
  private collapseRailIfOverlaying(): void {
    if (this.root.clientWidth > 0 && this.root.clientWidth < 660) {
      this.root.classList.add('is-rail-hidden');
    }
  }

  destroy(): void {
    this.destroyed = true;
    cancelComposerExpandFor('superPlanPrompt');
    this.unbindComposerResize?.();
    this.unbindComposerResize = null;
    this.railObserver?.disconnect();
    this.railObserver = null;
    this.runPaneObserver?.disconnect();
    this.runPaneObserver = null;
    this.collector?.stop();
    this.collector = null;
    this.transcript?.destroy();
    this.transcript = null;
    this.unsubBuffer?.();
    this.unsubBuffer = null;
    this.buffer = null;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.resetDocLoader();
    this.root.remove();
  }

  isRunView(): boolean {
    return this.mode === 'run';
  }

  seedLedger(entries: ActivityLogEntry[]): void {
    if (!this.buffer) return;
    for (const entry of entries) this.buffer.append(entry);
  }

  /** Repoint at a different chat without rebuilding the page. */
  retarget(chatId: string): void {
    if (this.chatId === chatId) return;
    this.chatId = chatId;
    this.manualSegment = null;
    this.resetDocLoader();
    this.startCollector();
  }

  /** Drop in-flight spec/plan preview state so a plan switch cannot reuse a 404. */
  private resetDocLoader(): void {
    this.docFetchId += 1;
    this.docCache.clear();
    this.docRequested.clear();
    this.docRetryCount.clear();
    this.lastSpecPath = '';
    this.lastPlanPath = '';
    this.renderedDocSig = '';
    if (this.docRetryTimer) {
      clearTimeout(this.docRetryTimer);
      this.docRetryTimer = null;
    }
    if (this.docEl) delete this.docEl.dataset.path;
  }

  private buildRail(): HTMLElement {
    const rail = el('aside', 'sp-rail');
    rail.setAttribute('aria-label', 'Plans');

    const head = el('div', 'sp-rail__head');
    const newBtn = el('button', 'sp-new');
    newBtn.type = 'button';
    newBtn.append(svg(ICON_PLUS), document.createTextNode('New plan'));
    newBtn.addEventListener('click', () => this.handlers.onNewPlan());

    const collapse = el('button', 'sp-rail__collapse');
    collapse.type = 'button';
    collapse.setAttribute('aria-label', 'Hide plan list');
    collapse.appendChild(svg(ICON_CHEVRON_LEFT));
    collapse.addEventListener('click', () => {
      this.root.classList.toggle('is-rail-hidden');
    });
    head.append(newBtn, collapse);

    const filterWrap = el('div', 'sp-rail__filter');
    const filter = el('input', 'sp-rail__filter-input');
    filter.type = 'search';
    filter.placeholder = 'Filter plans';
    filter.setAttribute('aria-label', 'Filter plans');
    filter.addEventListener('input', () => {
      this.filterText = filter.value.trim().toLowerCase();
      this.paintRail();
    });
    filterWrap.appendChild(filter);

    this.railList = el('div', 'sp-rail__list');

    const foot = el('div', 'sp-rail__foot');
    const settingsLink = el('button', 'sp-foot-link', 'Pipeline settings');
    settingsLink.type = 'button';
    settingsLink.addEventListener('click', () => this.handlers.onOpenSettings?.());
    if (!this.handlers.onOpenSettings) settingsLink.hidden = true;
    foot.appendChild(settingsLink);

    rail.append(head, filterWrap, this.railList, foot);
    return rail;
  }

  private async loadLibrary(): Promise<void> {
    if (this.destroyed) return;
    try {
      const result = await listSuperPlanLibrary();
      if (this.destroyed) return;
      this.libraryEntries = result.entries;
      this.libraryError = result.error;
    } catch {
      if (this.destroyed) return;
      this.libraryEntries = [];
      this.libraryError = 'find_files failed';
    }
    this.paintRail();
  }

  /** Refresh the library after a run writes a file. Cheap enough to call on stage changes. */
  refreshLibrary(): void {
    void this.loadLibrary();
  }

  private paintRail(): void {
    const filtered = this.filterText
      ? this.libraryEntries.filter(
          (e) =>
            e.title.toLowerCase().includes(this.filterText) ||
            e.path.toLowerCase().includes(this.filterText),
        )
      : this.libraryEntries;

    this.railList.replaceChildren();

    if (!filtered.length) {
      const empty = el('p', 'sp-rail__empty');
      if (this.filterText) {
        empty.textContent = 'No plans match that filter.';
      } else if (this.libraryError === 'server_off') {
        empty.textContent = 'Start the local server to list saved plans.';
      } else if (this.libraryError === 'no_plans_dir') {
        empty.textContent = 'No plans yet. The first one lands in documentation/plans/.';
      } else if (this.libraryError) {
        empty.textContent = `Could not list plans: ${this.libraryError}`;
      } else {
        empty.textContent = 'No plans yet. The first one lands in documentation/plans/.';
      }
      this.railList.appendChild(empty);
      return;
    }

    for (const group of groupPlanLibraryEntries(filtered)) {
      const label = el('span', 'sp-group__label', group.label);
      this.railList.appendChild(label);
      for (const entry of group.entries) {
        this.railList.appendChild(this.buildRailRow(entry));
      }
    }

    if (this.libraryError === 'server_off') {
      const note = el(
        'p',
        'sp-rail__empty',
        'Saved plans are hidden while the local server is off.',
      );
      this.railList.appendChild(note);
    }
  }

  private buildRailRow(entry: PlanLibraryEntry): HTMLElement {
    const wrap = el('div', 'sp-row-wrap');
    const row = el('button', 'sp-row');
    row.type = 'button';
    const selected =
      this.mode === 'doc'
        ? Boolean(this.docPath) && entry.path === this.docPath
        : this.mode === 'run' && entry.chatId === this.chatId;
    if (selected) {
      row.classList.add('is-active');
      row.setAttribute('aria-current', 'true');
    }

    const title = el('span', 'sp-row__title', entry.title);
    const meta = el('span', 'sp-row__meta');

    const word = planLibraryStateLabel(entry.state);
    if (word) {
      const state = el('span', `sp-state is-${entry.state}`, word);
      meta.appendChild(state);
    }

    const bits: string[] = [];
    if (entry.stageLabel && entry.state !== 'saved' && entry.state !== 'done') {
      bits.push(entry.stageLabel);
    }
    const rel = formatRelativeTime(entry.atMs);
    if (rel) bits.push(rel);
    if (bits.length) meta.appendChild(document.createTextNode(bits.join(' · ')));

    row.append(title, meta);
    row.addEventListener('click', () => {
      this.collapseRailIfOverlaying();
      if (entry.chatId) this.handlers.onSelectRun(entry.chatId);
      else if (entry.path) this.handlers.onOpenPlanFile(entry.path);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showSuperPlanRowContextMenu(e.clientX, e.clientY, entry, this.handlers.onDeleteEntry);
    });
    wrap.appendChild(row);
    return wrap;
  }

  private buildMain(options: SuperPlanPageOptions): HTMLElement {
    this.mainEl = el('div', 'sp-main');
    if (options.mode === 'compose') {
      this.mainEl.appendChild(this.buildComposer(options.savedPrompt));
    } else if (options.mode === 'doc') {
      this.mainEl.appendChild(this.buildDocPane());
    } else {
      this.mainEl.appendChild(this.buildRunPane());
    }
    return this.mainEl;
  }

  /** A plan file the rail found on disk with no run behind it. */
  private buildDocPane(): HTMLElement {
    const pane = el('div', 'sp-pane sp-pane--run');
    const body = el('div', 'sp-runbody');

    const head = el('header', 'sp-runhead');
    const top = el('div', 'sp-runhead__top');
    const askWrap = el('div', 'sp-runhead__ask');
    const title = el('h1', 'sp-runhead__title', titleFromPlanPath(this.docPath));
    askWrap.appendChild(title);

    const actions = el('div', 'sp-runhead__actions');
    const railBtn = el('button', 'sp-action sp-action--rail', 'Plans');
    railBtn.type = 'button';
    railBtn.addEventListener('click', () => this.root.classList.toggle('is-rail-hidden'));
    actions.appendChild(railBtn);
    const copyBtn = el('button', 'sp-action', 'Copy path');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.docPath).catch(() => {
      });
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = 'Copy path';
      }, 1400);
    });
    actions.appendChild(copyBtn);
    top.append(askWrap, actions);

    const meta = el('div', 'sp-runhead__meta');
    const entry = this.libraryEntries.find((e) => e.path === this.docPath);
    const bits = [this.docPath];
    const rel = formatRelativeTime(entry?.atMs);
    if (rel) bits.push(rel);
    meta.appendChild(el('span', 'sp-runhead__stats', bits.join(' · ')));

    head.append(top, meta);

    const inner = el('div', 'sp-body');
    this.docEl = el('div', 'sp-doc');
    this.docEl.replaceChildren(el('p', 'sp-doc__missing', 'Loading…'));
    inner.appendChild(this.docEl);

    body.append(head, inner);

    this.dockEl = el('div', 'sp-dock');
    this.dockCopy = el('p', 'sp-dock__copy', 'Saved plan. Choose how to continue.');
    this.dockActions = el('div', 'sp-dock__actions');
    const button = (
      label: string,
      onClick: () => void,
      variant?: 'primary',
      disabled = false,
    ): HTMLButtonElement => {
      const btn = el('button', `sp-btn${variant ? ` sp-btn--${variant}` : ''}`, label);
      btn.type = 'button';
      btn.disabled = disabled;
      btn.addEventListener('click', onClick);
      this.dockActions!.appendChild(btn);
      return btn;
    };
    button('Revise', () => this.handlers.onRevisePlan(this.docPath));
    button('Build', () => this.handlers.onBuild(this.docPath));
    const orchestrate = button(
      'Start Orchestrator',
      () => this.handlers.onOrchestrate(this.docPath),
      'primary',
      entry?.executable === false,
    );
    if (orchestrate.disabled) {
      orchestrate.title = 'This plan has no wave or task front matter for the board to run.';
    }
    this.dockEl.append(this.dockCopy, this.dockActions);

    pane.append(body, this.dockEl);
    void readPlanArtifactMarkdown(this.docPath)
      .then((markdown) => {
        if (!this.docEl) return;
        mountPlanPreviewContent(this.docEl, markdown ?? '', {
          modeId: 'super-plan',
          emptyLabel: '(this plan file is empty or could not be read)',
        });
      })
      .catch(() => {
        this.docEl?.replaceChildren(
          el('p', 'sp-doc__missing', 'This plan file could not be read.'),
        );
      });
    return pane;
  }

  private buildComposer(savedPrompt?: string): HTMLElement {
    const pane = el('div', 'sp-pane sp-pane--ask');
    const ask = el('div', 'sp-ask');

    const title = el('h1', 'sp-ask__title', 'New plan');
    const sub = el(
      'p',
      'sp-ask__sub',
      'Interview, spec, research, draft, review, polish. The plan lands in documentation/plans/.',
    );

    const composer = el('div', 'sp-composer');
    const field = el('textarea', 'sp-composer__field');
    field.id = 'superPlanPrompt';
    field.rows = 4;
    field.spellcheck = false;
    field.setAttribute('autocomplete', 'off');
    field.setAttribute('autocorrect', 'off');
    field.setAttribute('autocapitalize', 'off');
    field.placeholder =
      'What should this plan cover? Goals, constraints, and how you want the work grouped.';
    field.setAttribute('aria-label', 'What should this plan cover?');
    if (savedPrompt) field.value = savedPrompt;

    const bar = el('div', 'sp-composer__bar');
    const opts = this.buildOptionChips();
    const modelAnchor = el('div', 'sp-model-anchor composer-model-trigger-anchor');
    modelAnchor.id = 'superPlanComposerModelAnchor';
    const spacer = el('div', 'sp-composer__spacer');

    const expand = el('button', 'composer-expand-btn composer-expand-btn--bar');
    expand.type = 'button';
    expand.id = 'btnSuperPlanExpand';
    expand.setAttribute('aria-label', 'Expand prompt');
    expand.setAttribute('aria-busy', 'false');
    expand.title = 'Expand prompt into a fuller version';
    expand.disabled = true;

    const send = el('button', 'sp-send');
    send.type = 'button';
    send.setAttribute('aria-label', 'Start planning');
    send.title = 'Start planning';
    send.appendChild(svg(ICON_SEND, 16));
    send.disabled = !field.value.trim();

    const submit = (): void => {
      const text = field.value.trim();
      if (!text) {
        field.focus();
        return;
      }
      this.handlers.onStart(text);
    };
    send.addEventListener('click', submit);
    field.addEventListener('input', () => {
      send.disabled = !field.value.trim();
    });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });
    this.unbindComposerResize = bindComposerAutoResize(field);

    bar.append(opts, spacer, modelAnchor, expand, send);
    composer.append(field, bar);
    mountComposerModelTrigger(modelAnchor, 'super-plan');

    const seeds = el('div', 'sp-seeds');
    seeds.appendChild(el('span', 'sp-seeds__label', 'Try'));
    for (const seed of SEED_PROMPTS) {
      const btn = el('button', 'sp-seed', seed);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        field.value = seed;
        send.disabled = !field.value.trim();
        const WinEvent = field.ownerDocument.defaultView?.Event;
        if (WinEvent) field.dispatchEvent(new WinEvent('input', { bubbles: true }));
        field.focus();
      });
      seeds.appendChild(btn);
    }

    ask.append(title, sub, composer, seeds);
    pane.appendChild(ask);
    return pane;
  }

  /** Chips read and write the same saved config the controller reads at stage time, so a change applies to the run you are about to start and becomes the default for the next one. */
  private buildOptionChips(): HTMLElement {
    const wrap = el('div', 'sp-opts');
    const config = getSuperPlanConfigSync();

    const closeAll = (except?: HTMLElement): void => {
      for (const pop of wrap.querySelectorAll<HTMLElement>('.sp-pop')) {
        if (pop === except) continue;
        pop.hidden = true;
        const chip = pop.previousElementSibling as HTMLButtonElement | null;
        chip?.setAttribute('aria-expanded', 'false');
      }
    };

    const makeChip = (
      id: string,
      label: () => string,
      isSet: () => boolean,
      isOff: () => boolean,
      build: (pop: HTMLElement, sync: () => void) => void,
    ): void => {
      const opt = el('div', 'sp-opt');
      const chip = el('button', 'sp-chip');
      chip.type = 'button';
      chip.id = `spChip-${id}`;
      chip.setAttribute('aria-expanded', 'false');
      chip.setAttribute('aria-haspopup', 'dialog');

      const text = el('span');
      const caret = el('span', 'sp-chip__caret', '▾');
      chip.append(text, caret);

      const pop = el('div', 'sp-pop');
      pop.hidden = true;
      pop.setAttribute('role', 'dialog');

      const sync = (): void => {
        text.textContent = label();
        chip.classList.toggle('is-set', isSet());
        chip.classList.toggle('is-off', isOff());
      };

      build(pop, sync);
      sync();

      chip.addEventListener('click', () => {
        const willOpen = pop.hidden;
        closeAll(willOpen ? pop : undefined);
        pop.hidden = !willOpen;
        chip.setAttribute('aria-expanded', String(willOpen));
      });
      pop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          pop.hidden = true;
          chip.setAttribute('aria-expanded', 'false');
          chip.focus();
        }
      });

      opt.append(chip, pop);
      wrap.appendChild(opt);
    };

    const patch = (next: Partial<SuperPlanConfig>): void => {
      void saveSuperPlanConfig(next).catch(() => {
      });
    };

    const field = (
      pop: HTMLElement,
      labelText: string,
      control: HTMLElement,
      hint?: string,
    ): void => {
      const f = el('div', 'sp-field');
      const l = el('span', 'sp-field__label', labelText);
      f.append(l, control);
      if (hint) f.appendChild(el('p', 'sp-field__hint', hint));
      pop.appendChild(f);
    };

    const select = (
      options: { value: string; label: string }[],
      value: string,
      onChange: (value: string) => void,
    ): HTMLElement => {
      const wrapper = el('div', 'sp-select');
      const sel = document.createElement('select');
      for (const option of options) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        sel.appendChild(node);
      }
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      wrapper.appendChild(sel);
      return wrapper;
    };

    let interviewToggle!: HTMLInputElement;
    let interviewBudget!: HTMLInputElement;
    makeChip(
      'interview',
      () =>
        interviewToggle.checked
          ? `Interview · ${interviewBudget.value}`
          : 'Interview off',
      () => Number(interviewBudget.value) !== 20,
      () => !interviewToggle.checked,
      (pop, sync) => {
        const toggleLabel = el('label', 'sp-field__check');
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = config.grillEnabled;
        interviewToggle = toggle;
        toggleLabel.append(toggle, document.createTextNode('Run the interview stage'));
        toggle.addEventListener('change', () => {
          patch({ grillEnabled: toggle.checked });
          sync();
        });
        pop.appendChild(toggleLabel);

        const budget = el('input', 'sp-input') as HTMLInputElement;
        budget.type = 'number';
        budget.min = '5';
        budget.max = '40';
        budget.value = String(config.grillQuestionBudget);
        interviewBudget = budget;
        const commitBudget = (): void => {
          patch({ grillQuestionBudget: Number(budget.value) });
          sync();
        };
        budget.addEventListener('input', commitBudget);
        budget.addEventListener('change', commitBudget);
        field(pop, 'Questions', budget, 'Roughly how many the interview aims for.');
      },
    );

    let researchToggle!: HTMLInputElement;
    let researchScope!: HTMLSelectElement;
    let researchDepth!: HTMLSelectElement;
    makeChip(
      'research',
      () => {
        if (!researchToggle.checked) return 'Research off';
        return `Research · ${RESEARCH_SCOPE_LABEL[researchScope.value as ResearchScope]} · ${
          RESEARCH_DEPTH_LABEL[researchDepth.value as SuperPlanResearchDepth]
        }`;
      },
      () => researchScope.value !== 'both' || researchDepth.value !== 'auto',
      () => !researchToggle.checked,
      (pop, sync) => {
        const toggleLabel = el('label', 'sp-field__check');
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = config.researchEnabled;
        researchToggle = toggle;
        toggleLabel.append(toggle, document.createTextNode('Run Deep Research'));
        toggle.addEventListener('change', () => {
          patch({ researchEnabled: toggle.checked });
          sync();
        });
        pop.appendChild(toggleLabel);

        const scopeWrap = select(
          [
            { value: 'both', label: 'Web and codebase' },
            { value: 'web', label: 'Web only' },
            { value: 'codebase', label: 'Codebase only' },
          ],
          config.researchScope,
          (value) => {
            patch({ researchScope: value as ResearchScope });
            sync();
          },
        );
        researchScope = scopeWrap.querySelector('select')!;
        field(pop, 'Scope', scopeWrap);

        const depthWrap = select(
          [
            { value: 'auto', label: 'Auto' },
            { value: 'quick', label: 'Quick (2 rounds)' },
            { value: 'standard', label: 'Standard (3 rounds)' },
            { value: 'deep', label: 'Deep (5 rounds)' },
          ],
          config.researchDepth,
          (value) => {
            patch({ researchDepth: value as SuperPlanResearchDepth, researchMaxRounds: 0 });
            sync();
          },
        );
        researchDepth = depthWrap.querySelector('select')!;
        field(pop, 'Depth', depthWrap);
      },
    );

    let reviewSelect!: HTMLSelectElement;
    makeChip(
      'reviews',
      () => {
        const n = Number(reviewSelect.value);
        return n === 0 ? 'No review' : `${n} review${n === 1 ? '' : 's'}`;
      },
      () => Number(reviewSelect.value) !== 2,
      () => Number(reviewSelect.value) === 0,
      (pop, sync) => {
        const wrap = select(
          [
            { value: '0', label: 'None' },
            { value: '1', label: '1 pass' },
            { value: '2', label: '2 passes' },
            { value: '3', label: '3 passes' },
            { value: '4', label: '4 passes' },
          ],
          String(config.reviewRounds),
          (value) => {
            patch({ reviewRounds: Number(value) });
            sync();
          },
        );
        reviewSelect = wrap.querySelector('select')!;
        field(
          pop,
          'Draft and review cycles',
          wrap,
          'Each pass sends the draft to the plan reviewer, then rewrites it.',
        );
      },
    );

    let impeccableSelect!: HTMLSelectElement;
    makeChip(
      'impeccable',
      () => `UI pass · ${impeccableSelect.value}`,
      () => impeccableSelect.value !== 'auto',
      () => impeccableSelect.value === 'never',
      (pop, sync) => {
        const wrap = select(
          [
            { value: 'auto', label: 'When the plan touches UI' },
            { value: 'always', label: 'Always' },
            { value: 'never', label: 'Never' },
          ],
          config.impeccable,
          (value) => {
            patch({ impeccable: value as SuperPlanImpeccableMode });
            sync();
          },
        );
        impeccableSelect = wrap.querySelector('select')!;
        field(pop, 'Impeccable UI pass', wrap);
      },
    );

    const note = el('p', 'sp-field__hint');
    note.textContent = 'Applies to this run and becomes the default.';
    note.style.width = '100%';
    note.style.margin = '2px 0 0';
    note.hidden = true;
    wrap.appendChild(note);
    wrap.addEventListener('focusin', () => {
      note.hidden = false;
    });

    document.addEventListener('click', (event) => {
      if (!wrap.isConnected) return;
      if (wrap.contains(event.target as Node)) return;
      closeAll();
    });

    return wrap;
  }

  private buildRunPane(): HTMLElement {
    const pane = el('div', 'sp-pane sp-pane--run');

    const body = el('div', 'sp-runbody');
    const head = this.buildRunHead();
    body.appendChild(head);
    this.observeRunPaneMetrics(head, body);

    const inner = el('div', 'sp-body');
    const cols = el('div', 'sp-cols');

    const main = el('div', 'sp-cols__main');
    this.bodyMain = main;

    this.noticeEl = el('div', 'sp-notice');
    this.noticeEl.hidden = true;
    this.noticeEl.setAttribute('role', 'status');

    this.questionsHost = el('div', 'sp-questions');
    this.questionsHost.id = SUPER_PLAN_PAGE_QUESTIONS_ID;
    this.questionsHost.hidden = true;

    this.transcriptEl = el('div', 'sp-transcript');
    this.ledgerDisclosure = el('details', 'sp-transcript__working');
    this.ledgerDisclosure.append(el('summary', undefined, 'Stage history'));
    this.ledgerEl = el('div', 'sp-ledger');
    this.ledgerDisclosure.append(this.ledgerEl);
    this.ledgerEmptyEl = el(
      'p',
      'sp-ledger__empty',
      'Starting the interview…',
    );

    this.docEl = el('div', 'sp-doc');
    this.docEl.hidden = true;

    main.append(this.noticeEl, this.questionsHost, this.ledgerDisclosure, this.transcriptEl, this.ledgerEmptyEl, this.docEl);

    const aside = el('div', 'sp-cols__aside');
    const stagesSec = el('h2', 'sp-sec', 'Pipeline');
    this.stagesEl = el('div', 'sp-stages');
    const artifactsWrap = el('div', 'sp-artifacts');
    const artifactsSec = el('h2', 'sp-sec', 'Artifacts');
    this.artifactsEl = el('div', 'sp-artifact-list');
    artifactsWrap.append(artifactsSec, this.artifactsEl);
    aside.append(stagesSec, this.stagesEl, artifactsWrap);

    cols.append(main, aside);
    inner.appendChild(cols);
    body.appendChild(inner);

    this.dockEl = el('div', 'sp-dock');
    this.dockEl.hidden = true;
    this.dockCopy = el('p', 'sp-dock__copy');
    this.dockActions = el('div', 'sp-dock__actions');
    this.dockEl.append(this.dockCopy, this.dockActions);

    pane.append(body, this.dockEl);
    return pane;
  }

  private buildRunHead(): HTMLElement {
    const head = el('header', 'sp-runhead');

    const top = el('div', 'sp-runhead__top');
    const askWrap = el('div', 'sp-runhead__ask');
    this.headTitle = el('h1', 'sp-runhead__title');
    this.headMore = el('button', 'sp-runhead__more', 'Show full prompt');
    this.headMore.type = 'button';
    this.headMore.hidden = true;
    this.headMore.addEventListener('click', () => {
      const expanded = this.headTitle?.classList.toggle('is-expanded');
      if (this.headMore) {
        this.headMore.textContent = expanded ? 'Show less' : 'Show full prompt';
      }
    });
    askWrap.append(this.headTitle, this.headMore);

    const actions = el('div', 'sp-runhead__actions');
    const addAction = (
      key: string,
      label: string,
      onClick: () => void,
      variant?: 'danger',
    ): void => {
      const btn = el('button', `sp-action${variant ? ` sp-action--${variant}` : ''}`, label);
      btn.type = 'button';
      btn.dataset.planAction = key;
      btn.addEventListener('click', onClick);
      this.actionRefs.set(key, btn);
      actions.appendChild(btn);
    };

    addAction('rail', 'Plans', () => this.root.classList.toggle('is-rail-hidden'));
    this.actionRefs.get('rail')?.classList.add('sp-action--rail');
    addAction('copyPath', 'Copy path', () => this.copyPlanPath());
    addAction('skipInterview', 'Skip interview', () => this.handlers.onSkipInterview());
    addAction('pause', 'Pause', () => this.handlers.onPause());
    addAction('resume', 'Resume', () => this.handlers.onResume());
    addAction('stop', 'Stop', () => this.handlers.onStop(), 'danger');

    top.append(askWrap, actions);

    const meta = el('div', 'sp-runhead__meta');
    this.headStateEl = el('span', 'sp-state');
    this.headStatsEl = el('span', 'sp-runhead__stats');
    meta.append(this.headStateEl, this.headStatsEl);

    const segments = el('div', 'sp-segments');
    segments.setAttribute('role', 'tablist');
    const addSegment = (id: SegmentId, label: string, withCount = false): void => {
      const btn = el('button', 'sp-segment');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.append(document.createTextNode(label));
      if (withCount) {
        this.activityCountEl = el('span', 'sp-segment__count');
        btn.appendChild(this.activityCountEl);
      }
      btn.addEventListener('click', () => {
        this.manualSegment = id;
        this.segment = id;
        this.applyToChat();
      });
      this.segmentEls.set(id, btn);
      segments.appendChild(btn);
    };
    addSegment('activity', 'Activity', true);
    addSegment('spec', 'Spec');
    addSegment('plan', 'Plan');

    head.append(top, meta, segments);
    return head;
  }

  private copyPlanPath(): void {
    const chat = findChatById(this.chatId);
    const sp = chat?.superPlanView;
    const path = sp ? planPathOf(sp) || specPathOf(sp) : '';
    if (!path) return;
    void navigator.clipboard?.writeText(path).catch(() => {
    });
    const btn = this.actionRefs.get('copyPath');
    if (!btn) return;
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.textContent = 'Copy path';
    }, 1400);
  }

  /** Host for the interview's question cards, kept inline in the ledger column. */
  getQuestionsHost(): HTMLElement | null {
    if (!this.questionsHost) return null;
    this.questionsHost.hidden = false;
    return this.questionsHost;
  }

  private startCollector(): void {
    this.transcript?.destroy();
    this.transcript = this.transcriptEl ? new SuperPlanTranscript(this.transcriptEl, this.chatId) : null;
    this.collector?.stop();
    this.unsubBuffer?.();
    this.unsubBuffer = null;
    this.collector = null;
    // New buffer + empty DOM: paintLedger will not drop stale rows when the
    // first paint is empty (the previous run's entries would otherwise remain).
    this.renderedEntryIds.clear();
    this.firstLedgerPaint = true;
    this.ledgerEl?.replaceChildren();
    this.buffer = new ActivityLogBuffer();
    this.unsubBuffer = this.buffer.subscribe(() => this.paintLedger());
    this.collector = new PlanActivityCollector(this.chatId, this.buffer);
    void this.collector.start();
  }

  private startTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => this.paintClocks(), 1000);
    unrefTimer(this.ticker);
  }

  /** Patch every live region from the current chat. Safe to call on any tick. */
  applyToChat(): void {
    const chat = findChatById(this.chatId);
    if (!chat?.superPlanView || this.mode !== 'run') return;
    const sp = chat.superPlanView;
    const state = resolveRunState(chat);

    this.paintHead(chat, sp, state);
    this.paintSegments(sp, state);
    this.paintNotice(chat, sp, state);
    this.paintStages(sp, state);
    this.paintArtifacts(sp);
    this.paintDock(chat, sp, state);
    this.syncWritableDocPaths(sp);
    this.paintBody(sp);
    this.paintClocks();
    if (this.questionsHost) renderSuperPlanGate(this.questionsHost, chat);
    this.transcript?.schedule();
  }

  private paintHead(chat: Chat, sp: SuperPlanState, state: RunState): void {
    if (this.headTitle) {
      const path = planPathOf(sp) || specPathOf(sp);
      const title = resolveSuperPlanDisplayTitle(sp, path);
      if (this.headTitle.textContent !== title) {
        this.headTitle.textContent = title;
      }
      this.syncTitleOverflow();
    }
    if (this.headStateEl) {
      this.headStateEl.className = `sp-state ${stateClass(state)}`;
      this.headStateEl.textContent = RUN_STATE_WORD[state];
    }
    void chat;
  }

  /** Show "Show full prompt" only when the clamp actually hid something. */
  private syncTitleOverflow(retries = 4): void {
    const title = this.headTitle;
    const more = this.headMore;
    if (!title || !more) return;
    if (title.clientHeight === 0) {
      if (retries > 0 && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => this.syncTitleOverflow(retries - 1));
      }
      return;
    }
    const clamped = !title.classList.contains('is-expanded');
    more.hidden = clamped && title.scrollHeight - title.clientHeight <= 2;
  }

  private paintSegments(sp: SuperPlanState, state: RunState): void {
    const hasSpec = Boolean(specPathOf(sp));
    const hasPlan = Boolean(planPathOf(sp));
    this.segmentEls.get('spec')!.hidden = !hasSpec;
    this.segmentEls.get('plan')!.hidden = !hasPlan;

    if (this.manualSegment && this.isSegmentAvailable(this.manualSegment, sp)) {
      this.segment = this.manualSegment;
    } else {
      const checkpoint = getSuperPlanCheckpointKind(findChatById(this.chatId) ?? ({} as Chat));
      if (checkpoint === 'spec_confirm' && hasSpec) this.segment = 'spec';
      else if (checkpoint === 'present' && hasPlan) this.segment = 'plan';
      else if (hasPlan && (state === 'done' || state === 'cancelled')) this.segment = 'plan';
      else this.segment = 'activity';
    }

    for (const [id, btn] of this.segmentEls) {
      const on = id === this.segment;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', String(on));
    }
    if (this.activityCountEl && this.buffer) {
      const count = this.buffer.getEntries().length;
      this.activityCountEl.textContent = count ? String(count) : '';
    }
  }

  private isSegmentAvailable(id: SegmentId, sp: SuperPlanState): boolean {
    if (id === 'spec') return Boolean(specPathOf(sp));
    if (id === 'plan') return Boolean(planPathOf(sp));
    return true;
  }

  private paintNotice(chat: Chat, sp: SuperPlanState, state: RunState): void {
    const notice = this.noticeEl;
    if (!notice) return;
    notice.className = 'sp-notice';
    notice.replaceChildren();

    const stageLabel = SUPER_PLAN_STAGE_LABELS[sp.activeStage];

    if (state === 'error') {
      notice.classList.add('sp-notice--error');
      notice.setAttribute('role', 'alert');
      notice.append(
        el('span', 'sp-notice__label', `${stageLabel} failed`),
        document.createTextNode(
          this.errorMessage?.trim() ||
            sp.stages[sp.activeStage]?.error?.trim() ||
            'Earlier stages are kept. Retry this stage, skip it, or open the chat to see what happened.',
        ),
      );
      notice.hidden = false;
      return;
    }

    notice.setAttribute('role', 'status');

    if (state === 'stalled') {
      notice.classList.add('sp-notice--warning');
      notice.append(
        el('span', 'sp-notice__label', 'No activity'),
        document.createTextNode(
          `${stageLabel} has not reported for a while. Resume to continue, or open the chat to see what happened.`,
        ),
      );
      notice.hidden = false;
      return;
    }

    if (state === 'cancelled') {
      notice.append(
        el('span', 'sp-notice__label', 'Stopped'),
        document.createTextNode(
          'This run was stopped. Finished stages and their files are kept; a new run starts fresh.',
        ),
      );
      notice.hidden = false;
      return;
    }

    if (state === 'paused') {
      notice.append(
        el('span', 'sp-notice__label', 'Paused'),
        document.createTextNode(`Resume to continue from ${stageLabel}.`),
      );
      notice.hidden = false;
      return;
    }

    notice.hidden = true;
    void chat;
  }

  private paintStages(sp: SuperPlanState, state: RunState): void {
    const host = this.stagesEl;
    if (!host) return;
    const config = getSuperPlanConfigSync();
    const activeIndex = SUPER_PLAN_DISPLAY_ORDER.indexOf(sp.activeStage);
    const live = state === 'running' || state === 'waiting';

    host.replaceChildren();
    for (const [index, stageId] of SUPER_PLAN_DISPLAY_ORDER.entries()) {
      if (['draft2', 'review2', 'finalize'].includes(stageId)) continue;
      const record = sp.stages[stageId];
      const skipped = (sp.enabledStages ? !sp.enabledStages.includes(stageId) : shouldSkipSuperPlanStage(stageId, config)) && record?.status !== 'done';
      const done = record?.status === 'done' || (!skipped && index < activeIndex);
      const isActive = stageId === sp.activeStage && !sp.cancelled;
      const waiting = isActive && record?.status === 'blocked_user';
      const failed = isActive && record?.status === 'error';
      const running = isActive && !waiting && !failed && live;
      const halted = isActive && !waiting && !failed && !live && !done;

      const reworkable = done && !sp.cancelled && index < activeIndex;
      const node = el(reworkable ? 'button' : 'div', 'sp-stage');
      if (reworkable) {
        (node as HTMLButtonElement).type = 'button';
        node.classList.add('sp-stage--clickable');
        node.setAttribute('aria-label', `Rework the pipeline from ${SUPER_PLAN_STAGE_LABELS[stageId]}`);
        node.title = 'Rework the pipeline from this stage';
        node.addEventListener('click', () => this.handlers.onRework(stageId));
      }

      if (failed) node.classList.add('is-error');
      else if (waiting) node.classList.add('is-waiting');
      else if (running) node.classList.add('is-running');
      else if (halted) node.classList.add('is-halted');
      else if (done) node.classList.add('is-done');
      else if (skipped) node.classList.add('is-skipped');

      const mark = el('span', 'sp-stage__mark');
      if (done) mark.textContent = '✓';
      else if (failed) mark.textContent = '!';
      else if (skipped) mark.textContent = '–';
      else mark.appendChild(el('span', 'sp-stage__dot'));

      const name = el('span', 'sp-stage__name', SUPER_PLAN_STAGE_LABELS[stageId]);
      const time = el('span', 'sp-stage__time');
      time.dataset.stage = stageId;
      time.textContent = this.stageTimeText(record, running);

      node.append(mark, name, time);

      const noteText = skipped
        ? 'skipped'
        : waiting
          ? 'waiting for you'
          : halted
            ? state === 'error'
              ? ''
              : state
            : record?.artifactPath?.trim()
              ? baseName(record.artifactPath.trim())
              : '';
      if (noteText) {
        node.appendChild(el('span', 'sp-stage__note', noteText));
      }

      host.appendChild(node);
    }
  }

  private stageTimeText(
    record: SuperPlanState['stages'][SuperPlanStageId] | undefined,
    running: boolean,
  ): string {
    if (!record?.startedAt) return '';
    if (running) return formatClock(Date.now() - record.startedAt);
    if (record.finishedAt) return formatClock(record.finishedAt - record.startedAt);
    return '';
  }

  private paintArtifacts(sp: SuperPlanState): void {
    const host = this.artifactsEl;
    if (!host) return;
    host.replaceChildren();

    const rows: { kind: string; path: string }[] = [];
    const spec = specPathOf(sp);
    const research = researchPathOf(sp);
    const plan = planPathOf(sp);
    if (spec) rows.push({ kind: 'Spec', path: spec });
    if (research) rows.push({ kind: 'Research', path: research });
    if (plan) rows.push({ kind: 'Plan', path: plan });

    if (!rows.length) {
      host.appendChild(
        el('p', 'sp-empty', 'Files appear here as the pipeline writes them.'),
      );
      return;
    }

    for (const row of rows) {
      const node = el('div', 'sp-artifact');
      node.title = row.path;
      node.append(
        el('span', 'sp-artifact__name', baseName(row.path)),
        el('span', 'sp-artifact__kind', row.kind),
      );
      host.appendChild(node);
    }
  }

  private paintDock(chat: Chat, sp: SuperPlanState, state: RunState): void {
    const dock = this.dockEl;
    const copy = this.dockCopy;
    const actions = this.dockActions;
    if (!dock || !copy || !actions) return;

    actions.replaceChildren();
    const checkpoint = getSuperPlanCheckpointKind(chat);
    const stageLabel = SUPER_PLAN_STAGE_LABELS[sp.activeStage];

    const button = (
      label: string,
      onClick: () => void,
      variant?: 'primary' | 'danger',
      disabled = false,
    ): HTMLButtonElement => {
      const btn = el('button', `sp-btn${variant ? ` sp-btn--${variant}` : ''}`, label);
      btn.type = 'button';
      btn.disabled = disabled;
      btn.addEventListener('click', onClick);
      actions.appendChild(btn);
      return btn;
    };

    if (state === 'error') {
      copy.textContent = `${stageLabel} failed. Earlier stages are kept.`;
      button('Cancel pipeline', () => this.handlers.onCancelPipeline());
      if (['grill', 'research', 'review1', 'review2', 'impeccable'].includes(sp.activeStage)) button(`Skip ${stageLabel}`, () => this.handlers.onSkipStage());
      button(`Retry ${stageLabel}`, () => this.handlers.onRetryStage(), 'primary');
      dock.hidden = false;
      return;
    }

    if (checkpoint === 'spec_confirm') {
      copy.textContent = 'Confirm the build spec to continue with research and drafting.';
      button('Revise spec', () => this.handlers.onReviseSpec());
      button('Confirm spec', () => this.handlers.onConfirmSpec(), 'primary');
      dock.hidden = false;
      return;
    }

    if (checkpoint === 'present') {
      const planPath = planPathOf(sp);
      const entry = this.libraryEntries.find((e) => e.path === planPath);
      copy.textContent = 'The plan is saved. Choose how to continue.';
      button('Revise', () => this.handlers.onRevisePlan(planPath));
      button('Build', () => this.handlers.onBuild(planPath), undefined, !planPath);
      const orchestrate = button(
        'Start Orchestrator',
        () => this.handlers.onOrchestrate(planPath),
        'primary',
        !planPath || entry?.executable === false,
      );
      if (orchestrate.disabled) {
        orchestrate.title = 'This plan has no wave or task front matter for the board to run.';
      }
      dock.hidden = false;
      return;
    }

    dock.hidden = true;
  }

  private syncWritableDocPaths(sp: SuperPlanState): void {
    const spec = specPathOf(sp);
    const plan = planPathOf(sp);
    if (spec !== this.lastSpecPath) {
      if (this.lastSpecPath) this.dropDocCache(this.lastSpecPath);
      this.lastSpecPath = spec;
    }
    if (plan !== this.lastPlanPath) {
      if (this.lastPlanPath) this.dropDocCache(this.lastPlanPath);
      this.lastPlanPath = plan;
    }
  }

  private dropDocCache(path: string): void {
    if (!path) return;
    this.docCache.delete(path);
    this.docRequested.delete(path);
    this.docRetryCount.delete(path);
    if (this.renderedDocSig.startsWith(`${path}#`)) this.renderedDocSig = '';
    if (this.docEl?.dataset.path === path) delete this.docEl.dataset.path;
  }

  private paintBody(sp: SuperPlanState): void {
    const showDoc = this.segment !== 'activity';
    if (this.transcriptEl) this.transcriptEl.hidden = showDoc;
    if (this.ledgerDisclosure) this.ledgerDisclosure.hidden = showDoc;
    if (this.ledgerEl) this.ledgerEl.hidden = showDoc;
    if (this.ledgerEmptyEl) {
      this.ledgerEmptyEl.hidden = Boolean(this.transcriptEl) || showDoc || Boolean(this.buffer?.getEntries().length);
    }
    if (this.docEl) this.docEl.hidden = !showDoc;
    if (!showDoc) return;

    const path = this.segment === 'spec' ? specPathOf(sp) : planPathOf(sp);
    if (!path || !this.docEl) return;

    const cached = this.docCache.get(path);
    if (cached?.trim()) {
      this.mountDocMarkdown(path, cached);
      return;
    }

    const attempt = this.docRetryCount.get(path) ?? 0;
    if (attempt >= DOC_RETRY_DELAYS_MS.length) {
      this.mountEmptyDocPlaceholder(path);
      return;
    }

    if (this.docRequested.has(path)) return;
    this.docRequested.add(path);
    const fetchId = ++this.docFetchId;
    if (attempt === 0) {
      this.docEl.dataset.path = '';
      this.docEl.replaceChildren(el('p', 'sp-doc__missing', 'Loading…'));
    }

    void readPlanArtifactMarkdown(path, { cacheBust: fetchId })
      .then((markdown) => {
        if (fetchId !== this.docFetchId) return;
        this.docRequested.delete(path);
        const text = markdown ?? '';
        if (text.trim()) {
          this.docCache.set(path, text);
          this.docRetryCount.delete(path);
          this.paintBodyFromCurrentChat();
          return;
        }
        this.queueDocRetry(path, attempt);
      })
      .catch(() => {
        if (fetchId !== this.docFetchId) return;
        this.docRequested.delete(path);
        this.queueDocRetry(path, attempt);
      });
  }

  private paintBodyFromCurrentChat(): void {
    const chat = findChatById(this.chatId);
    if (chat?.superPlanView) this.paintBody(chat.superPlanView);
  }

  private queueDocRetry(path: string, attempt: number): void {
    const nextAttempt = attempt + 1;
    this.docRetryCount.set(path, nextAttempt);
    if (nextAttempt >= DOC_RETRY_DELAYS_MS.length) {
      this.mountEmptyDocPlaceholder(path);
      return;
    }
    const delay = DOC_RETRY_DELAYS_MS[attempt] ?? 0;
    if (this.docRetryTimer) clearTimeout(this.docRetryTimer);
    this.docRetryTimer = setTimeout(() => {
      this.docRetryTimer = null;
      this.paintBodyFromCurrentChat();
    }, delay);
    unrefTimer(this.docRetryTimer);
  }

  private mountDocMarkdown(path: string, markdown: string): void {
    if (!this.docEl) return;
    const sig = docSignature(path, markdown);
    if (this.renderedDocSig === sig) return;
    this.renderedDocSig = sig;
    this.docEl.dataset.path = path;
    try {
      mountPlanPreviewContent(this.docEl, markdown, {
        modeId: 'super-plan',
        emptyLabel: '(this file is empty or could not be read)',
      });
    } catch {
      this.docEl.textContent = markdown.trim() || '(this file is empty or could not be read)';
    }
  }

  private mountEmptyDocPlaceholder(path: string): void {
    this.mountDocMarkdown(path, '');
  }

  private paintLedger(): void {
    const host = this.ledgerEl;
    const buffer = this.buffer;
    if (!host || !buffer) return;

    const entries = buffer.getEntries();
    if (this.ledgerEmptyEl) {
      this.ledgerEmptyEl.hidden = Boolean(this.transcriptEl) || entries.length > 0 || this.segment !== 'activity';
    }
    if (this.activityCountEl) {
      this.activityCountEl.textContent = entries.length ? String(entries.length) : '';
    }

    const known = this.renderedEntryIds;
    const firstRendered = host.querySelector<HTMLElement>('[data-entry-id]');
    const dropped =
      firstRendered && entries.length > 0 && !entries.some((e) => e.id === firstRendered.dataset.entryId);
    if (dropped) {
      host.replaceChildren();
      known.clear();
    }

    const atBottom = this.isLedgerAtBottom();
    let appended = false;
    for (const entry of entries) {
      if (known.has(entry.id)) continue;
      known.add(entry.id);
      host.appendChild(this.buildLedgerEntry(entry, !this.firstLedgerPaint));
      appended = true;
    }
    this.firstLedgerPaint = false;
    if (appended && atBottom) this.scrollLedgerToBottom();
  }

  private buildLedgerEntry(entry: ActivityLogEntry, animate: boolean): HTMLElement {
    const row = el('div', `sp-entry sp-entry--${entry.kind}`);
    row.dataset.entryId = entry.id;
    if (entry.tone === 'warning') row.classList.add('sp-entry--warning');
    if (entry.tone === 'danger') row.classList.add('sp-entry--error');
    if (animate) row.classList.add('sp-entry--enter');

    row.appendChild(el('span', 'sp-entry__at', formatActivityTimestamp(entry.atMs)));

    const text = el('span', 'sp-entry__text');
    text.appendChild(el('span', 'sp-entry__label', entry.label));
    if (entry.detail?.trim()) {
      text.appendChild(document.createTextNode(` ${entry.detail.trim()}`));
    }
    if (entry.url?.trim()) {
      const link = document.createElement('a');
      link.href = entry.url.trim();
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = ' open';
      text.appendChild(link);
    }
    if (entry.queries?.length) {
      const list = el('ul', 'sp-entry__queries');
      for (const query of entry.queries.slice(0, 8)) {
        list.appendChild(el('li', undefined, query));
      }
      text.appendChild(list);
    }

    row.appendChild(text);
    return row;
  }

  private ledgerScroller(): HTMLElement | null {
    return this.root.querySelector('.sp-runbody');
  }

  private isLedgerAtBottom(): boolean {
    const scroller = this.ledgerScroller();
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }

  private scrollLedgerToBottom(): void {
    const scroller = this.ledgerScroller();
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }

  /** Clock-only repaint, so the second hand never rebuilds the ledger. */
  private paintClocks(): void {
    const chat = findChatById(this.chatId);
    const sp = chat?.superPlanView;
    if (!sp) return;

    if (this.headStatsEl) {
      const position = chat!.superPlanView?.stageIndex || SUPER_PLAN_DISPLAY_ORDER.indexOf(sp.activeStage) + 1;
      const start = pipelineStartMs(sp);
      const state = resolveRunState(chat!);
      const bits = [`stage ${position} of ${chat!.superPlanView?.stageTotal || SUPER_PLAN_DISPLAY_ORDER.length}`];
      bits.push(SUPER_PLAN_STAGE_LABELS[sp.activeStage].toLowerCase());
      if (start && state === 'running') bits.push(`${formatClock(Date.now() - start)} elapsed`);
      else if (start) {
        bits.push(`${formatClock((this.lastFinishedMs(sp) ?? Date.now()) - start)} elapsed`);
      }
      if (sp.slug) bits.push(sp.slug);
      this.headStatsEl.textContent = bits.join(' · ');
    }

    const record = sp.stages[sp.activeStage];
    const live = resolveRunState(chat!) === 'running';
    if (live && record?.status === 'running' && record.startedAt) {
      const node = this.stagesEl?.querySelector<HTMLElement>(
        `[data-stage="${sp.activeStage}"]`,
      );
      if (node) node.textContent = formatClock(Date.now() - record.startedAt);
    }

    this.updateActionVisibility(chat!, sp);
  }

  private lastFinishedMs(sp: SuperPlanState): number | null {
    let latest = 0;
    for (const stageId of SUPER_PLAN_DISPLAY_ORDER) {
      latest = Math.max(latest, sp.stages[stageId]?.finishedAt ?? 0);
    }
    return latest > 0 ? latest : null;
  }

  private updateActionVisibility(chat: Chat, sp: SuperPlanState): void {
    const state = resolveRunState(chat);
    const showResume = state === 'paused' || state === 'stalled';
    const finished = state === 'done' || state === 'cancelled';
    const set = (key: string, hidden: boolean): void => {
      const btn = this.actionRefs.get(key);
      if (btn) btn.hidden = hidden;
    };
    set('skipInterview', sp.activeStage !== 'grill' || finished);
    set('pause', showResume || finished || state === 'error' || state === 'waiting');
    set('resume', !showResume);
    set('stop', finished);
    set('copyPath', !planPathOf(sp) && !specPathOf(sp));
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Build the Super Plan page and take ownership of the live wiring. */
export function buildSuperPlanPageDom(options: SuperPlanPageOptions): HTMLElement {
  page?.destroy();
  page = new SuperPlanPage(options);
  if (options.mode === 'run') page.applyToChat();
  return page.root;
}

/** Patch the mounted page from current chat state. */
export function syncSuperPlanPage(chat: Chat): void {
  if (!page || !page.root.isConnected || !page.isRunView()) return;
  page.retarget(chat.id);
  page.applyToChat();
}

/** Re-list the plan library (call after a stage writes a file). */
export function refreshSuperPlanLibrary(): void {
  if (!page || !page.root.isConnected) return;
  page.refreshLibrary();
}

/** Inline host for the interview's question cards. */
export function getSuperPlanQuestionsHost(): HTMLElement | null {
  if (!page || !page.root.isConnected) return null;
  return page.getQuestionsHost();
}

/** Push synthetic ledger rows into the mounted page. */
export function seedSuperPlanLedgerForTests(entries: ActivityLogEntry[]): void {
  page?.seedLedger(entries);
}

export function teardownSuperPlanPage(): void {
  unmountSuperPlanComposerModelTrigger();
  page?.destroy();
  page = null;
}

/** True when the Super Plan page owns #chatArea right now. */
export function isSuperPlanPageMounted(): boolean {
  return Boolean(page?.root.isConnected);
}
