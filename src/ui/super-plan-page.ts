/**
 * The Super Plan surface: a library rail of plans and runs beside one main
 * pane. The pane shows a composer for a new plan, a run (header, checkpoint,
 * activity, documents, pipeline), or a saved plan file. The rail stays put
 * while the pane swaps, so moving between plans never rebuilds the page.
 *
 * The page only paints and forwards intent; `super-plan-entry.ts` decides
 * which chat and run the pane shows, and the server owns every run.
 */

import {
  collectSuperPlanRuns,
  formatRelativeTime,
  groupPlanLibraryEntries,
  listSuperPlanLibrary,
  planLibraryStateLabel,
  titleFromPlanPath,
  type PlanLibraryEntry,
} from '../chat/super-plan/plan-library';
import { subscribeSuperPlanSummaries } from '../chat/super-plan/store';
import {
  getSuperPlanConfigSync,
  loadSuperPlanConfig,
  saveSuperPlanConfig,
  type SuperPlanConfig,
  type SuperPlanImpeccableMode,
  type SuperPlanResearchDepth,
} from '../config/super-plan-meta';
import type { ResearchScope } from '../research/types';
import { mountPlanPreviewContent, readPlanArtifactMarkdown } from '../chat/plans/plan-preview';
import { scheduleAnimationFrame } from '../lib/schedule-animation-frame';
import { mountComposerModelTrigger, unmountSuperPlanComposerModelTrigger } from './composer-model-trigger';
import { bindComposerAutoResize } from './composer-auto-resize';
import { cancelComposerExpandFor, initComposerExpand } from './composer-expand';
import { el, ICON, svg, button } from './super-plan/dom';
import { RunPane } from './super-plan/run-pane';

export const SUPER_PLAN_PAGE_ROOT_ID = 'superPlanPage';
export const SUPER_PLAN_PROMPT_FIELD_ID = 'superPlanPrompt';

export type SuperPlanPageView =
  | { mode: 'compose'; chatId: string }
  | { mode: 'run'; chatId: string; runId: string }
  | { mode: 'doc'; chatId: string; path: string };

export interface SuperPlanPageHandlers {
  /** Start a run from the composer. Rejects with a message the composer shows. */
  start: (chatId: string, prompt: string) => Promise<void>;
  selectRun: (chatId: string) => void;
  openPlanFile: (path: string) => void;
  newPlan: () => void;
  deleteEntry: (entry: PlanLibraryEntry) => void;
  openSettings: () => void;
  openFile: (path: string) => void;
  orchestrate: (path: string) => void;
  build: (path: string) => void;
  revisePlanFile: (path: string) => void;
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

/** Rail below this width overlays the pane instead of sitting beside it. */
const NARROW_PX = 660;

/** Unsent composer text per chat, so leaving a new plan and coming back keeps it. */
const composerDrafts = new Map<string, string>();

let page: SuperPlanPage | null = null;

function sameView(a: SuperPlanPageView | null, b: SuperPlanPageView): boolean {
  if (!a || a.mode !== b.mode || a.chatId !== b.chatId) return false;
  if (a.mode === 'run' && b.mode === 'run') return a.runId === b.runId;
  if (a.mode === 'doc' && b.mode === 'doc') return a.path === b.path;
  return true;
}

// ── Page ─────────────────────────────────────────────────────────────────────

class SuperPlanPage {
  readonly root: HTMLElement;
  private current: SuperPlanPageView | null = null;
  private readonly mainEl = el('div', 'sp-main');
  private readonly railList = el('div', 'sp-rail__list');
  private runPane: RunPane | null = null;
  private paneCleanup: Array<() => void> = [];
  private readonly cleanup: Array<() => void> = [];
  private libraryEntries: PlanLibraryEntry[] = [];
  private libraryError?: string;
  private libraryLoads = 0;
  private railSignature = '';
  private knownRunPaths = '';
  private filterText = '';
  private destroyed = false;

