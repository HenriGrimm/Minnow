/** Boards tab root: Orchestrate boards for the current workspace. */

import { createBoardListClient, type BoardSummary } from '../orchestrator/client';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import { attachPullToRefresh, screenHeader, segmented } from './chrome';
import { el, emptyState, icon } from './dom';
import { boardStatus } from './board-status';
import type { MobileScreen } from './nav';

type BoardFilter = 'active' | 'all';

function isActive(board: BoardSummary): boolean {
  return board.status === 'running' || !board.finished || (board.attentionCount ?? 0) > 0;
}

function inWorkspace(board: BoardSummary, workspace: string): boolean {
  // Journals written before boards were stamped show in every workspace.
  if (!board.workspacePath) return true;
  return normalizeWorkspacePath(board.workspacePath) === workspace;
}

function buildRow(board: BoardSummary, open: (id: string) => void): HTMLElement {
  const status = boardStatus(board);
  const merged = board.mergedCount ?? 0;
  const total = Math.max(0, board.taskCount);
  const pct = total ? Math.round((merged / total) * 100) : 0;
  const attention = board.attentionCount ?? 0;
  return el(
    'button',
    {
      className: 'm-board-row',
      attrs: { type: 'button' },
      dataset: { boardId: board.boardId },
      on: { click: () => open(board.boardId) },
    },
    el(
      'span',
      { className: 'm-board-row__top' },
      el('span', { className: 'm-board-row__name', text: board.name || board.boardId }),
      el('span', { className: `m-pill m-pill--${status.tone}`, text: status.label }),
    ),
    el(
      'span',
      { className: 'm-progress', attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': merged, 'aria-label': 'Tasks merged' } },
      el('span', { className: 'm-progress__fill', attrs: { style: `width: ${pct}%` } }),
    ),
    el(
      'span',
      { className: 'm-board-row__meta' },
      el('span', { text: `${merged} of ${total} merged` }),
      attention
        ? el('span', { className: 'm-board-row__attention' }, icon('fi-rr-exclamation', 12), el('span', { text: `${attention} need${attention === 1 ? 's' : ''} you` }))
        : null,
      el('span', { className: 'm-board-row__plan', text: board.planPath.split('/').pop() ?? '' }),
    ),
  );
}

export function createBoardsScreen(deps: { openBoard(boardId: string): void }): MobileScreen {
  const client = createBoardListClient({ intervalMs: 4_000 });
  let filter: BoardFilter = 'active';
  let loaded = false;

  const header = screenHeader({ title: 'Boards', large: true });
  const filters = segmented<BoardFilter>(
    'Board filter',
    [
      { value: 'active', label: 'Active' },
      { value: 'all', label: 'All' },
    ],
    filter,
    (value) => {
      filter = value;
      render();
    },
  );
  const list = el('div', { className: 'm-list m-list--cards', attrs: { role: 'list' } });
  const body = el('div', { className: 'm-screen__body' }, filters.el, list);
  const root = el('section', { className: 'm-screen m-screen--root', dataset: { screen: 'boards' } }, header.el, body);

  attachPullToRefresh(body, () => client.refresh());

  function render(): void {
    const workspace = normalizeWorkspacePath(getWorkspacePath());
    const boards = client.getBoards().filter((board) => inWorkspace(board, workspace));
    const active = boards.filter(isActive);
    filters.setCounts({ active: active.length, all: boards.length });
    const shown = filter === 'active' ? active : boards;
    if (!loaded && !client.getError()) {
      list.replaceChildren(el('div', { className: 'm-skeleton' }), el('div', { className: 'm-skeleton' }));
      return;
    }
    if (client.getError() && !boards.length) {
      list.replaceChildren(
        emptyState({
          glyph: 'fi-rr-cloud-disabled',
          title: 'Could not load boards',
          body: client.getError()?.message,
          action: { label: 'Try again', onClick: () => void client.refresh().then(render) },
        }),
      );
      return;
    }
    if (!shown.length) {
      list.replaceChildren(
        filter === 'active' && boards.length
          ? emptyState({
              glyph: 'fi-rr-check-circle',
              title: 'Nothing running',
              body: 'Every board here is finished.',
              action: { label: 'Show all boards', onClick: () => { filter = 'all'; filters.setValue('all'); render(); } },
            })
          : emptyState({
              glyph: 'fi-rr-square-kanban',
              title: 'No boards yet',
              body: 'Boards start from a plan in Orchestrate on your computer.',
            }),
      );
      return;
    }
    const sorted = [...shown].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
    list.replaceChildren(...sorted.map((board) => buildRow(board, deps.openBoard)));
  }

  client.subscribe(() => {
    loaded = true;
    render();
  });
  const unsubWorkspace = subscribeWorkspace(render);
  render();

  return {
    key: 'boards',
    el: root,
    onShow() {
      client.start();
      void client.refresh().then(() => {
        loaded = true;
        render();
      });
    },
    onHide() {
      client.stop();
    },
    dispose() {
      client.stop();
      unsubWorkspace();
    },
  };
}
