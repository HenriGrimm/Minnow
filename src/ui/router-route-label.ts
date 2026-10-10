/**
 * Composer label for an Auto model pool (router policy `evaluate`).
 *
 * idle      ✦ Auto · <pool name>
 * deciding  ✦ Deciding · <candidates rolling>   (shimmer + spin)
 * decided   ✦ High · <model>                    (accent flash, then settles)
 *
 * The first decision in a chat plays the full pick (names roll and slow down);
 * later turns only shimmer, on the model already in use. A fast evaluator
 * still reads as a pick: the deciding look holds for a minimum time.
 */

import '../styles/router-route.css';
import { createIcon } from './icon';
import { formatReasoningEffortLabel } from '../lib/reasoning-effort';
import { formatRouterTierLabel } from '../models/router-tiers.mjs';
import type { RouterRouteState } from '../models/routers';

export const FIRST_PICK_MS = 1100;
export const LATER_PICK_MS = 450;
const FLASH_MS = 140;
const TICK_START_MS = 70;
const TICK_GROWTH = 1.14;
const TICK_MAX_MS = 260;

export interface RouterRouteLabelInput {
  poolName: string;
  route?: RouterRouteState;
  /** Test seams. */
  now?: number;
  reducedMotion?: boolean;
}

interface LabelParts {
  root: HTMLElement;
  level: HTMLElement;
  model: HTMLElement;
}

interface LabelRuntime {
  phase: 'idle' | 'deciding' | 'decided';
  tickTimer?: ReturnType<typeof setTimeout>;
  holdTimer?: ReturnType<typeof setTimeout>;
  tickIndex: number;
  tickDelay: number;
  /** Decision already flashed, so a re-sync does not flash it again. */
  flashedFor?: RouterRouteState['decision'];
  /** `startedAt` of the pick on screen; another chat's decision never flashes. */
  pickStartedAt?: number;
}

const runtimes = new WeakMap<HTMLElement, LabelRuntime>();

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

function ensureParts(host: HTMLElement): LabelParts {
  const existing = host.querySelector<HTMLElement>(':scope > .mn-route');
  if (existing) {
    return {
      root: existing,
      level: existing.querySelector<HTMLElement>('.mn-route__level')!,
      model: existing.querySelector<HTMLElement>('.mn-route__model')!,
    };
  }
  const root = document.createElement('span');
  root.className = 'mn-route';
  const spark = document.createElement('span');
  spark.className = 'mn-route__spark';
  spark.setAttribute('aria-hidden', 'true');
  spark.append(createIcon('sparkles', { size: 13 }));
  const level = document.createElement('span');
  level.className = 'mn-route__level';
  const sep = document.createElement('span');
  sep.className = 'mn-route__sep';
  sep.setAttribute('aria-hidden', 'true');
  sep.textContent = '·';
  const model = document.createElement('span');
  model.className = 'mn-route__model';
  root.append(spark, level, sep, model);
  host.replaceChildren(root);
  return { root, level, model };
}

function stopTimers(runtime: LabelRuntime): void {
  if (runtime.tickTimer) clearTimeout(runtime.tickTimer);
  if (runtime.holdTimer) clearTimeout(runtime.holdTimer);
  runtime.tickTimer = undefined;
  runtime.holdTimer = undefined;
}

/** "High", or the tier when the model has no reasoning levels. */
export function routerDecisionLevelLabel(decision: RouterRouteState['decision']): string {
  if (!decision) return 'Auto';
  if (decision.effort) return formatReasoningEffortLabel(decision.effort as never);
  if (decision.tier) return formatRouterTierLabel(decision.tier);
  return 'Auto';
}

export function routerDecisionTitle(route: RouterRouteState | undefined, poolName: string): string {
  if (!route) return `${poolName} · Auto model pool. A task evaluator picks the model and reasoning for each turn.`;
  if (route.phase === 'deciding') return route.judgedBy ? `${route.judgedBy} is choosing a model…` : 'Choosing a model…';
  const decision = route.decision;
  if (!decision) return poolName;
  if (decision.source === 'evaluator' || decision.source === 'kept' || decision.source === 'turn') {
    const pct = Math.round((decision.confidence || 0) * 100);
    return `Judged by ${decision.judgedBy || 'the task evaluator'} · ${pct}% — ${decision.reason}`;
  }
  return decision.reason || poolName;
}