  constructor(private readonly handlers: SuperPlanPageHandlers) {
    this.root = el('div', 'super-plan-page');
    this.root.id = SUPER_PLAN_PAGE_ROOT_ID;
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Super Plan');
    const shell = el('div', 'sp-shell');
    shell.append(this.buildRail(), this.mainEl);
    this.root.append(shell);
    this.autoCollapseRailWhenNarrow();
    this.cleanup.push(subscribeSuperPlanSummaries(() => this.scheduleRailRefresh()));
    void this.loadLibrary();
  }

  get view(): SuperPlanPageView | null {
    return this.current;
  }

  show(view: SuperPlanPageView): void {
    if (this.destroyed || sameView(this.current, view)) return;
    this.teardownPane();
    this.current = view;
    if (view.mode === 'compose') this.mainEl.replaceChildren(this.buildComposer(view.chatId));
    else if (view.mode === 'doc') this.mainEl.replaceChildren(this.buildDocPane(view.path));
    else this.mountRun(view.chatId, view.runId);
    this.paintRail(true);
  }

  refreshLibrary(): void {
    void this.loadLibrary();
  }

  destroy(): void {
    this.destroyed = true;
    this.teardownPane();
    for (const fn of this.cleanup.splice(0)) fn();
    if (this.railTimer) clearTimeout(this.railTimer);
    this.root.remove();
  }

  private teardownPane(): void {
    this.runPane?.destroy();
    this.runPane = null;
    for (const fn of this.paneCleanup.splice(0)) fn();
    this.mainEl.replaceChildren();
  }

  // ── Layout ─────────────────────────────────────────────────────────────────

  private autoCollapseRailWhenNarrow(): void {
    if (typeof ResizeObserver !== 'function') return;
    let wasNarrow: boolean | null = null;
    const apply = scheduleAnimationFrame(() => {
      const width = this.root.clientWidth;
      if (width <= 0) return;
      const narrow = width < NARROW_PX;
      if (narrow === wasNarrow) return;
      wasNarrow = narrow;
      this.root.classList.toggle('is-rail-hidden', narrow);
    });
    const observer = new ResizeObserver(() => apply());
    observer.observe(this.root);
    this.cleanup.push(() => observer.disconnect());
  }

  private toggleRail(): void {
    this.root.classList.toggle('is-rail-hidden');
  }

  /** Narrow layouts overlay the rail, so picking a plan gets it out of the way. */
  private collapseRailIfOverlaying(): void {
    if (this.root.clientWidth > 0 && this.root.clientWidth < NARROW_PX) this.root.classList.add('is-rail-hidden');
  }

  // ── Rail ───────────────────────────────────────────────────────────────────

  private buildRail(): HTMLElement {
    const rail = el('aside', 'sp-rail');
    rail.setAttribute('aria-label', 'Plans');

    const head = el('div', 'sp-rail__head');
    const newBtn = el('button', 'sp-new');
    newBtn.type = 'button';
    newBtn.append(svg(ICON.plus), document.createTextNode('New plan'));
    newBtn.addEventListener('click', () => this.handlers.newPlan());
    const collapse = el('button', 'sp-rail__collapse');
    collapse.type = 'button';
    collapse.setAttribute('aria-label', 'Hide plan list');
    collapse.append(svg(ICON.chevronLeft));
    collapse.addEventListener('click', () => this.toggleRail());
    head.append(newBtn, collapse);

    const filterWrap = el('div', 'sp-rail__filter');
    const filter = el('input', 'sp-rail__filter-input');
    filter.type = 'search';
    filter.placeholder = 'Filter plans';
    filter.setAttribute('aria-label', 'Filter plans');
    filter.addEventListener('input', () => {
      this.filterText = filter.value.trim().toLowerCase();
      this.paintRail(true);
    });
    filterWrap.append(filter);

    this.railList.setAttribute('role', 'list');
    this.railList.addEventListener('keydown', (event) => this.onRailKey(event));

    const foot = el('div', 'sp-rail__foot');
    const settings = el('button', 'sp-foot-link', 'Pipeline settings');
    settings.type = 'button';
    settings.addEventListener('click', () => this.handlers.openSettings());
    foot.append(settings);

    rail.append(head, filterWrap, this.railList, foot);
    return rail;
  }

