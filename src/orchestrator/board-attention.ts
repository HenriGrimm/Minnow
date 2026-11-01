import type { BoardState } from '../../server/orchestrator/core/types';
import { needsAttention } from '../../server/orchestrator/core/derive.js';
import { createButton, createIconButton } from '../ui/components/button';
import { openPopover, type PopoverHandle } from '../ui/components/popover';
import { createIcon, type IconName } from '../ui/icon';
import type { EngineError } from './client';
import { attentionIssues, renderFinalAttention, renderTaskAttention, type BoardAttentionActions } from './attention-details';
import { renderEngineErrors } from './board-render';
import { renderRecovery } from './recovery-view';
import { el } from './dom';

export interface BoardAttentionItem {
  id: string;
  title: string;
  subtitle: string;
  icon: IconName;
  tone: 'info' | 'warn' | 'bad';
  /** Only changed diagnostics should remount an open detail. */
  revision: string;
  render: () => HTMLElement;
}

export interface BoardNotice { text: string; tone: 'info' | 'warn' | 'bad' }

export function collectBoardAttention(
  state: BoardState,
  actions: BoardAttentionActions & { checkRecovery: (key: string) => Promise<void> },
  errors?: ReadonlyMap<string, EngineError>,
  notice?: BoardNotice | null,
): BoardAttentionItem[] {
  const items: BoardAttentionItem[] = [];
  for (const hold of Object.values(state.recoveryHolds ?? {})) {
    items.push({
      id: `recovery:${hold.key}`,
      title: hold.attention ? 'Action needed' : 'Waiting to resume',
      subtitle: `${hold.taskId ?? 'Board'} · ${hold.role}`,
      icon: hold.attention ? 'checksFailed' : 'clock',
      tone: hold.attention ? 'warn' : 'info',
      revision: JSON.stringify([hold, state.status]),
      render: () => renderRecovery(state, actions.checkRecovery, hold.key)!,
    });
  }
  if (state.finalTest?.outcome === 'fail') {
    items.push({
      id: 'final', title: 'Integration check failed', subtitle: 'Final check',
      icon: 'checksFailed', tone: 'bad', revision: JSON.stringify(state.finalTest),
      render: () => renderFinalAttention(state, actions),
    });
  }
  for (const id of state.taskOrder) {
    const task = state.tasks.get(id);
    if (!task || !needsAttention(task)) continue;
    items.push({
      id: `task:${id}`,
      title: task.skippedBy ? 'Dependency did not finish' : task.mergeConflicts?.length || task.mergeFailure ? 'Merge failed' : 'Task did not finish',
      subtitle: `${id} · ${task.title}`,
      icon: task.skippedBy ? 'link' : 'gitMerge', tone: 'warn',
      revision: JSON.stringify([task.phase, task.title, attentionIssues(task)]),
      render: () => renderTaskAttention(task, actions),
    });
  }
  for (const [key, error] of errors ?? []) {
    // Recovery already exposes the same dispatch failure with a Check again action.
    if (Object.values(state.recoveryHolds ?? {}).some(hold => hold.taskId === error.taskId && hold.role === error.role && hold.failure.message === error.message)) continue;
    items.push({
      id: `engine:${key}`, title: 'Work is not starting',
      subtitle: `${error.taskId ?? 'Board'} · ${error.role}`,
      icon: 'checksFailed', tone: 'bad', revision: JSON.stringify(error),
      render: () => renderEngineErrors(new Map([[key, error]]))!,
    });
  }
  if (notice) {
    const captured = notice;
    items.push({
      id: 'notice', title: notice.tone === 'info' ? 'Board update' : 'Board action failed',
      subtitle: notice.text, icon: 'inbox', tone: notice.tone,
      revision: JSON.stringify(notice), render: () => el('p', 'ov2-inbox__message', captured.text),
    });
  }
  return items;
}

