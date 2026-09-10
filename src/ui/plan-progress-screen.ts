import { findLastPlanSavePath } from '../chat/plans/plan-from-history';
import {
  SUPER_PLAN_STAGE_LABELS,
  SUPER_PLAN_DISPLAY_ORDER,
  type SuperPlanStageId,
  type SuperPlanState,
} from '../chat/super-plan/types';
import { ResearchProgressPanel } from '../research/progress-panel';
import { subscribeToResearchStream } from '../research/client';
import type { MainTurnPhase } from '../chat/main-turn-activity';
import type { Chat } from '../types';

type PlanActivityPhase = MainTurnPhase | null;

export const PLAN_PROGRESS_MOUNT_ID = 'orchestratePlanProgressMount';
export const PLAN_PROGRESS_RESEARCH_MOUNT_ID = 'orchestratePlanResearchFeedMount';

export const SUPER_PLAN_DISPLAY_STEPS = [
  { key: 'interview', label: 'Interviewing about scope', short: 'Interview' },
  { key: 'spec', label: 'Writing build spec', short: 'Spec' },
  { key: 'research', label: 'Researching sources', short: 'Research' },
  { key: 'draft', label: 'Drafting the plan', short: 'Draft' },
  { key: 'review', label: 'Reviewing the draft', short: 'Review' },
  { key: 'polish', label: 'Polishing UI details', short: 'Polish' },
  { key: 'final', label: 'Finalizing the plan', short: 'Final' },
] as const;

export const REGULAR_PLAN_DISPLAY_STEPS = [
  { key: 'explore', label: 'Exploring the workspace', short: 'Explore' },
  { key: 'draft', label: 'Drafting the plan', short: 'Draft' },
  { key: 'ready', label: 'Saving the plan', short: 'Ready' },
] as const;

export type SuperPlanDisplayStepIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type RegularPlanDisplayStepIndex = 0 | 1 | 2;

const SUPER_PLAN_STAGE_TO_STEP: Record<SuperPlanStageId, SuperPlanDisplayStepIndex> = {
  grill: 0,
  spec_confirm: 1,
  research: 2,
  draft1: 3,
  draft2: 3,
  review1: 4,
  review2: 4,
  impeccable: 5,
  finalize: 6,
  present: 6,
};

/** First pipeline stage represented by each display step (rework target). */
export const SUPER_PLAN_STEP_TO_STAGE: Record<SuperPlanDisplayStepIndex, SuperPlanStageId> = {
  0: 'grill',
  1: 'spec_confirm',
  2: 'research',
  3: 'draft1',
  4: 'review1',
  5: 'impeccable',
  6: 'finalize',
};

export type PlanPreviewActionId = 'revise' | 'orchestrate' | 'build';

export interface PlanPreviewActionHandlers {
  onRevise: () => void;
  onStartOrchestrator: () => void;
  onBuild: () => void;
}

export interface BuildPlanPreviewPopoutOptions {
  orchestrateEnabled?: boolean;
}

/** Map Super Plan controller stage to display stepper index. */
export function superPlanStageToDisplayStep(stageId: SuperPlanStageId): SuperPlanDisplayStepIndex {
  return SUPER_PLAN_STAGE_TO_STEP[stageId] ?? 0;
}

/** Active display step for a Super Plan controller snapshot. */
export function superPlanStateToDisplayStep(state: SuperPlanState): SuperPlanDisplayStepIndex {
  return superPlanStageToDisplayStep(state.activeStage);
}

/** Per-node state for the Super Plan stepper. */
export function superPlanStepNodeState(
  state: SuperPlanState,
  stepIndex: number,
): 'done' | 'active' | 'todo' {
  const activeIndex = superPlanStateToDisplayStep(state);
  if (stepIndex < activeIndex) return 'done';
  if (stepIndex > activeIndex) return 'todo';
  const record = state.stages[state.activeStage];
  if (record?.status === 'done') return 'done';
  return 'active';
}

/** Headline for the Super Plan stepper from controller state. */
export function superPlanProgressLabel(state: SuperPlanState): string {
  const stepIndex = superPlanStateToDisplayStep(state);
  const record = state.stages[state.activeStage];
  if (state.cancelled) {
    return 'Super Plan cancelled';
  }
  if (state.paused) {
    return 'Paused — press Resume to continue';
  }
  if (record?.status === 'error') {
    return record.error?.trim() || 'Super Plan stopped with an error';
  }
  if (record?.status === 'blocked_user') {
    if (state.activeStage === 'spec_confirm') {
      return 'Waiting for build spec confirmation';
    }
    if (state.activeStage === 'present') {
      return 'Plan ready for your review';
    }
  }
  return SUPER_PLAN_DISPLAY_STEPS[stepIndex]?.label ?? 'Planning in progress';
}

