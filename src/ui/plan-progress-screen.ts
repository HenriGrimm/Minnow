import { findLastPlanSavePath } from '../chat/plans/plan-from-history';
import type { MainTurnPhase } from '../chat/main-turn-activity';
import type { Chat } from '../types';

/**
 * Progress for regular Plan mode's working screen. Super Plan has its own
 * surface (`super-plan-page.ts`) and never mounts this panel.
 */

type PlanActivityPhase = MainTurnPhase | null;

export const PLAN_PROGRESS_MOUNT_ID = 'orchestratePlanProgressMount';

export const REGULAR_PLAN_DISPLAY_STEPS = [
  { key: 'explore', label: 'Exploring the workspace', short: 'Explore' },
  { key: 'draft', label: 'Drafting the plan', short: 'Draft' },
  { key: 'ready', label: 'Saving the plan', short: 'Ready' },
] as const;

export type RegularPlanDisplayStepIndex = 0 | 1 | 2;

export type PlanPreviewActionId = 'revise' | 'orchestrate' | 'build';

export interface PlanPreviewActionHandlers {
  onRevise: () => void;
  onStartOrchestrator: () => void;
  onBuild: () => void;
}

export interface BuildPlanPreviewPopoutOptions {
  orchestrateEnabled?: boolean;
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
  if (input.activityPhase === 'tools') return 1;
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

/** Animated plan progress panel (Deep Research stepper layout). */
export class PlanProgressPanel {
  private readonly mount: HTMLElement;
  private readonly reducedMotion: boolean;
  private root: HTMLElement | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private timerStart = 0;
  private stepIndex = 0;
  private statusLabel = '';
  private status: 'running' | 'done' | 'error' = 'running';

  constructor(mount: HTMLElement, options: { reducedMotion?: boolean } = {}) {
    this.mount = mount;
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  }

  reset(): void {
    this.stopTimer();
    this.stepIndex = 0;
    this.statusLabel = REGULAR_PLAN_DISPLAY_STEPS[0]!.label;
    this.status = 'running';
    this.timerStart = performance.now();
    this.root = document.createElement('div');
    this.root.className = 'dr-prog plan-progress';
    if (this.reducedMotion) this.root.classList.add('plan-progress--reduced-motion');
    this.mount.replaceChildren(this.root);
    this.startTimer();
    this.paint();
  }

  destroy(): void {
    this.stopTimer();
    this.mount.replaceChildren();
    this.root = null;
  }

  applyRegularPlanStep(stepIndex: RegularPlanDisplayStepIndex, label?: string): void {
    if (!this.root) return;
    this.stepIndex = stepIndex;
    this.statusLabel = label?.trim() || regularPlanProgressLabel(stepIndex);
    this.status = stepIndex >= 2 ? 'done' : 'running';
    this.paint();
  }

  complete(status: 'done' | 'error', message?: string): void {
    this.status = status;
    if (message) this.statusLabel = message;
    if (status === 'done') this.stepIndex = REGULAR_PLAN_DISPLAY_STEPS.length - 1;
    this.stopTimer();
    this.paint();
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

  private paintTimer(): void {
    const el = this.root?.querySelector('[data-plan-timer]');
    if (el) el.textContent = formatClock(performance.now() - this.timerStart);
  }

  private paint(): void {
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

    this.root.classList.toggle('plan-progress--error', this.status === 'error');
    this.root.innerHTML = `
      <div class="dr-prog-head">
        <div class="dr-prog-title"><span class="dr-dot"></span> ${escapeHtml(label)}</div>
        <div class="dr-timer research-mono" data-plan-timer>${formatClock(performance.now() - this.timerStart)}</div>
      </div>
      <div class="dr-stepper">${stepperHtml}</div>
      <div class="dr-stepper-labels">${labelsHtml}</div>
    `;
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
