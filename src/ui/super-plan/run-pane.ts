/**
 * One Super Plan run: header, the card that asks for input, tabs for the
 * story and the documents, and the pipeline beside them. Everything paints
 * from the server's view; the pane never decides what the pipeline does next.
 *
 * Views arrive many times a second while a stage streams, so every region
 * repaints only when its own slice of the view changed. Controls are built
 * once and toggled, which keeps focus and hover where the user left them.
 */

import {
  answerSuperPlanCheckpoint,
  answerSuperPlanQuestions,
  cancelSuperPlan,
  pauseSuperPlan,
  renameSuperPlan,
  resumeSuperPlan,
  reworkSuperPlanStage,
  skipSuperPlanStage,
  stopSuperPlanQuestions,
} from '../../chat/super-plan/client';
import { getSuperPlanRunView, refreshSuperPlanRun, subscribeSuperPlanViews, watchSuperPlanRun } from '../../chat/super-plan/store';
import type { SuperPlanLiveFrame, SuperPlanRunView, SuperPlanStageId, SuperPlanStep } from '../../chat/super-plan/types';
import { mountPlanPreviewContent, readPlanArtifactMarkdown } from '../../chat/plans/plan-preview';
import { findChatById } from '../../state/sessions';
import type { Chat } from '../../types';
import { appConfirm, appPrompt } from '../app-dialog';
import { ActivityFeed } from './activity';
import { CheckpointCard, type CheckpointHandlers } from './checkpoint';
import { baseName, button, el, formatClock, ICON, reportActionError, svg } from './dom';
import { renderReview, reviewKey } from './review';

export type RunTab = 'activity' | 'spec' | 'research' | 'plan' | 'review';

export interface RunPaneHandlers {
  toggleRail: () => void;
  openFile: (path: string) => void;
  orchestrate: (path: string) => void;
  build: (path: string) => void;
  deleteRun: (chatId: string) => void;
}

const STATUS_WORD: Record<string, string> = {
  created: 'starting',
  running: 'running',
  waiting: 'needs you',
  paused: 'paused',
  halted: 'needs you',
  done: 'accepted',
  cancelled: 'cancelled',
  failed: 'stopped',
  legacy: 'older version',
};

const STATUS_CLASS: Record<string, string> = {
  created: 'is-running',
  running: 'is-running',
  waiting: 'is-waiting',
  paused: 'is-paused',
  halted: 'is-halted',
  done: 'is-done',
  cancelled: 'is-cancelled',
  failed: 'is-error',
  legacy: 'is-cancelled',
};

const REWORK_COPY: Record<SuperPlanStageId, { label: string; confirm: string }> = {
  interview: { label: 'Redo interview', confirm: 'Redo the interview? You revise the spec with it, then research and the plan follow the new spec.' },
  research: { label: 'Redo research', confirm: 'Run research again? The plan is redrafted with the new report.' },
  draft: { label: 'Redraft plan', confirm: 'Redraft the plan from the spec? The new draft goes through review again.' },
  review: { label: 'Review again', confirm: 'Run another review round on the current plan?' },
  polish: { label: 'Polish again', confirm: 'Run the interface polish pass again?' },
};

const STEP_TAB: Partial<Record<string, RunTab>> = {
  interview: 'activity',
  spec: 'spec',
  research: 'research',
  draft: 'plan',
  review: 'review',
  polish: 'plan',
  accept: 'plan',
};

const TAB_ORDER: RunTab[] = ['activity', 'spec', 'research', 'plan', 'review'];

interface DocSlot {
  body: HTMLElement;
  bar: HTMLElement;
  signature: string;
  fetchId: number;
}

export class RunPane {
  readonly root: HTMLElement;
  private view: SuperPlanRunView | null = null;
  private tab: RunTab = 'activity';
  private manualTab: RunTab | null = null;
  private manualFor = '';
  private readonly unsubscribes: Array<() => void> = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private readonly sigs = { steps: '', files: '', settings: '', review: '', tabs: '' };