/** Verbose one-line status for the Super Plan working screen: pipeline position, exact stage, stage elapsed, and live turn activity. */
export function superPlanStageDetail(
  state: SuperPlanState,
  activity?: { phase?: PlanActivityPhase; currentTool?: string },
): string {
  const stageId = state.activeStage;
  const record = state.stages[stageId];
  const position = SUPER_PLAN_DISPLAY_ORDER.indexOf(stageId) + 1;
  const parts = [
    `Stage ${position} of ${SUPER_PLAN_DISPLAY_ORDER.length}: ${SUPER_PLAN_STAGE_LABELS[stageId]}`,
  ];
  if (record?.status === 'running' && record.startedAt) {
    parts.push(`running ${formatClock(Date.now() - record.startedAt)}`);
  } else if (record?.status) {
    parts.push(record.status === 'blocked_user' ? 'waiting for you' : record.status);
  }
  if (activity?.phase === 'tools' && activity.currentTool?.trim()) {
    parts.push(`tool: ${activity.currentTool.trim()}`);
  } else if (activity?.phase === 'loading_model') {
    parts.push('loading model…');
  } else if (activity?.phase === 'thinking') {
    parts.push('model thinking…');
  } else if (activity?.phase === 'generating') {
    parts.push('writing…');
  }
  return parts.join(' · ');
}

export interface RegularPlanWorkingStepInput {
  hasPlanSave?: boolean;
  activityPhase?: PlanActivityPhase;
  currentTool?: string;
}

/** Reduced stepper index for regular Plan mode during the working phase. */
export function regularPlanWorkingStepIndex(
  input: RegularPlanWorkingStepInput,
): RegularPlanDisplayStepIndex {
  if (input.hasPlanSave) return 2;
  if (input.activityPhase === 'generating' || input.activityPhase === 'loading_model') return 1;
  if (input.activityPhase === 'tools') {
    const tool = input.currentTool?.trim().toLowerCase() ?? '';
    if (tool === 'save_file' || tool === 'make_directory') return 1;
    return 1;
  }
  if (input.activityPhase === 'thinking') return 0;
  return 0;
}

/** Headline for the regular Plan working stepper. */
export function regularPlanProgressLabel(stepIndex: RegularPlanDisplayStepIndex): string {
  return REGULAR_PLAN_DISPLAY_STEPS[stepIndex]?.label ?? 'Planning in progress';
}

