/**
 * Provider identity for agents: the producer logo from the model picker, with a
 * status badge on its corner (sub-agent cards, group headers, sidebar agent rows).
 */
import { modelProducerLogoSvg } from '../providers/model-producer';
import { createIcon } from './icon';

/** Where an agent stands, as its mark shows it. */
export type AgentMarkState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

const LIVE_STATES: ReadonlySet<AgentMarkState> = new Set(['queued', 'running', 'waiting']);

/** The model that actually ran, else the one requested. */
export function agentModelId(source: { modelId?: string; resolvedModel?: { id: string } | null }): string {
  return source.resolvedModel?.id?.trim() || source.modelId?.trim() || '';
}

/** Maps the human status labels agent rows already show onto a mark state. */
export function agentMarkStateFromLabel(label: string): AgentMarkState {
  if (label === 'Complete' || label === 'Done' || label === 'Ready' || label === 'Inspect only') return 'done';
  if (label === 'Failed') return 'failed';
  if (label === 'Stopped') return 'stopped';
  if (label === 'Working' || label === 'Loading model' || label === 'Stopping') return 'running';
  if (label.startsWith('Queued')) return 'queued';
  return 'waiting';
}

/**
 * Producer logo for a model id into `host`. A bare alias (`sonnet`) has no family
 * of its own, so the connection it runs on (`claude-cli`, `codex`) breaks the tie;
 * failing both, the generic agent glyph.
 */
export function fillProducerLogo(host: HTMLElement, modelId: string, providerId = ''): void {
  const svg = (modelId ? modelProducerLogoSvg(modelId) : null)
    ?? (providerId ? modelProducerLogoSvg(providerId.replace(/^codex\b/i, 'openai')) : null);
  if (svg) host.innerHTML = svg;
  else host.replaceChildren(createIcon('appAgentActivity', { size: 12 }));
  host.dataset.hasLogo = svg ? 'true' : 'false';
}

/** Empty mark; fill it with {@link syncAgentMark}. Decorative: the row's label carries status. */
export function createAgentMark(className?: string): HTMLElement {
  const mark = document.createElement('span');
  mark.className = className ? `agent-mark ${className}` : 'agent-mark';
  mark.setAttribute('aria-hidden', 'true');
  const logo = document.createElement('span');
  logo.className = 'agent-mark__logo';
  const badge = document.createElement('span');
  badge.className = 'agent-mark__badge';
  mark.append(logo, badge);
  return mark;
}

/**
 * Swap the logo only when the model changes. A live → settled change plays the
 * badge pop once; marks painted already settled (history rebuilds) stay still.
 */
export function syncAgentMark(mark: HTMLElement, modelId: string, state: AgentMarkState): void {
  const logo = mark.querySelector<HTMLElement>(':scope > .agent-mark__logo');
  if (logo && mark.dataset.model !== modelId) {
    mark.dataset.model = modelId;
    fillProducerLogo(logo, modelId);
  }
  const previous = mark.dataset.state as AgentMarkState | undefined;
  if (previous === state) return;
  mark.dataset.state = state;
  const badge = mark.querySelector<HTMLElement>(':scope > .agent-mark__badge');
  if (!badge) return;
  if (state === 'done') badge.replaceChildren(createIcon('check', { size: 8 }));
  else if (state === 'failed') badge.replaceChildren(createIcon('close', { size: 8 }));
  else badge.replaceChildren();
  if (previous && LIVE_STATES.has(previous) && !LIVE_STATES.has(state)) {
    mark.classList.add('agent-mark--settled');
    // Re-parenting restarts CSS animations, so the pop must not outlive its first run.
    badge.addEventListener('animationend', () => mark.classList.remove('agent-mark--settled'), { once: true });
  }
}

/** Producer logos for a set of agents, three at most plus an overflow count. */
export function syncAgentMarkStack(stack: HTMLElement, modelIds: readonly string[]): void {
  const key = JSON.stringify(modelIds);
  if (stack.dataset.models === key) return;
  stack.dataset.models = key;
  const shown = modelIds.slice(0, 3).map((modelId) => {
    const mark = createAgentMark('agent-mark--stacked');
    syncAgentMark(mark, modelId, 'done');
    return mark;
  });
  const extra = modelIds.length - shown.length;
  if (extra > 0) {
    const more = document.createElement('span');
    more.className = 'agent-mark agent-mark--stacked agent-mark--more';
    more.textContent = `+${extra}`;
    shown.push(more);
  }
  stack.replaceChildren(...shown);
}

/** The composer picker's chip: producer logo + model name. */
export function createAgentModelChip(): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'agent-model-chip';
  const logo = document.createElement('span');
  logo.className = 'agent-model-chip__logo';
  logo.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'agent-model-chip__label';
  chip.append(logo, label);
  return chip;
}

export function syncAgentModelChip(chip: HTMLElement, modelId: string, label: string): void {
  const labelEl = chip.querySelector<HTMLElement>('.agent-model-chip__label');
  if (labelEl) labelEl.textContent = label;
  chip.title = label;
  const logo = chip.querySelector<HTMLElement>('.agent-model-chip__logo');
  if (!logo || chip.dataset.model === modelId) return;
  chip.dataset.model = modelId;
  const svg = modelId ? modelProducerLogoSvg(modelId) : null;
  logo.innerHTML = svg ?? '';
  logo.hidden = !svg;
}
