/** Composer status for an Auto pool, with reasoning visible independently of the model name. */
import '../styles/router-route.css';
import { createIcon } from './icon';
import { formatReasoningEffortLabel, isReasoningEffortOption } from '../lib/reasoning-effort';
import { formatRouterTierLabel } from '../models/router-tiers.mjs';
import type { RouterRouteState } from '../models/routers';

export interface RouterRouteLabelInput {
  poolName: string;
  route?: RouterRouteState;
}

function ensureParts(host: HTMLElement) {
  let root = host.querySelector<HTMLElement>(':scope > .mn-route');
  if (!root) {
    root = document.createElement('span');
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
  return 'Model default';
}

export function routerDecisionTitle(route: RouterRouteState | undefined, poolName: string): string {
  if (!route) return `${poolName} · A task evaluator chooses the model and reasoning once for this chat.`;
  if (route.phase === 'deciding') return route.judgedBy ? `${route.judgedBy} is choosing a model and reasoning…` : 'Choosing a model and reasoning…';
  const decision = route.decision;
  if (!decision) return poolName;
  const details = [poolName, routerDecisionLevelLabel(decision)];
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
  host.querySelector('.mn-route')?.classList.remove('is-deciding');
}

export function renderRouterRouteLabel(host: HTMLElement, input: RouterRouteLabelInput): void {
  const { route, poolName } = input;
  const parts = ensureParts(host);
  const deciding = route?.phase === 'deciding';
  parts.root.classList.toggle('is-deciding', deciding);
  parts.root.setAttribute('aria-busy', String(deciding));
  parts.level.textContent = deciding && !route?.decision ? 'Evaluating' : routerDecisionLevelLabel(route?.decision);
  parts.model.textContent = route?.decision?.modelLabel || poolName;
  host.title = routerDecisionTitle(route, poolName);
}