  private async loadLibrary(): Promise<void> {
    const load = ++this.libraryLoads;
    let result: Awaited<ReturnType<typeof listSuperPlanLibrary>>;
    try {
      result = await listSuperPlanLibrary();
    } catch (err) {
      result = { entries: [], error: err instanceof Error ? err.message : 'Could not list plans' };
    }
    if (this.destroyed || load !== this.libraryLoads) return;
    this.libraryEntries = result.entries;
    this.libraryError = result.error;
    this.knownRunPaths = runPathSignature(result.entries);
    this.paintRail(true);
  }

  private railTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Summaries arrive on every poll and stream push. Rows are re-derived from
   * the chats (cheap); the file listing is only re-read when a run wrote a
   * file the rail has not seen.
   */
  private scheduleRailRefresh(): void {
    if (this.railTimer || this.destroyed) return;
    this.railTimer = setTimeout(() => {
      this.railTimer = null;
      void this.refreshRuns();
    }, 150);
  }

  private async refreshRuns(): Promise<void> {
    if (this.destroyed) return;
    const runs = collectSuperPlanRuns();
    const paths = runPathSignature(runs);
    if (paths !== this.knownRunPaths) {
      await this.loadLibrary();
      return;
    }
    const byChat = new Map(runs.map((run) => [run.chatId, run]));
    const merged: PlanLibraryEntry[] = [];
    const seen = new Set<string>();
    for (const entry of this.libraryEntries) {
      if (!entry.chatId) {
        merged.push(entry);
        continue;
      }
      const run = byChat.get(entry.chatId);
      if (!run) continue;
      seen.add(entry.chatId);
      merged.push({ ...run, atMs: run.atMs ?? entry.atMs });
    }
    for (const run of runs) if (run.chatId && !seen.has(run.chatId)) merged.push(run);
    this.libraryEntries = sortEntries(merged);
    this.paintRail(false);
  }

  private paintRail(force: boolean): void {
    const filtered = this.filterText
      ? this.libraryEntries.filter(
          (entry) => entry.title.toLowerCase().includes(this.filterText) || entry.path.toLowerCase().includes(this.filterText),
        )
      : this.libraryEntries;
    const view = this.current;
    const signature = JSON.stringify([
      view,
      this.filterText,
      this.libraryError ?? '',
      filtered.map((e) => [e.key, e.title, e.state, e.stageLabel ?? '', e.path, formatRelativeTime(e.atMs)]),
    ]);
    if (!force && signature === this.railSignature) return;
    this.railSignature = signature;
    const focusedKey = (document.activeElement as HTMLElement | null)?.closest?.('.sp-row')?.getAttribute('data-key');

    const nodes: HTMLElement[] = [];
    if (!filtered.length) {
      nodes.push(el('p', 'sp-rail__empty', this.emptyCopy()));
    } else {
      for (const group of groupPlanLibraryEntries(filtered)) {
        if (group.label) nodes.push(el('span', 'sp-group__label', group.label));
        for (const entry of group.entries) nodes.push(this.buildRailRow(entry, view));
      }
      if (this.libraryError === 'server_off') {
        nodes.push(el('p', 'sp-rail__empty', 'Saved plan files are hidden while the local server is off.'));
      }
    }
    this.railList.replaceChildren(...nodes);
    if (focusedKey) {
      for (const row of this.railList.querySelectorAll<HTMLElement>('.sp-row')) {
        if (row.dataset.key === focusedKey) row.focus();
      }
    }
  }

