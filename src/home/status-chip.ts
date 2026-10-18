import type { HomeIssueRun } from '../types';
import { createIssueTypeIconElement, resolveIssueStatusIcon } from '../issues/type-icons';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { createIcon, type IconName } from '../ui/icon';
import { stateLabel } from './flow-model';
import { el } from './dom';

/** Home's agent states share the issue workflow glyphs and shell action icons. */
export function updateHomeStatus(chip: HTMLElement, state?: HomeIssueRun['state'], phase?: string): void {
  const current = phase === 'awaiting_input' ? 'asking' : state || phase || 'idle';
  const actions: Partial<Record<string, IconName>> = { asking: 'comment', conflict: 'gitMerge', rebasing: 'gitRebase', mergequeued: 'gitMerge', merging: 'gitMerge', paused: 'stop', canceled: 'stop', held: 'link', waitslot: 'clock', queued: 'clock', failed: 'statusFail' };
  const role = current === 'done' ? 'done' : current === 'ready' || current === 'review' ? 'review' : current === 'working' || current === 'running' ? 'in_progress' : 'todo';
  const status = getIssuesTaxonomySync().statuses.find(item => item.role === role);
  chip.dataset.state = current;
  chip.replaceChildren(actions[current] ? createIcon(actions[current]!) : createIssueTypeIconElement(resolveIssueStatusIcon(role, status)), el('span', stateLabel(state, phase)));
}

export function createHomeStatus(state?: HomeIssueRun['state'], phase?: string): HTMLElement {
  const chip = el('span', '', 'home-status'); updateHomeStatus(chip, state, phase); return chip;
}