/** Derive regular-plan stepper inputs from chat history + main-turn activity. */
export function regularPlanWorkingStepFromChat(
  chat: Chat,
  activityPhase?: PlanActivityPhase,
  currentTool?: string,
): RegularPlanDisplayStepIndex {
  return regularPlanWorkingStepIndex({
    hasPlanSave: Boolean(findLastPlanSavePath(chat.history)),
    activityPhase,
    currentTool,
  });
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type PlanProgressVariant = 'super-plan' | 'regular-plan';

/** Animated plan progress panel (Deep Research stepper layout). */
export class PlanProgressPanel {
  private readonly mount: HTMLElement;
  private readonly variant: PlanProgressVariant;
  private readonly reducedMotion: boolean;
  private root: HTMLElement | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private timerStart = 0;
  /** Wall-clock pipeline start (persisted stage timestamps survive remounts). */
  private baselineEpochMs: number | null = null;
  private stepIndex = 0;
  private statusLabel = '';
  private detailText = '';
  private status: 'running' | 'paused' | 'done' | 'error' = 'running';
  private researchMount: HTMLElement | null = null;
  private researchPanel: ResearchProgressPanel | null = null;
  private researchUnsubscribe: (() => void) | null = null;
  private wiredResearchId: string | null = null;
  private readonly onStepClick?: (stepIndex: number) => void;

  constructor(
    mount: HTMLElement,
    options: {
      variant: PlanProgressVariant;
      reducedMotion?: boolean;
      /** Invoked when the user clicks a completed stepper node (rework a phase). */
      onStepClick?: (stepIndex: number) => void;
    } = {
      variant: 'regular-plan',
    },
  ) {
    this.mount = mount;
    this.variant = options.variant;
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion();
    this.onStepClick = options.onStepClick;
  }

  reset(): void {
    this.stopTimer();
    this.stopResearchStream();
    this.stepIndex = 0;
    this.statusLabel =
      this.variant === 'super-plan'
        ? SUPER_PLAN_DISPLAY_STEPS[0]!.label
        : REGULAR_PLAN_DISPLAY_STEPS[0]!.label;
    this.status = 'running';
    this.detailText = '';
    this.wiredResearchId = null;
    this.baselineEpochMs = null;
    this.timerStart = performance.now();
    this.root = document.createElement('div');
    this.root.className = 'dr-prog plan-progress';
    if (this.reducedMotion) {
      this.root.classList.add('plan-progress--reduced-motion');
    }
    if (this.onStepClick) {
      const onReworkStep = (event: Event, node: HTMLElement): void => {
        if (!this.root?.contains(node)) return;
        const index = Number(node.dataset.stepIndex);
        if (Number.isInteger(index)) this.onStepClick?.(index);
      };
      this.root.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        const node = target?.closest?.('[data-step-index]') as HTMLElement | null;
        if (!node) return;
        onReworkStep(event, node);
      });
      this.root.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const target = event.target as HTMLElement | null;
        const node = target?.closest?.('[data-step-index]') as HTMLElement | null;
        if (!node) return;
        event.preventDefault();
        onReworkStep(event, node);
      });
    }
    this.mount.replaceChildren(this.root);
    this.ensureResearchMount();
    this.startTimer();
    this.paint();
  }

  destroy(): void {
    this.stopTimer();
    this.stopResearchStream();
    this.researchPanel?.destroy();
    this.researchPanel = null;
    this.researchMount = null;
    this.wiredResearchId = null;
    this.mount.replaceChildren();
    this.root = null;
  }

  applySuperPlanState(
    state: SuperPlanState,
    activity?: { phase?: PlanActivityPhase; currentTool?: string },
  ): void {
    if (!this.root) return;
    this.stepIndex = superPlanStateToDisplayStep(state);
    this.statusLabel = superPlanProgressLabel(state);
    this.detailText = superPlanStageDetail(state, activity);
    const record = state.stages[state.activeStage];
    this.status = state.paused
      ? 'paused'
      : record?.status === 'error'
        ? 'error'
        : 'running';
    const startTimes = Object.values(state.stages)
      .map((r) => r?.startedAt ?? 0)
      .filter((t) => t > 0);
    this.baselineEpochMs = startTimes.length ? Math.min(...startTimes) : null;
    if (state.activeStage === 'research' && state.researchId?.trim()) {
      this.wireResearchStream(state.researchId.trim());
    } else if (this.wiredResearchId) {
      this.stopResearchStream();
      this.researchPanel?.destroy();
      this.researchPanel = null;
      this.wiredResearchId = null;
      if (this.researchMount) this.researchMount.replaceChildren();
    }
    this.paintSuperPlan(state);
  }

  applyRegularPlanStep(stepIndex: RegularPlanDisplayStepIndex, label?: string): void {
    if (!this.root) return;
    this.stepIndex = stepIndex;
    this.statusLabel = label?.trim() || regularPlanProgressLabel(stepIndex);
    this.status = stepIndex >= 2 ? 'done' : 'running';
    this.stopResearchStream();
    this.researchPanel?.destroy();
    this.researchPanel = null;
    this.wiredResearchId = null;
    if (this.researchMount) this.researchMount.replaceChildren();
    this.paintRegularPlan();
  }

  complete(status: 'done' | 'error', message?: string): void {
    this.status = status;
    if (message) this.statusLabel = message;
    if (status === 'done') {
      const steps =
        this.variant === 'super-plan'
          ? SUPER_PLAN_DISPLAY_STEPS.length
          : REGULAR_PLAN_DISPLAY_STEPS.length;
      this.stepIndex = Math.max(0, steps - 1);
    }
    this.stopTimer();
    this.stopResearchStream();
    if (this.variant === 'super-plan') {
      this.paintSuperPlan(null);
    } else {
      this.paintRegularPlan();
    }
  }

  private ensureResearchMount(): void {
    if (!this.root) return;
    let mount = this.root.querySelector(
      `[data-plan-research-feed]`,
    ) as HTMLElement | null;
    if (!mount) {
      mount = document.createElement('div');
      mount.className = 'plan-progress__research-feed';
      mount.dataset.planResearchFeed = 'true';
      mount.id = PLAN_PROGRESS_RESEARCH_MOUNT_ID;
      this.root.appendChild(mount);
    }
    this.researchMount = mount;
  }

  private wireResearchStream(researchId: string): void {
    if (!this.researchMount) return;
    if (this.wiredResearchId === researchId) return;
    this.wiredResearchId = researchId;
    this.stopResearchStream();
    this.researchPanel = new ResearchProgressPanel(this.researchMount, { embedded: true });
    this.researchPanel.reset();
    this.researchUnsubscribe = subscribeToResearchStream(researchId, {
      onProgress: (event) => {
        this.researchPanel?.apply(event);
      },
      onEnd: (event) => {
        if (event?.status === 'error') {
          this.researchPanel?.complete('error', event.message);
        } else if (event?.status === 'cancelled') {
          this.researchPanel?.complete('cancelled');
        } else {
          this.researchPanel?.complete('done');
        }
      },
    });
  }

  private stopResearchStream(): void {
    this.researchUnsubscribe?.();
    this.researchUnsubscribe = null;
  }

  private startTimer(): void {
    this.stopTimer();
    this.timerInterval = setInterval(() => this.paintTimer(), 500);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private elapsedMs(): number {
    if (this.baselineEpochMs) return Math.max(0, Date.now() - this.baselineEpochMs);
    return performance.now() - this.timerStart;
  }

  private paintTimer(): void {
    const el = this.root?.querySelector('[data-plan-timer]');
    if (el) {
      el.textContent = formatClock(this.elapsedMs());
    }
    const detailEl = this.root?.querySelector('[data-plan-detail]');
    if (detailEl && this.detailText) {
      detailEl.textContent = this.detailText;
    }
  }

  private paintSuperPlan(state: SuperPlanState | null): void {
    if (!this.root) return;
    const steps = SUPER_PLAN_DISPLAY_STEPS;
    const label =
      this.status === 'error' ? this.statusLabel : this.statusLabel || steps[this.stepIndex]!.label;

    const clickable = Boolean(this.onStepClick);
    const stepperHtml = steps
      .map((s, i) => {
        const st = state
          ? superPlanStepNodeState(state, i)
          : i < this.stepIndex
            ? 'done'
            : i === this.stepIndex
              ? 'active'
              : 'todo';
        const track =
          i > 0
            ? `<span class="dr-track ${st === 'done' || (st === 'active' && i <= this.stepIndex) ? 'fill' : ''}"></span>`
            : '';
        const inner =
          st === 'done'
            ? '<span class="dr-check" aria-hidden="true">✓</span>'
            : '<span class="dr-node-i"></span>';
        const reworkable = clickable && st === 'done';
        const title = reworkable
          ? `${escapeHtml(s.short)} — click to rework from this phase`
          : escapeHtml(s.short);
        const reworkLabel = escapeHtml(s.label);
        return `${track}<span class="dr-node ${st}${reworkable ? ' dr-node--clickable' : ''}" ${
          reworkable
            ? `data-step-index="${i}" role="button" tabindex="0" aria-label="Rework from ${reworkLabel}"`
            : ''
        } title="${title}">${inner}</span>`;
      })
      .join('');

    const labelsHtml = steps
      .map(
        (s, i) =>
          `<span class="dr-slabel research-mono ${i === this.stepIndex ? 'on' : i < this.stepIndex ? 'did' : ''}">${escapeHtml(s.short)}</span>`,
      )
      .join('');

    let head = this.root.querySelector('.dr-prog-head');
    let stepper = this.root.querySelector('.dr-stepper');
    let labels = this.root.querySelector('.dr-stepper-labels');
    let feed = this.root.querySelector('[data-plan-research-feed]') as HTMLElement | null;

    if (!head || !stepper || !labels || !feed) {
      this.root.innerHTML = `
        <div class="dr-prog-head">
          <div class="dr-prog-title"><span class="dr-dot"></span> <span data-plan-label></span></div>
          <div class="dr-timer research-mono" data-plan-timer>${formatClock(this.elapsedMs())}</div>
        </div>
        <div class="plan-progress__detail research-mono" data-plan-detail></div>
        <div class="dr-stepper"></div>
        <div class="dr-stepper-labels"></div>
        <div class="plan-progress__research-feed" data-plan-research-feed id="${PLAN_PROGRESS_RESEARCH_MOUNT_ID}"></div>
      `;
      head = this.root.querySelector('.dr-prog-head');
      stepper = this.root.querySelector('.dr-stepper');
      labels = this.root.querySelector('.dr-stepper-labels');
      feed = this.root.querySelector('[data-plan-research-feed]') as HTMLElement | null;
    }

    const labelEl = this.root.querySelector('[data-plan-label]');
    if (labelEl) labelEl.textContent = label;
    const detailEl = this.root.querySelector('[data-plan-detail]') as HTMLElement | null;
    if (detailEl) {
      detailEl.textContent = this.detailText;
      detailEl.hidden = !this.detailText;
    }
    this.root.classList.toggle('plan-progress--paused', this.status === 'paused');
    this.root.classList.toggle('plan-progress--error', this.status === 'error');
    if (stepper) stepper.innerHTML = stepperHtml;
    if (labels) labels.innerHTML = labelsHtml;
    this.researchMount = feed;
  }

  private paintRegularPlan(): void {
    if (!this.root) return;
    const steps = REGULAR_PLAN_DISPLAY_STEPS;
    const label =
      this.status === 'error' ? this.statusLabel : this.statusLabel || steps[this.stepIndex]!.label;

    const stepperHtml = steps
      .map((s, i) => {
        const st = i < this.stepIndex ? 'done' : i === this.stepIndex ? 'active' : 'todo';
        const track =
          i > 0 ? `<span class="dr-track ${i <= this.stepIndex ? 'fill' : ''}"></span>` : '';
        const inner =
          st === 'done'
            ? '<span class="dr-check" aria-hidden="true">✓</span>'
            : '<span class="dr-node-i"></span>';
        return `${track}<span class="dr-node ${st}" title="${escapeHtml(s.short)}">${inner}</span>`;
      })
      .join('');

    const labelsHtml = steps
      .map(
        (s, i) =>
          `<span class="dr-slabel research-mono ${i === this.stepIndex ? 'on' : i < this.stepIndex ? 'did' : ''}">${escapeHtml(s.short)}</span>`,
      )
      .join('');

    this.root.innerHTML = `
      <div class="dr-prog-head">
        <div class="dr-prog-title"><span class="dr-dot"></span> ${escapeHtml(label)}</div>
        <div class="dr-timer research-mono" data-plan-timer>${formatClock(performance.now() - this.timerStart)}</div>
      </div>
      <div class="dr-stepper">${stepperHtml}</div>
      <div class="dr-stepper-labels">${labelsHtml}</div>
    `;
  }

  private paint(): void {
    if (this.variant === 'super-plan') {
      this.paintSuperPlan(null);
    } else {
      this.paintRegularPlan();
    }
  }
}