/** Remove timers and animation state when the trigger stops showing a pool. */
export function clearRouterRouteLabel(host: HTMLElement): void {
  const runtime = runtimes.get(host);
  if (runtime) stopTimers(runtime);
  runtimes.delete(host);
}

/**
 * Render (or re-render) the Auto pool label into `host`. Safe to call on every
 * trigger sync: structure is built once and timers are owned per host.
 */
export function renderRouterRouteLabel(host: HTMLElement, input: RouterRouteLabelInput): void {
  const { route, poolName } = input;
  const now = input.now ?? performance.now();
  const reduced = input.reducedMotion ?? prefersReducedMotion();
  const parts = ensureParts(host);
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = { phase: 'idle', tickIndex: 0, tickDelay: TICK_START_MS };
    runtimes.set(host, runtime);
  }
  const holdMs = route?.first ? FIRST_PICK_MS : LATER_PICK_MS;
  const holdLeft = route ? route.startedAt + holdMs - now : 0;
  const phase: LabelRuntime['phase'] = !route
    ? 'idle'
    : route.phase === 'deciding' || (route.phase === 'decided' && holdLeft > 0 && runtime.phase === 'deciding' && runtime.pickStartedAt === route.startedAt)
      ? 'deciding'
      : 'decided';

  host.title = routerDecisionTitle(phase === 'deciding' && route ? { ...route, phase: 'deciding' } : route, poolName);

  if (phase === 'deciding' && route) {
    const entering = runtime.phase !== 'deciding' || runtime.pickStartedAt !== route.startedAt;
    runtime.phase = 'deciding';
    runtime.pickStartedAt = route.startedAt;
    parts.root.classList.remove('is-flash', 'is-settling');
    parts.root.classList.add('is-deciding');
    parts.level.textContent = 'Deciding';
    const roll = route.first && route.candidates.length > 1 && !reduced;
    if (!roll) {
      parts.model.textContent = route.decision?.modelLabel || poolName;
    } else if (entering || !runtime.tickTimer) {
      runtime.tickIndex = 0;
      runtime.tickDelay = TICK_START_MS;
      const tick = (): void => {
        if (!parts.root.isConnected || runtime!.phase !== 'deciding') { runtime!.tickTimer = undefined; return; }
        parts.model.textContent = route.candidates[runtime!.tickIndex++ % route.candidates.length];
        parts.model.classList.remove('is-tick');
        void parts.model.offsetWidth;
        parts.model.classList.add('is-tick');
        runtime!.tickDelay = Math.min(TICK_MAX_MS, runtime!.tickDelay * TICK_GROWTH);
        runtime!.tickTimer = setTimeout(tick, runtime!.tickDelay);
      };
      tick();
    }
    // The decision is in but the pick is still on screen: settle when it ends.
    if (route.phase === 'decided' && !runtime.holdTimer) {
      runtime.holdTimer = setTimeout(() => {
        runtime!.holdTimer = undefined;
        if (host.isConnected) renderRouterRouteLabel(host, { ...input, now: undefined });
      }, Math.max(0, holdLeft));
    }
    return;
  }

  const wasDeciding = runtime.phase === 'deciding' && runtime.pickStartedAt === route?.startedAt;
  stopTimers(runtime);
  runtime.phase = phase;
  parts.root.classList.remove('is-deciding');
  parts.model.classList.remove('is-tick');

  if (phase === 'idle' || !route) {
    parts.root.classList.remove('is-flash', 'is-settling');
    parts.level.textContent = 'Auto';
    parts.model.textContent = poolName;
    return;
  }

  const decision = route.decision;
  parts.level.textContent = routerDecisionLevelLabel(decision);
  parts.model.textContent = decision?.modelLabel || poolName;
  if (wasDeciding && decision && runtime.flashedFor !== decision && !reduced) {
    runtime.flashedFor = decision;
    parts.root.classList.remove('is-settling');
    parts.root.classList.add('is-flash');
    // The accent paints with no transition, then fades back. A timer, not
    // requestAnimationFrame: rAF pauses in hidden windows and would leave the
    // label stuck in the accent colour.
    setTimeout(() => {
      parts.root.classList.add('is-settling');
      parts.root.classList.remove('is-flash');
    }, FLASH_MS);
  }
}