  private emptyCopy(): string {
    if (this.filterText) return 'No plans match that filter.';
    if (this.libraryError === 'server_off') return 'Start the local server to list saved plans.';
    if (this.libraryError && this.libraryError !== 'no_plans_dir') return `Could not list plans: ${this.libraryError}`;
    return 'No plans yet. The first one lands in documentation/plans/.';
  }

  private buildRailRow(entry: PlanLibraryEntry, view: SuperPlanPageView | null): HTMLElement {
    const wrap = el('div', 'sp-row-wrap');
    wrap.setAttribute('role', 'listitem');
    const row = el('button', 'sp-row');
    row.type = 'button';
    row.dataset.key = entry.key;
    const selected =
      view?.mode === 'doc'
        ? Boolean(entry.path) && entry.path === view.path && !entry.chatId
        : view?.mode === 'run' && Boolean(entry.chatId) && entry.chatId === view.chatId;
    if (selected) {
      row.classList.add('is-active');
      row.setAttribute('aria-current', 'true');
    }

    const title = el('span', 'sp-row__title', entry.title);
    const meta = el('span', 'sp-row__meta');
    const word = planLibraryStateLabel(entry.state);
    if (word) meta.append(el('span', `sp-state is-${entry.state}`, word));
    const bits: string[] = [];
    if (entry.stageLabel && entry.state !== 'saved' && entry.state !== 'done' && entry.state !== 'cancelled') {
      bits.push(entry.stageLabel);
    }
    const rel = formatRelativeTime(entry.atMs);
    if (rel) bits.push(rel);
    if (bits.length) meta.append(document.createTextNode(bits.join(' · ')));
    row.append(title, meta);
    row.title = entry.path || entry.title;

    row.addEventListener('click', () => {
      this.collapseRailIfOverlaying();
      if (entry.chatId) this.handlers.selectRun(entry.chatId);
      else if (entry.path) this.handlers.openPlanFile(entry.path);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.showRowMenu(event.clientX, event.clientY, entry);
    });
    wrap.append(row);
    return wrap;
  }

  private onRailKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const rows = [...this.railList.querySelectorAll<HTMLElement>('.sp-row')];
    if (!rows.length) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    let next = index;
    if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else next = rows.length - 1;
    event.preventDefault();
    rows[next]?.focus();
  }