/** Final preview popout with Revise / Orchestrator / Build actions. */
export function buildPlanPreviewPopoutDom(
  handlers: PlanPreviewActionHandlers,
  options: BuildPlanPreviewPopoutOptions = {},
): HTMLElement {
  const popout = document.createElement('div');
  popout.className = 'orchestrate-plan-screen__popout';
  popout.setAttribute('role', 'group');
  popout.setAttribute('aria-label', 'Plan actions');

  const title = document.createElement('p');
  title.className = 'orchestrate-plan-screen__popout-title';
  title.textContent = 'What next?';

  const actions = document.createElement('div');
  actions.className = 'orchestrate-plan-screen__popout-actions';

  const reviseBtn = document.createElement('button');
  reviseBtn.type = 'button';
  reviseBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
  reviseBtn.dataset.planAction = 'revise';
  reviseBtn.textContent = 'Revise';
  reviseBtn.addEventListener('click', handlers.onRevise);

  const buildBtn = document.createElement('button');
  buildBtn.type = 'button';
  buildBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
  buildBtn.dataset.planAction = 'build';
  buildBtn.textContent = 'Build';
  buildBtn.addEventListener('click', handlers.onBuild);

  const orchestrateBtn = document.createElement('button');
  orchestrateBtn.type = 'button';
  orchestrateBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--primary';
  orchestrateBtn.dataset.planAction = 'orchestrate';
  orchestrateBtn.textContent = 'Start Orchestrator';
  orchestrateBtn.disabled = options.orchestrateEnabled === false;
  orchestrateBtn.addEventListener('click', handlers.onStartOrchestrator);

  actions.append(reviseBtn, buildBtn, orchestrateBtn);
  popout.append(title, actions);
  return popout;
}

/** Resolve a preview action button by id (for tests). */
export function findPlanPreviewActionButton(
  root: ParentNode,
  actionId: PlanPreviewActionId,
): HTMLButtonElement | null {
  const el = root.querySelector(`[data-plan-action="${actionId}"]`);
  if (!el || el.tagName !== 'BUTTON') return null;
  return el as HTMLButtonElement;
}