/** A stable header control: board paints move the trigger, leaving its popover intact. */
export function createBoardAttentionInbox() {
  let items: BoardAttentionItem[] = [];
  let selectedId: string | null = null;
  let renderedId: string | null = null;
  let revision: string | null = null;
  let popover: PopoverHandle | null = null;
  const content = el('div', 'ov2-inbox');
  const heading = el('div', 'ov2-inbox__heading');
  const title = el('strong');
  const queue = el('div', 'ov2-inbox__queue');
  queue.setAttribute('role', 'group');
  queue.setAttribute('aria-label', 'Board notices');
  const detail = el('div', 'ov2-inbox__detail');
  const close = () => popover?.close();
  heading.append(title, createIconButton({ icon: 'close', label: 'Close attention inbox', size: 'sm', onClick: close }));
  content.append(heading, queue, detail);
  const element = createButton({
    label: 'Needs attention', icon: 'inbox', size: 'sm', variant: 'ghost',
    className: 'ov2-inbox-trigger',
    onClick: () => {
      if (popover) { close(); return; }
      render();
      popover = openPopover({
        anchor: element, content, placement: 'bottom-end',
        ariaLabel: 'Board attention inbox', className: 'ov2-inbox-popover',
        onClose: () => { popover = null; },
      });
    },
  });
  element.dataset.focusKey = 'board-attention';
  element.setAttribute('aria-haspopup', 'dialog');
  element.setAttribute('aria-expanded', 'false');
  const count = el('span', 'ov2-inbox__count');
  count.setAttribute('aria-hidden', 'true');
  const announcement = el('span', 'ov2-inbox__announcement');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.setAttribute('aria-atomic', 'true');
  element.append(count, announcement);
  element.hidden = true;

  function render(): void {
    const selected = items.find(item => item.id === selectedId) ?? items[0];
    if (!selected) return;
    selectedId = selected.id;
    const focus = document.activeElement as HTMLElement | null;
    const focusedItem = focus?.closest<HTMLElement>('[data-notice-id]')?.dataset.noticeId;
    title.textContent = `${element.dataset.tone === 'info' ? 'Board notices' : 'Needs attention'} · ${items.length}`;
    queue.replaceChildren();
    for (const item of items) {
      const row = createButton({ variant: 'ghost', className: 'ov2-inbox__item', onClick: () => {
        selectedId = item.id;
        render();
        [...queue.querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.noticeId === item.id)?.focus();
      } });
      row.dataset.noticeId = item.id;
      row.dataset.tone = item.tone;
      row.setAttribute('aria-pressed', String(item.id === selectedId));
      const copy = el('span', 'ov2-inbox__copy');
      copy.append(el('span', 'ov2-inbox__item-title', item.title), el('span', 'ov2-inbox__subtitle', item.subtitle));
      row.append(createIcon(item.icon, { className: 'ov2-inbox__icon' }), copy, createIcon('chevronRight'));
      queue.appendChild(row);
    }
    // Keep disclosures, log scroll and pending recovery actions during unrelated paints.
    if (renderedId !== selected.id || revision !== selected.revision) {
      const focusKey = focus && detail.contains(focus) ? focus.dataset.focusKey : undefined;
      const disclosures = [...detail.querySelectorAll<HTMLDetailsElement>('details')].map(node => node.open);
      const scrollTop = detail.scrollTop;
      detail.replaceChildren(selected.render());
      if (renderedId === selected.id) {
        detail.querySelectorAll<HTMLDetailsElement>('details').forEach((node, i) => { node.open = disclosures[i] ?? node.open; });
        detail.scrollTop = scrollTop;
      }
      renderedId = selected.id;
      revision = selected.revision;
      if (focusKey) [...detail.querySelectorAll<HTMLElement>('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey)?.focus();
      else if (focus && !focus.isConnected && popover) queue.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    }
    if (focusedItem) {
      const rows = [...queue.querySelectorAll<HTMLButtonElement>('button')];
      (rows.find(button => button.dataset.noticeId === focusedItem) ?? rows.find(button => button.getAttribute('aria-pressed') === 'true'))?.focus();
    }
    popover?.reposition();
  }

  return {
    element,
    update(next: BoardAttentionItem[]): void {
      items = next;
      element.hidden = items.length === 0;
      const tone = items.some(item => item.tone !== 'info') ? 'warn' : 'info';
      element.dataset.tone = tone;
      const label = tone === 'info' ? 'Board notices' : 'Needs attention';
      element.querySelector('.mn-btn__label')!.textContent = label;
      count.textContent = String(items.length);
      const summary = `${label}, ${items.length} ${items.length === 1 ? 'notice' : 'notices'}`;
      element.setAttribute('aria-label', summary);
      if (announcement.textContent !== summary) announcement.textContent = summary;
      if (!items.length) {
        close(); selectedId = null; renderedId = null; revision = null;
      } else if (popover) render();
    },
    close,
    dispose(): void { close(); element.remove(); content.remove(); },
  };
}
