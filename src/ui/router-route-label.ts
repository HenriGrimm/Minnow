/** Composer status for an Auto pool, with reasoning visible independently of the model name. */
import '../styles/router-route.css';
import { formatReasoningEffortLabel, isReasoningEffortOption } from '../lib/reasoning-effort';
import { formatRouterTierLabel } from '../models/router-tiers.mjs';
import type { RouterRouteState } from '../models/routers';

export interface RouterRouteLabelInput {
  poolName: string;
  route?: RouterRouteState;
  scopeKey?: string;
}

interface RouteMotion {
  scopeKey?: string;
  startedAt?: number;
  animations: Set<Animation>;
}

const motionByRoot = new WeakMap<HTMLElement, RouteMotion>();
const settleEase = 'cubic-bezier(0.16, 1, 0.3, 1)';

function createConstellation(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = `<circle class="mn-route__halo" cx="14" cy="15" r="8" />
    <path class="mn-route__star mn-route__star--main" d="M14 7c.8 5.2 2.8 7.2 8 8-5.2.8-7.2 2.8-8 8-.8-5.2-2.8-7.2-8-8 5.2-.8 7.2-2.8 8-8Z" />
    <path class="mn-route__star mn-route__star--north" d="M22 2c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4Z" />
    <path class="mn-route__star mn-route__star--west" d="M5 3c.3 2 1 2.7 3 3-2 .3-2.7 1-3 3-.3-2-1-2.7-3-3 2-.3 2.7-1 3-3Z" />
    <circle class="mn-route__mote mn-route__mote--one" cx="14" cy="15" r="1" />
    <circle class="mn-route__mote mn-route__mote--two" cx="14" cy="15" r=".8" />
    <circle class="mn-route__mote mn-route__mote--three" cx="14" cy="15" r=".7" />`;
  return svg;
}

function stopMotion(root: HTMLElement): void {
  const motion = motionByRoot.get(root);
  motion?.animations.forEach((animation) => animation.cancel());
  motion?.animations.clear();
}

function animatePart(motion: RouteMotion, element: Element, frames: Keyframe[], duration = 320): void {
  if (typeof element.animate !== 'function') return;
  const animation = element.animate(frames, { duration, easing: settleEase });
  motion.animations.add(animation);
  animation.onfinish = animation.oncancel = () => { motion.animations.delete(animation); };
}

/** Capture the actual loop pose before removing it, so any completion time settles smoothly. */
function settleConstellation(root: HTMLElement, motion: RouteMotion): void {
  const elements = [...root.querySelectorAll('.mn-route__spark svg > *')];
  const poses = elements.map((element) => {
    const style = window.getComputedStyle(element);
    return { transform: style.transform, opacity: style.opacity };
  });
  root.classList.remove('is-deciding');
  const restingPoses = elements.map((element) => {
    const style = window.getComputedStyle(element);
    return { transform: style.transform, opacity: style.opacity };
  });
  elements.forEach((element, index) => animatePart(motion, element, [poses[index], restingPoses[index]]));
}

function ensureParts(host: HTMLElement) {
  let root = host.querySelector<HTMLElement>(':scope > .mn-route');
  if (!root) {
    root = document.createElement('span');
    root.className = 'mn-route';
    const spark = document.createElement('span');
    spark.className = 'mn-route__spark';
    spark.setAttribute('aria-hidden', 'true');
    spark.append(createConstellation());
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
  }
  return {
    root,
    level: root.querySelector<HTMLElement>('.mn-route__level')!,
    model: root.querySelector<HTMLElement>('.mn-route__model')!,
  };
}

export function routerDecisionLevelLabel(decision: RouterRouteState['decision']): string {
  if (!decision) return 'Auto';
  if (decision.reasoningStatus === 'unsupported') return 'No reasoning';
  if (decision.effort && isReasoningEffortOption(decision.effort)) return `${formatReasoningEffortLabel(decision.effort)} reasoning`;
  if (decision.requestedEffort && isReasoningEffortOption(decision.requestedEffort)) return `${formatReasoningEffortLabel(decision.requestedEffort)} requested`;
  if (decision.source === 'fallback') return 'Fallback';
  return 'Model default';
}

export function routerDecisionTitle(route: RouterRouteState | undefined, poolName: string): string {
  if (!route) return `${poolName} · A task evaluator chooses the model and reasoning once for this chat.`;
  if (route.phase === 'deciding') return route.judgedBy ? `${route.judgedBy} is choosing a model and reasoning…` : 'Choosing a model and reasoning…';
  const decision = route.decision;
  if (!decision) return poolName;
  const details = [poolName, routerDecisionLevelLabel(decision)];
  if (decision.source === 'fallback') details.push('Task evaluator unavailable');
  if (decision.tier) details.push(`${formatRouterTierLabel(decision.tier)} tier`);
  if (decision.requestedEffort && decision.requestedEffort !== decision.effort) details.push(`Evaluator requested ${decision.requestedEffort} reasoning`);
  if (decision.reasoningStatus === 'default') details.push('Provider does not advertise reasoning levels; using its default');
  if (decision.reasoningStatus === 'unsupported') details.push('Model does not support reasoning');
  if (decision.judgedBy) details.push(`Judged by ${decision.judgedBy} (${Math.round((decision.confidence || 0) * 100)}%)`);
  if (decision.reason) details.push(decision.reason);
  details.push(route.reevaluate ? 'Re-evaluates on your next message' : 'Kept for this chat');
  return details.join(' · ');
}

export function clearRouterRouteLabel(host: HTMLElement): void {
  const root = host.querySelector<HTMLElement>('.mn-route');
  if (!root) return;
  stopMotion(root);
  motionByRoot.delete(root);
  root.classList.remove('is-deciding');
  root.setAttribute('aria-busy', 'false');
}

export function renderRouterRouteLabel(host: HTMLElement, input: RouterRouteLabelInput): void {
  const { route, poolName, scopeKey } = input;
  const parts = ensureParts(host);
  const deciding = route?.phase === 'deciding';
  let motion = motionByRoot.get(parts.root);
  const sameRun = !!motion && motion.scopeKey === scopeKey && motion.startedAt === route?.startedAt;
  const finishing = parts.root.classList.contains('is-deciding') && !deciding && sameRun && !!route?.decision;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!sameRun || deciding && !parts.root.classList.contains('is-deciding') || reducedMotion) {
    stopMotion(parts.root);
    motion = { scopeKey, startedAt: route?.startedAt, animations: new Set() };
    motionByRoot.set(parts.root, motion);
  }
  if (finishing && !reducedMotion) settleConstellation(parts.root, motion!);
  parts.root.classList.toggle('is-deciding', deciding);
  parts.root.setAttribute('aria-busy', String(deciding));
  const level = deciding && !route?.decision ? 'Evaluating' : routerDecisionLevelLabel(route?.decision);
  const model = route?.decision?.modelLabel || poolName;
  if (parts.level.textContent !== level) parts.level.textContent = level;
  if (parts.model.textContent !== model) parts.model.textContent = model;
  if (finishing && !reducedMotion) {
    animatePart(motion!, parts.level, [{ opacity: .35, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], 240);
    animatePart(motion!, parts.model, [{ opacity: .35, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], 300);
  }
  host.title = routerDecisionTitle(route, poolName);
}