  private showRowMenu(x: number, y: number, entry: PlanLibraryEntry): void {
    document.getElementById('superPlanRowContextMenu')?.remove();
    const menu = el('div', 'chat-group-context-menu');
    menu.id = 'superPlanRowContextMenu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const close = (): void => {
      menu.remove();
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
    };
    const onOutside = (event: PointerEvent): void => {
      if (!menu.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    const item = (label: string, run: () => void, danger = false): void => {
      const node = el('button', danger ? 'chat-context-menu__item--danger' : undefined, label);
      node.type = 'button';
      node.setAttribute('role', 'menuitem');
      node.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
        run();
      });
      menu.append(node);
    };
    if (entry.path) {
      item('Open in editor', () => this.handlers.openFile(entry.path));
      item('Copy path', () => void navigator.clipboard?.writeText(entry.path).catch(() => undefined));
    }
    item('Delete…', () => this.handlers.deleteEntry(entry), true);
    document.body.append(menu);
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey);
    }, 0);
    (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  private mountRun(chatId: string, runId: string): void {
    this.runPane = new RunPane(chatId, runId, {
      toggleRail: () => this.toggleRail(),
      openFile: (path) => this.handlers.openFile(path),
      orchestrate: (path) => this.handlers.orchestrate(path),
      build: (path) => this.handlers.build(path),
      deleteRun: (id) => {
        const entry = this.libraryEntries.find((e) => e.chatId === id);
        if (entry) this.handlers.deleteEntry(entry);
      },
    });
    this.mainEl.replaceChildren(this.runPane.root);
  }

  // ── Saved plan file ────────────────────────────────────────────────────────

  private buildDocPane(path: string): HTMLElement {
    const pane = el('div', 'sp-pane sp-pane--run');
    const body = el('div', 'sp-runbody');
    const head = el('header', 'sp-runhead sp-runhead--doc');
    const top = el('div', 'sp-runhead__top');
    const titleWrap = el('div', 'sp-runhead__ask');
    titleWrap.append(el('h1', 'sp-runhead__title', titleFromPlanPath(path)));
    const actions = el('div', 'sp-runhead__actions');
    const rail = el('button', 'sp-action sp-action--rail', 'Plans');
    rail.type = 'button';
    rail.addEventListener('click', () => this.toggleRail());
    const open = el('button', 'sp-action');
    open.type = 'button';
    open.append(svg(ICON.arrowUpRight, 12), document.createTextNode('Open in editor'));
    open.addEventListener('click', () => this.handlers.openFile(path));
    actions.append(rail, open);
    top.append(titleWrap, actions);
    const meta = el('div', 'sp-runhead__meta');
    const entry = this.libraryEntries.find((e) => e.path === path);
    const bits = [path];
    const rel = formatRelativeTime(entry?.atMs);
    if (rel) bits.push(`saved ${rel}`);
    meta.append(el('span', 'sp-runhead__stats', bits.join(' · ')));
    head.append(top, meta);

    const inner = el('div', 'sp-body');
    const doc = el('div', 'sp-doc');
    doc.append(el('p', 'sp-empty', 'Loading…'));
    inner.append(doc);
    body.append(head, inner);

    const dock = el('div', 'sp-dock');
    const copy = el('p', 'sp-dock__copy', 'A saved plan. Keep working on it in a chat, or hand it to a board.');
    const dockActions = el('div', 'sp-dock__actions');
    const executable = entry?.executable !== false;
    dockActions.append(
      button('Revise in a chat', () => this.handlers.revisePlanFile(path), { variant: 'quiet' }),
      button('Build in a chat', () => this.handlers.build(path)),
      button('Start Orchestrator', () => this.handlers.orchestrate(path), {
        variant: 'primary',
        disabled: !executable,
        title: executable ? 'Open a board that runs these tasks' : 'This plan has no task front matter for a board to run',
      }),
    );
    dock.append(copy, dockActions);
    pane.append(body, dock);

    let alive = true;
    this.paneCleanup.push(() => {
      alive = false;
    });
    void readPlanArtifactMarkdown(path, { cacheBust: Date.now() })
      .then((markdown) => {
        if (!alive) return;
        mountPlanPreviewContent(doc, markdown ?? '', { modeId: 'super-plan', emptyLabel: 'This plan file is empty or could not be read.' });
      })
      .catch(() => {
        if (alive) doc.replaceChildren(el('p', 'sp-empty', 'This plan file could not be read.'));
      });
    return pane;
  }

  // ── Composer ───────────────────────────────────────────────────────────────

  private buildComposer(chatId: string): HTMLElement {
    const pane = el('div', 'sp-pane sp-pane--ask');
    const ask = el('div', 'sp-ask');
    const title = el('h1', 'sp-ask__title', 'New plan');
    const sub = el(
      'p',
      'sp-ask__sub',
      'Describe the change. Super Plan asks what the code cannot tell it, has you confirm a spec, then researches, drafts and reviews the plan before you accept it.',
    );

    const composer = el('div', 'sp-composer');
    const field = el('textarea', 'sp-composer__field');
    field.id = SUPER_PLAN_PROMPT_FIELD_ID;
    field.rows = 4;
    field.spellcheck = false;
    field.setAttribute('autocomplete', 'off');
    field.setAttribute('autocorrect', 'off');
    field.setAttribute('autocapitalize', 'off');
    field.placeholder = 'What should this plan cover? Goals, constraints, and how you want the work grouped.';
    field.setAttribute('aria-label', 'What should this plan cover?');
    field.value = composerDrafts.get(chatId) ?? '';

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
    send.title = 'Start planning (Ctrl+Enter)';
    send.append(svg(ICON.send, 16));

    const status = el('p', 'sp-ask__status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    const error = el('p', 'sp-ask__error');
    error.setAttribute('role', 'alert');
    error.hidden = true;

    let starting = false;
    const syncSend = (): void => {
      send.disabled = starting || !field.value.trim();
    };
    const submit = (): void => {
      const text = field.value.trim();
      if (!text) {
        field.focus();
        return;
      }
      if (starting) return;
      starting = true;
      syncSend();
      field.readOnly = true;
      send.setAttribute('aria-busy', 'true');
      error.hidden = true;
      status.hidden = false;
      status.textContent = 'Starting the plan…';
      void this.handlers
        .start(chatId, text)
        .then(() => {
          composerDrafts.delete(chatId);
        })
        .catch((err) => {
          error.textContent = err instanceof Error ? err.message : String(err);
          error.hidden = false;
        })
        .finally(() => {
          starting = false;
          if (!field.isConnected) return;
          field.readOnly = false;
          send.removeAttribute('aria-busy');
          status.hidden = true;
          syncSend();
        });
    };
    send.addEventListener('click', submit);
    field.addEventListener('input', () => {
      composerDrafts.set(chatId, field.value);
      syncSend();
    });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });
    syncSend();
    this.paneCleanup.push(bindComposerAutoResize(field));

    bar.append(opts, spacer, modelAnchor, expand, send);
    composer.append(field, bar);

    const seeds = el('div', 'sp-seeds');
    seeds.append(el('span', 'sp-seeds__label', 'Try'));
    for (const seed of SEED_PROMPTS) {
      const btn = el('button', 'sp-seed', seed);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        field.value = seed;
        const WinEvent = field.ownerDocument.defaultView?.Event;
        if (WinEvent) field.dispatchEvent(new WinEvent('input', { bubbles: true }));
        field.focus();
      });
      seeds.append(btn);
    }

    ask.append(title, sub, composer, status, error, seeds);
    pane.append(ask);

    // Both accept a detached tree: the trigger mounts into its anchor, and the
    // expander finds the field and its button by id under `pane`.
    mountComposerModelTrigger(modelAnchor, 'super-plan');
    initComposerExpand(pane);
    this.paneCleanup.push(() => {
      cancelComposerExpandFor(SUPER_PLAN_PROMPT_FIELD_ID);
      unmountSuperPlanComposerModelTrigger();
    });
    return pane;
  }

  /**
   * Chips edit the saved Super Plan settings. A run snapshots them when it
   * starts, so a change applies to the run about to start and becomes the
   * default for the next one; runs already going keep their own.
   */
  private buildOptionChips(): HTMLElement {
    const wrap = el('div', 'sp-opts');
    const config = getSuperPlanConfigSync();
    /** Re-read the controls from the saved settings once they load. */
    const refreshers: Array<(cfg: SuperPlanConfig) => void> = [];

    const closeAll = (except?: HTMLElement): void => {
      for (const pop of wrap.querySelectorAll<HTMLElement>('.sp-pop')) {
        if (pop === except) continue;
        pop.hidden = true;
        (pop.previousElementSibling as HTMLButtonElement | null)?.setAttribute('aria-expanded', 'false');
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
      chip.append(text, el('span', 'sp-chip__caret', '▾'));
      const pop = el('div', 'sp-pop');
      pop.hidden = true;
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', `${id} options`);
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
        if (willOpen) pop.querySelector<HTMLElement>('input, select')?.focus();
      });
      pop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          pop.hidden = true;
          chip.setAttribute('aria-expanded', 'false');
          chip.focus();
        }
      });
      opt.append(chip, pop);
      wrap.append(opt);
    };

    const patch = (next: Partial<SuperPlanConfig>): void => {
      void saveSuperPlanConfig(next).catch(() => undefined);
    };

    const field = (pop: HTMLElement, labelText: string, control: HTMLElement, hint?: string): void => {
      const f = el('label', 'sp-field');
      f.append(el('span', 'sp-field__label', labelText), control);
      if (hint) f.append(el('span', 'sp-field__hint', hint));
      pop.append(f);
    };

    const select = (options: Array<{ value: string; label: string }>, value: string, onChange: (value: string) => void): HTMLSelectElement => {
      const node = document.createElement('select');
      for (const option of options) {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = option.label;
        node.append(opt);
      }
      node.value = value;
      node.addEventListener('change', () => onChange(node.value));
      return node;
    };

    const selectWrap = (node: HTMLSelectElement): HTMLElement => {
      const w = el('div', 'sp-select');
      w.append(node);
      return w;
    };

    const toggle = (pop: HTMLElement, labelText: string, checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement => {
      const row = el('label', 'sp-field__check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      row.append(input, document.createTextNode(labelText));
      pop.append(row);
      return input;
    };

    let interviewOn!: HTMLInputElement;
    let budget!: HTMLInputElement;
    makeChip(
      'interview',
      () => (interviewOn.checked ? `Interview · up to ${budget.value}` : 'Interview off'),
      () => Number(budget.value) !== 20,
      () => !interviewOn.checked,
      (pop, sync) => {
        interviewOn = toggle(pop, 'Interview me before the spec', config.grillEnabled, (checked) => {
          patch({ grillEnabled: checked });
          sync();
        });
        budget = el('input', 'sp-input');
        budget.type = 'number';
        budget.min = '5';
        budget.max = '40';
        budget.value = String(config.grillQuestionBudget);
        const commit = (): void => {
          const n = Math.min(40, Math.max(5, Math.round(Number(budget.value) || 20)));
          patch({ grillQuestionBudget: n });
          sync();
        };
        budget.addEventListener('change', commit);
        budget.addEventListener('input', sync);
        field(pop, 'Most questions', budget, 'It only asks what the repository cannot answer, and stops early when it has enough.');
        refreshers.push((cfg) => {
          interviewOn.checked = cfg.grillEnabled;
          budget.value = String(cfg.grillQuestionBudget);
          sync();
        });
      },
    );

    let researchOn!: HTMLInputElement;
    let scope!: HTMLSelectElement;
    let depth!: HTMLSelectElement;
    makeChip(
      'research',
      () =>
        researchOn.checked
          ? `Research · ${RESEARCH_SCOPE_LABEL[scope.value as ResearchScope]} · ${RESEARCH_DEPTH_LABEL[depth.value as SuperPlanResearchDepth]}`
          : 'Research off',
      () => scope.value !== 'both' || depth.value !== 'auto',
      () => !researchOn.checked,
      (pop, sync) => {
        researchOn = toggle(pop, 'Research before drafting', config.researchEnabled, (checked) => {
          patch({ researchEnabled: checked });
          sync();
        });
        scope = select(
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
        field(pop, 'Scope', selectWrap(scope));
        depth = select(
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
        field(pop, 'Depth', selectWrap(depth));
        refreshers.push((cfg) => {
          researchOn.checked = cfg.researchEnabled;
          scope.value = cfg.researchScope;
          depth.value = cfg.researchDepth;
          sync();
        });
      },
    );

    let reviews!: HTMLSelectElement;
    makeChip(
      'review',
      () => {
        const n = Number(reviews.value);
        return n === 0 ? 'No review' : `Review · ${n} round${n === 1 ? '' : 's'}`;
      },
      () => Number(reviews.value) !== 2,
      () => Number(reviews.value) === 0,
      (pop, sync) => {
        reviews = select(
          [
            { value: '0', label: 'None' },
            { value: '1', label: '1 round' },
            { value: '2', label: '2 rounds' },
            { value: '3', label: '3 rounds' },
            { value: '4', label: '4 rounds' },
          ],
          String(config.reviewRounds),
          (value) => {
            patch({ reviewRounds: Number(value) });
            sync();
          },
        );
        field(
          pop,
          'Review rounds',
          selectWrap(reviews),
          'A separate reviewer reads each draft and the planner revises. Stops early when nothing blocking is left.',
        );
        refreshers.push((cfg) => {
          reviews.value = String(cfg.reviewRounds);
          sync();
        });
      },
    );

    let polish!: HTMLSelectElement;
    makeChip(
      'polish',
      () => (polish.value === 'never' ? 'Polish off' : `Polish · ${polish.value === 'auto' ? 'when UI' : 'always'}`),
      () => polish.value !== 'auto',
      () => polish.value === 'never',
      (pop, sync) => {
        polish = select(
          [
            { value: 'auto', label: 'When the plan has UI work' },
            { value: 'always', label: 'Always' },
            { value: 'never', label: 'Never' },
          ],
          config.impeccable,
          (value) => {
            patch({ impeccable: value as SuperPlanImpeccableMode });
            sync();
          },
        );
        field(pop, 'Interface polish pass', selectWrap(polish), 'Adds design detail to the tasks that touch the interface.');
        refreshers.push((cfg) => {
          polish.value = cfg.impeccable;
          sync();
        });
      },
    );

    const note = el('p', 'sp-opts__note', 'Applies to this plan and becomes the default for new ones.');
    note.hidden = true;
    wrap.append(note);
    wrap.addEventListener('focusin', () => {
      note.hidden = false;
    });

    void loadSuperPlanConfig()
      .then((cfg) => {
        if (!wrap.isConnected || this.destroyed) return;
        // A popover the user is editing keeps what they typed.
        if (wrap.querySelector('.sp-pop:not([hidden])')) return;
        for (const refresh of refreshers) refresh(cfg);
      })
      .catch(() => undefined);

    const onDocClick = (event: MouseEvent): void => {
      if (!wrap.isConnected || wrap.contains(event.target as Node)) return;
      closeAll();
    };
    document.addEventListener('click', onDocClick);
    this.paneCleanup.push(() => document.removeEventListener('click', onDocClick));
    return wrap;
  }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function runPathSignature(entries: PlanLibraryEntry[]): string {
  return entries
    .filter((entry) => entry.chatId)
    .map((entry) => `${entry.chatId}:${entry.path}`)
    .sort()
    .join('|');
}

function sortEntries(entries: PlanLibraryEntry[]): PlanLibraryEntry[] {
  const rank = (entry: PlanLibraryEntry): number =>
    entry.state === 'waiting' || entry.state === 'halted' ? 0 : entry.state === 'running' || entry.state === 'paused' ? 1 : 2;
  return [...entries].sort(
    (a, b) => rank(a) - rank(b) || (b.atMs ?? 0) - (a.atMs ?? 0) || a.title.localeCompare(b.title),
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Mount the surface into `host` (replacing its children), or reuse the mounted one. */
export function mountSuperPlanPage(host: HTMLElement, handlers: SuperPlanPageHandlers): SuperPlanPage {
  if (page && page.root.isConnected && page.root.parentElement === host) return page;
  page?.destroy();
  page = new SuperPlanPage(handlers);
  host.replaceChildren(page.root);
  return page;
}

/** What the mounted surface shows, if it is on screen. */
export function getSuperPlanPageView(): SuperPlanPageView | null {
  return page && page.root.isConnected ? page.view : null;
}

/** Point the mounted surface at a composer, run or plan file. */
export function showSuperPlanPageView(view: SuperPlanPageView): void {
  if (page && page.root.isConnected) page.show(view);
}

/** Re-list the plan library (after a workspace switch or a file change). */
export function refreshSuperPlanLibrary(): void {
  if (page && page.root.isConnected) page.refreshLibrary();
}

export function teardownSuperPlanPage(): void {
  page?.destroy();
  page = null;
}

/** True when the Super Plan surface owns #chatArea right now. */
export function isSuperPlanPageMounted(): boolean {
  return Boolean(page?.root.isConnected);
}

/** Tests: forget composer drafts. */
export function resetSuperPlanPageForTests(): void {
  teardownSuperPlanPage();
  composerDrafts.clear();
}