  private readonly title = el('h1', 'sp-runhead__title');
  private readonly stateEl = el('span', 'sp-state');
  private readonly activityEl = el('span', 'sp-runhead__activity');
  private readonly statsEl = el('span', 'sp-runhead__stats');
  private readonly pauseBtn: HTMLButtonElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly moreBtn: HTMLButtonElement;
  private readonly tabs = new Map<RunTab, HTMLButtonElement>();
  private readonly reviewCount = el('span', 'sp-segment__count');
  private readonly panels = new Map<RunTab, HTMLElement>();
  private readonly checkHost = el('div');
  private readonly check: CheckpointCard;
  private readonly feed: ActivityFeed;
  private readonly docs = new Map<'spec' | 'research' | 'plan', DocSlot>();
  private readonly reviewPanel = el('div', 'sp-review');
  private readonly stepsEl = el('ol', 'sp-steps');
  private readonly filesEl = el('div', 'sp-artifact-list');
  private readonly settingsEl = el('dl', 'sp-snapshot');
  private moreMenu: HTMLElement | null = null;
  private closeMoreListeners: (() => void) | null = null;

  constructor(
    private readonly chatId: string,
    private readonly runId: string,
    private readonly handlers: RunPaneHandlers,
  ) {
    this.pauseBtn = this.action('Pause', () => this.withChat((chat) => pauseSuperPlan(chat)), ICON.pause);
    this.resumeBtn = this.action('Resume', () => this.withChat((chat) => resumeSuperPlan(chat)), ICON.play);
    this.cancelBtn = this.action('Cancel', () => this.confirmCancel(), undefined, 'danger');
    this.moreBtn = el('button', 'sp-action sp-action--icon');
    this.moreBtn.type = 'button';
    this.moreBtn.setAttribute('aria-label', 'More actions');
    this.moreBtn.setAttribute('aria-haspopup', 'menu');
    this.moreBtn.setAttribute('aria-expanded', 'false');
    this.moreBtn.append(svg(ICON.more));
    this.moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMore();
    });

    this.root = el('div', 'sp-pane sp-pane--run');
    const body = el('div', 'sp-runbody');
    const head = this.buildHead();
    const inner = el('div', 'sp-body');
    const cols = el('div', 'sp-cols');
    const main = el('div', 'sp-cols__main');
    main.append(this.checkHost);

    const activityPanel = this.panel('activity');
    main.append(activityPanel);
    for (const kind of ['spec', 'research', 'plan'] as const) {
      const panel = this.panel(kind);
      const bar = el('div', 'sp-docbar');
      const docBody = el('div', 'sp-doc');
      panel.append(bar, docBody);
      this.docs.set(kind, { body: docBody, bar, signature: '', fetchId: 0 });
      main.append(panel);
    }
    const reviewPanel = this.panel('review');
    reviewPanel.append(this.reviewPanel);
    main.append(reviewPanel);

    const aside = el('aside', 'sp-cols__aside');
    aside.setAttribute('aria-label', 'Pipeline');
    aside.append(el('h2', 'sp-sec', 'Pipeline'), this.stepsEl);
    const files = el('div', 'sp-artifacts');
    files.append(el('h2', 'sp-sec', 'Files'), this.filesEl);
    const settings = el('div', 'sp-artifacts');
    settings.append(el('h2', 'sp-sec', 'This run'), this.settingsEl);
    aside.append(files, settings);

    cols.append(main, aside);
    inner.append(cols);
    body.append(head, inner);
    this.root.append(body);
    this.observeHeadHeight(head, body);

    this.check = new CheckpointCard(this.checkHost, this.checkpointHandlers());
    this.feed = new ActivityFeed(activityPanel, runId);

    this.unsubscribes.push(
      watchSuperPlanRun(runId, (frame: SuperPlanLiveFrame) => this.feed.onLive(frame)),
      subscribeSuperPlanViews((view) => {
        if (view.runId === this.runId) this.apply(view);
      }),
    );
    const cached = getSuperPlanRunView(runId);
    if (cached) this.apply(cached);
    else void refreshSuperPlanRun(runId);
    this.ticker = setInterval(() => this.paintClocks(), 1000);
    (this.ticker as unknown as { unref?: () => void }).unref?.();
  }

  destroy(): void {
    this.destroyed = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    if (this.ticker) clearInterval(this.ticker);
    this.feed.destroy();
    this.closeMore();
    this.root.remove();
  }

  showTab(tab: RunTab): void {
    this.manualTab = tab;
    this.manualFor = this.view?.attentionKey ?? '';
    this.setTab(tab);
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private panel(id: RunTab): HTMLElement {
    const panel = el('div', 'sp-panel');
    panel.id = `sp-panel-${this.runId}-${id}`;
    panel.setAttribute('role', 'tabpanel');
    this.panels.set(id, panel);
    return panel;
  }

  private buildHead(): HTMLElement {
    const head = el('header', 'sp-runhead');
    const top = el('div', 'sp-runhead__top');
    const titleWrap = el('div', 'sp-runhead__ask');
    titleWrap.append(this.title);
    const actions = el('div', 'sp-runhead__actions');
    const rail = el('button', 'sp-action sp-action--rail', 'Plans');
    rail.type = 'button';
    rail.addEventListener('click', () => this.handlers.toggleRail());
    actions.append(rail, this.pauseBtn, this.resumeBtn, this.cancelBtn, this.moreBtn);
    top.append(titleWrap, actions);

    const meta = el('div', 'sp-runhead__meta');
    this.activityEl.setAttribute('aria-live', 'polite');
    meta.append(this.stateEl, this.activityEl, this.statsEl);

    const segments = el('div', 'sp-segments');
    segments.setAttribute('role', 'tablist');
    segments.setAttribute('aria-label', 'Run views');
    for (const id of TAB_ORDER) {
      const label = { activity: 'Activity', spec: 'Spec', research: 'Research', plan: 'Plan', review: 'Review' }[id];
      const tab = el('button', 'sp-segment');
      tab.type = 'button';
      tab.id = `sp-tab-${this.runId}-${id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `sp-panel-${this.runId}-${id}`);
      tab.dataset.tab = id;
      tab.append(document.createTextNode(label));
      if (id === 'review') tab.append(this.reviewCount);
      tab.addEventListener('click', () => this.showTab(id));
      this.tabs.set(id, tab);
      segments.append(tab);
    }
    segments.addEventListener('keydown', (event) => this.onTabKey(event));
    head.append(top, meta, segments);
    return head;
  }

  private onTabKey(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const visible = TAB_ORDER.filter((id) => !this.tabs.get(id)?.hidden);
    const index = visible.indexOf(this.tab);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % visible.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + visible.length) % visible.length;
    else if (event.key === 'Home') next = 0;
    else next = visible.length - 1;
    const id = visible[next];
    if (!id) return;
    event.preventDefault();
    this.showTab(id);
    this.tabs.get(id)?.focus();
  }

  private observeHeadHeight(head: HTMLElement, body: HTMLElement): void {
    if (typeof ResizeObserver !== 'function') return;
    const publish = (): void => {
      body.style.setProperty('--sp-runhead-h', `${Math.round(head.offsetHeight)}px`);
      body.style.setProperty('--sp-runbody-h', `${Math.round(body.clientHeight)}px`);
    };
    const observer = new ResizeObserver(() => publish());
    observer.observe(head);
    observer.observe(body);
    this.unsubscribes.push(() => observer.disconnect());
    publish();
  }

  private action(label: string, run: () => Promise<unknown>, icon?: string, variant?: 'danger'): HTMLButtonElement {
    const node = el('button', `sp-action${variant ? ` sp-action--${variant}` : ''}`);
    node.type = 'button';
    if (icon) node.append(svg(icon, 12));
    node.append(document.createTextNode(label));
    node.hidden = true;
    node.addEventListener('click', () => {
      if (node.disabled) return;
      node.disabled = true;
      void run()
        .catch((err) => reportActionError(err))
        .finally(() => {
          node.disabled = false;
        });
    });
    return node;
  }

  private async withChat(action: (chat: Chat) => Promise<unknown>): Promise<unknown> {
    const chat = findChatById(this.chatId);
    if (!chat) throw new Error('This plan is no longer in your chats.');
    return action(chat);
  }

  private checkpointHandlers(): CheckpointHandlers {
    return {
      answerQuestions: (questionId, answers) => this.withChat((chat) => answerSuperPlanQuestions(chat, questionId, answers)),
      stopQuestions: () => this.withChat((chat) => stopSuperPlanQuestions(chat)),
      confirmSpec: () => this.withChat((chat) => answerSuperPlanCheckpoint(chat, 'spec', 'confirm')),
      reviseSpec: (notes) => this.withChat((chat) => answerSuperPlanCheckpoint(chat, 'spec', 'revise', notes)),
      acceptPlan: () => this.withChat((chat) => answerSuperPlanCheckpoint(chat, 'accept', 'accept')),
      revisePlan: (notes) => this.withChat((chat) => answerSuperPlanCheckpoint(chat, 'accept', 'revise', notes)),
      reviewAgain: () => this.withChat((chat) => answerSuperPlanCheckpoint(chat, 'accept', 'review')),
      retry: () => this.withChat((chat) => resumeSuperPlan(chat)),
      resume: () => this.withChat((chat) => resumeSuperPlan(chat)),
      cancel: () => this.confirmCancel(),
      skip: (stage) => this.withChat((chat) => skipSuperPlanStage(chat, stage)),
      showTab: (tab) => this.showTab(tab),
      openFile: (path) => this.handlers.openFile(path),
      orchestrate: (path) => this.handlers.orchestrate(path),
      build: (path) => this.handlers.build(path),
    };
  }

  private async confirmCancel(): Promise<void> {
    const ok = await appConfirm('Cancel this plan? The files it wrote are kept, but the run cannot continue.', {
      title: 'Cancel plan',
      confirmLabel: 'Cancel plan',
      cancelLabel: 'Keep going',
      danger: true,
    });
    if (!ok) return;
    await this.withChat((chat) => cancelSuperPlan(chat));
  }

  // ── Apply ──────────────────────────────────────────────────────────────────

  private apply(view: SuperPlanRunView): void {
    if (this.destroyed) return;
    const first = !this.view;
    this.view = view;
    if (this.title.textContent !== view.title) this.title.textContent = view.title;
    this.title.title = view.prompt;
    const stateClass = `sp-state ${STATUS_CLASS[view.status] ?? 'is-running'}`;
    if (this.stateEl.className !== stateClass) this.stateEl.className = stateClass;
    const word = STATUS_WORD[view.status] ?? view.status;
    if (this.stateEl.textContent !== word) this.stateEl.textContent = word;
    if (this.activityEl.textContent !== view.activity) this.activityEl.textContent = view.activity;
    this.pauseBtn.hidden = !view.actions.pause;
    this.resumeBtn.hidden = !view.actions.resume;
    this.cancelBtn.hidden = !view.actions.cancel;
    this.check.update(view);
    this.paintTabs(view, first);
    this.feed.update(view);
    this.paintSteps(view);
    this.paintFiles(view);
    this.paintSettings(view);
    this.paintDocs(view);
    const reviewSig = reviewKey(view);
    if (reviewSig !== this.sigs.review) {
      this.sigs.review = reviewSig;
      renderReview(this.reviewPanel, view);
    }
    this.paintClocks();
  }

  // ── More menu ──────────────────────────────────────────────────────────────

  private toggleMore(): void {
    if (this.moreMenu) {
      this.closeMore();
      return;
    }
    const view = this.view;
    if (!view) return;
    const menu = el('div', 'chat-group-context-menu sp-menu');
    menu.setAttribute('role', 'menu');
    const item = (label: string, run: () => void, danger = false): void => {
      const node = el('button', danger ? 'chat-context-menu__item--danger' : undefined, label);
      node.type = 'button';
      node.setAttribute('role', 'menuitem');
      node.addEventListener('click', () => {
        this.closeMore();
        run();
      });
      menu.append(node);
    };
    item('Rename…', () => void this.rename());
    const plan = view.artifacts.plan?.path;
    if (plan) {
      item('Open plan in editor', () => this.handlers.openFile(plan));
      item('Copy plan path', () => void navigator.clipboard?.writeText(plan).catch(() => undefined));
    }
    for (const step of view.steps) {
      const copy = REWORK_COPY[step.id as SuperPlanStageId];
      if (step.reworkable && copy) item(`${copy.label}…`, () => void this.rework(step.id as SuperPlanStageId));
    }
    item('Delete plan…', () => this.handlers.deleteRun(this.chatId), true);

    const rect = this.moreBtn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.left = `${Math.max(8, Math.round(rect.right - 220))}px`;
    document.body.append(menu);
    this.moreMenu = menu;
    this.moreBtn.setAttribute('aria-expanded', 'true');

    const onPointer = (event: Event): void => {
      if (menu.contains(event.target as Node) || this.moreBtn.contains(event.target as Node)) return;
      this.closeMore();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        this.closeMore();
        this.moreBtn.focus();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', onPointer, true);
      document.addEventListener('keydown', onKey);
    }, 0);
    this.closeMoreListeners = () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
    (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  private closeMore(): void {
    this.closeMoreListeners?.();
    this.closeMoreListeners = null;
    this.moreMenu?.remove();
    this.moreMenu = null;
    this.moreBtn.setAttribute('aria-expanded', 'false');
  }

  private async rename(): Promise<void> {
    const next = await appPrompt('Name this plan', this.view?.title ?? '', { title: 'Rename plan', confirmLabel: 'Rename' });
    if (!next?.trim()) return;
    await this.withChat((chat) => renameSuperPlan(chat, next.trim())).catch((err) => reportActionError(err));
  }

  private async rework(stage: SuperPlanStageId): Promise<void> {
    const copy = REWORK_COPY[stage];
    const ok = await appConfirm(copy.confirm, { title: copy.label, confirmLabel: copy.label });
    if (!ok) return;
    await this.withChat((chat) => reworkSuperPlanStage(chat, stage)).catch((err) => reportActionError(err));
  }

  // ── Tabs and documents ─────────────────────────────────────────────────────

  private paintTabs(view: SuperPlanRunView, first: boolean): void {
    const available: Record<RunTab, boolean> = {
      activity: true,
      spec: Boolean(view.artifacts.spec),
      research: Boolean(view.artifacts.research) || view.steps.some((s) => s.id === 'research' && s.state === 'active'),
      plan: Boolean(view.artifacts.plan),
      review: view.reviews.length > 0 || view.steps.some((s) => s.id === 'review' && s.state === 'active'),
    };
    for (const [id, tab] of this.tabs) tab.hidden = !available[id];
    const open = view.openFindings.length;
    const count = open ? String(open) : '';
    if (this.reviewCount.textContent !== count) {
      this.reviewCount.textContent = count;
      this.tabs.get('review')?.setAttribute('aria-label', open ? `Review, ${open} open finding${open === 1 ? '' : 's'}` : 'Review');
    }
    if (this.manualTab && (this.manualFor !== view.attentionKey || !available[this.manualTab])) this.manualTab = null;
    let next: RunTab = this.manualTab ?? this.defaultTab(view);
    if (!available[next]) next = 'activity';
    if (next !== this.tab || first) this.setTab(next);
  }

  private defaultTab(view: SuperPlanRunView): RunTab {
    if (view.needsInput === 'spec') return 'spec';
    if (view.needsInput === 'accept' || view.status === 'done') return 'plan';
    return 'activity';
  }

  private setTab(tab: RunTab): void {
    this.tab = tab;
    for (const [id, node] of this.tabs) {
      const on = id === tab;
      node.classList.toggle('is-on', on);
      node.setAttribute('aria-selected', String(on));
      node.tabIndex = on ? 0 : -1;
    }
    for (const [id, panel] of this.panels) {
      panel.hidden = id !== tab;
      panel.setAttribute('aria-labelledby', `sp-tab-${this.runId}-${id}`);
    }
    if (this.view) this.paintDocs(this.view);
  }

  private paintDocs(view: SuperPlanRunView): void {
    if (this.tab !== 'spec' && this.tab !== 'research' && this.tab !== 'plan') return;
    const kind = this.tab;
    const slot = this.docs.get(kind)!;
    const artifact = view.artifacts[kind];
    if (!artifact) {
      if (slot.signature === 'none') return;
      slot.signature = 'none';
      slot.bar.replaceChildren();
      slot.body.replaceChildren(el('p', 'sp-empty', emptyDocCopy(kind, view)));
      return;
    }
    if (artifact.empty) {
      if (slot.signature === 'empty') return;
      slot.signature = 'empty';
      slot.bar.replaceChildren();
      slot.body.replaceChildren(
        el('p', 'sp-empty', 'Research found nothing useful for this plan, so no report was written. The plan drafts from the spec alone.'),
      );
      return;
    }
    const signature = `${artifact.path}#${artifact.sha256 ?? artifact.at ?? ''}`;
    if (signature === slot.signature) return;
    slot.signature = signature;
    slot.bar.replaceChildren(docBar(artifact.path, this.handlers));
    const fetchId = ++slot.fetchId;
    if (!slot.body.querySelector('.plan-preview__body')) slot.body.replaceChildren(el('p', 'sp-empty', 'Loading…'));
    void readPlanArtifactMarkdown(artifact.path, { cacheBust: Date.now() })
      .then((markdown) => {
        if (this.destroyed || fetchId !== slot.fetchId) return;
        mountPlanPreviewContent(slot.body, markdown ?? '', {
          modeId: 'super-plan',
          emptyLabel: 'This file is empty or could not be read.',
        });
      })
      .catch(() => {
        if (this.destroyed || fetchId !== slot.fetchId) return;
        slot.signature = '';
        slot.body.replaceChildren(el('p', 'sp-empty', 'This file could not be read. Start the local server, then open the tab again.'));
      });
  }

  // ── Aside ──────────────────────────────────────────────────────────────────

  private paintSteps(view: SuperPlanRunView): void {
    const sig = JSON.stringify([
      view.steps.map((s) => [s.id, s.state, s.detail, s.reworkable, s.skippable, s.startedAt ?? 0, s.endedAt ?? 0]),
      view.actions.skip,
    ]);
    if (sig === this.sigs.steps) return;
    this.sigs.steps = sig;
    const focused = (document.activeElement as HTMLElement | null)?.closest?.('.sp-step')?.getAttribute('data-step');
    this.stepsEl.replaceChildren(...view.steps.map((step) => this.stepRow(step, view)));
    if (focused) this.stepsEl.querySelector<HTMLElement>(`.sp-step[data-step="${focused}"] button`)?.focus();
  }

  private stepRow(step: SuperPlanStep, view: SuperPlanRunView): HTMLElement {
    const row = el('li', `sp-step is-${step.state}`);
    row.dataset.step = step.id;
    const target = STEP_TAB[step.id];
    const main = el('button', 'sp-step__main');
    main.type = 'button';
    main.disabled = step.state === 'off' || step.state === 'pending';
    main.title = main.disabled ? '' : `Show ${step.label.toLowerCase()}`;
    main.addEventListener('click', () => {
      if (target) this.showTab(target);
    });
    const mark = el('span', 'sp-step__mark');
    if (step.state === 'done' || step.state === 'earlier') mark.append(svg(ICON.check, 12));
    else if (step.state === 'failed') mark.textContent = '!';
    else if (step.state === 'skipped' || step.state === 'off') mark.textContent = '–';
    else mark.append(el('span', 'sp-step__dot'));
    const name = el('span', 'sp-step__name', step.label);
    const time = el('span', 'sp-step__time');
    time.dataset.step = step.id;
    time.textContent = stepTime(step);
    main.append(mark, name, time);
    const note = stepNote(step);
    if (note) main.append(el('span', 'sp-step__note', note));
    row.append(main);

    const stage = step.id as SuperPlanStageId;
    if (step.skippable && view.actions.skip === step.id && (step.state === 'active' || step.state === 'paused' || step.state === 'failed')) {
      const skip = el('button', 'sp-step__side', 'Skip');
      skip.type = 'button';
      skip.title = `Skip ${step.label.toLowerCase()} and continue`;
      skip.addEventListener('click', () => {
        skip.disabled = true;
        void this.withChat((chat) => skipSuperPlanStage(chat, stage))
          .catch((err) => reportActionError(err))
          .finally(() => {
            skip.disabled = false;
          });
      });
      row.append(skip);
    } else if (step.reworkable && REWORK_COPY[stage]) {
      const redo = el('button', 'sp-step__side', 'Redo');
      redo.type = 'button';
      redo.title = REWORK_COPY[stage].label;
      redo.setAttribute('aria-label', REWORK_COPY[stage].label);
      redo.addEventListener('click', () => void this.rework(stage));
      row.append(redo);
    }
    return row;
  }

  private paintFiles(view: SuperPlanRunView): void {
    const sig = JSON.stringify([view.artifacts.spec?.path, view.artifacts.research?.path, view.artifacts.research?.empty, view.artifacts.plan?.path]);
    if (sig === this.sigs.files) return;
    this.sigs.files = sig;
    const rows: HTMLElement[] = [];
    const add = (kind: 'spec' | 'research' | 'plan', label: string): void => {
      const artifact = view.artifacts[kind];
      if (!artifact || artifact.empty) return;
      const row = el('button', 'sp-artifact');
      row.type = 'button';
      row.title = `${artifact.path}\nShow in the ${label} tab`;
      row.append(el('span', 'sp-artifact__name', baseName(artifact.path)), el('span', 'sp-artifact__kind', label));
      row.addEventListener('click', () => this.showTab(kind));
      rows.push(row);
    };
    add('spec', 'Spec');
    add('research', 'Research');
    add('plan', 'Plan');
    if (!rows.length) rows.push(el('p', 'sp-empty', 'Files appear here as the pipeline writes them.'));
    this.filesEl.replaceChildren(...rows);
  }

  private paintSettings(view: SuperPlanRunView): void {
    const config = view.config;
    const sig = JSON.stringify(config);
    if (sig === this.sigs.settings) return;
    this.sigs.settings = sig;
    const entries: Array<[string, string]> = [
      ['Interview', config.interview && config.questionBudget > 0 ? `up to ${config.questionBudget} questions` : 'off'],
      ['Research', config.research ? `${scopeLabel(config.researchScope)}, ${config.researchDepth}` : 'off'],
      ['Review', config.reviewRounds ? `up to ${config.reviewRounds} round${config.reviewRounds === 1 ? '' : 's'}` : 'off'],
      ['Polish', { auto: 'when the plan has UI work', always: 'always', never: 'off' }[config.polish] ?? config.polish],
      ['Task size', config.granularity],
    ];
    if (config.plannerModel?.modelId) entries.push(['Planner', modelLabel(config.plannerModel.modelId)]);
    if (config.reviewerModel?.modelId) entries.push(['Reviewer', modelLabel(config.reviewerModel.modelId)]);
    const nodes: HTMLElement[] = [];
    for (const [term, value] of entries) nodes.push(el('dt', undefined, term), el('dd', undefined, value));
    this.settingsEl.replaceChildren(...nodes);
  }

  private paintClocks(): void {
    const view = this.view;
    if (!view) return;
    const now = Date.now();
    const live = view.status === 'running' || view.status === 'waiting' || view.status === 'created';
    const bits: string[] = [];
    if (view.createdAt) bits.push(`${formatClock(Math.max(0, (live ? now : view.updatedAt ?? now) - view.createdAt))} elapsed`);
    const tasks = view.artifacts.plan?.tasks;
    if (tasks) bits.push(`${tasks} task${tasks === 1 ? '' : 's'}`);
    const stats = bits.join(' · ');
    if (this.statsEl.textContent !== stats) this.statsEl.textContent = stats;
    if (view.status !== 'running') return;
    for (const step of view.steps) {
      if (step.state !== 'active' || !step.startedAt) continue;
      const node = this.stepsEl.querySelector<HTMLElement>(`.sp-step__time[data-step="${step.id}"]`);
      if (node) node.textContent = formatClock(now - step.startedAt);
    }
  }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function stepTime(step: SuperPlanStep): string {
  if (!step.startedAt) return '';
  if (step.state === 'active') return formatClock(Date.now() - step.startedAt);
  if (step.endedAt) return formatClock(step.endedAt - step.startedAt);
  return '';
}

function stepNote(step: SuperPlanStep): string {
  if (step.state === 'waiting') return step.id === 'interview' ? 'waiting for your answers' : 'waiting for you';
  if (step.state === 'paused') return 'paused';
  if (step.state === 'failed') return step.detail ? `${step.detail} · needs attention` : 'needs attention';
  if (step.state === 'off') return 'off for this run';
  if (step.state === 'earlier') return step.detail ? `${step.detail} · from an earlier pass` : 'from an earlier pass';
  return step.detail;
}

function scopeLabel(scope: string): string {
  return { web: 'web', codebase: 'codebase', both: 'web and codebase' }[scope] ?? scope;
}

function modelLabel(modelId: string): string {
  const tail = modelId.split(/[/:]/).filter(Boolean).pop() ?? modelId;
  return tail.replace(/\.gguf$/i, '');
}

function emptyDocCopy(kind: 'spec' | 'research' | 'plan', view: SuperPlanRunView): string {
  if (kind === 'spec') return 'The spec appears here once the interview writes it.';
  if (kind === 'research') return view.config.research ? 'The research report appears here when research finishes.' : 'Research is off for this plan.';
  return 'The plan appears here after the first draft.';
}

function docBar(path: string, handlers: Pick<RunPaneHandlers, 'openFile'>): HTMLElement {
  const bar = el('div', 'sp-docbar__row');
  bar.append(el('code', 'sp-docbar__path', path));
  const open = button('Open in editor', () => handlers.openFile(path), { variant: 'quiet', icon: ICON.arrowUpRight });
  const label = document.createTextNode('Copy path');
  const copy = button('', () => {
    void navigator.clipboard?.writeText(path).catch(() => undefined);
    label.textContent = 'Copied';
    setTimeout(() => {
      label.textContent = 'Copy path';
    }, 1400);
  }, { variant: 'quiet' });
  copy.replaceChildren(label);
  bar.append(open, copy);
  return bar;
}
