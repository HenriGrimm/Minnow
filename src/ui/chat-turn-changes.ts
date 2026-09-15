import { normalizeModeId } from '../chat/modes/types';
import { normalizeOrchestratePlanPath } from '../chat/plans/plan-path';
import type { Chat } from '../types';
import { getPerFileChangeSummary } from '../usage/code-change-ledger';
import { createIcon } from './icon';

export interface TurnChangesOptions {
  /** Latest turn card: hosts Commit, Create PR, and Undo controls. */
  primary?: boolean;
}

/** Recorded changes for this turn, with review in the shared diff viewer. */
export function createTurnChanges(
  chat: Chat,
  start: number,
  end: number,
  options?: TurnChangesOptions,
): HTMLElement | null {
  const files = getPerFileChangeSummary(chat, start, end);
  if (!files.length) return null;
  const card = document.createElement('section');
  card.className = 'chat-turn-changes';
  card.setAttribute('aria-label', 'Changes made in this turn');
  if (options?.primary) card.dataset.turnChangesPrimary = 'true';

  const header = document.createElement('div');
  header.className = 'chat-turn-changes__header';
  const title = document.createElement('strong');
  title.textContent = `Edited ${files.length} file${files.length === 1 ? '' : 's'}`;
  const heading = document.createElement('div');
  heading.className = 'chat-turn-changes__heading';
  const totals = document.createElement('div');
  totals.className = 'chat-turn-changes__counts';
  let additions = 0;
  let deletions = 0;
  for (let i = start; i <= end; i++) {
    const msg = chat.history[i];
    if (msg?.role !== 'tool' || !msg.codeChange) continue;
    additions += msg.codeChange.additions;
    deletions += msg.codeChange.deletions;
  }
  const added = document.createElement('span');
  added.className = 'chat-turn-changes__add';
  added.textContent = `+${additions}`;
  const removed = document.createElement('span');
  removed.className = 'chat-turn-changes__del';
  removed.textContent = `−${deletions}`;
  totals.append(added, removed);
  heading.append(title, totals);
  header.append(createIcon('fileText', { size: 20 }), heading);

  if (options?.primary) {
    const actions = document.createElement('div');
    actions.id = 'codeChangeStripActions';
    actions.className = 'chat-turn-changes__actions';
    actions.hidden = true;

    const commit = document.createElement('button');
    commit.type = 'button';
    commit.id = 'btnCodeChangeCommit';
    commit.className = 'chat-turn-changes__action';
    commit.textContent = 'Commit';
    commit.title = 'Stage and commit files changed in this chat';
    commit.hidden = true;

    const pr = document.createElement('button');
    pr.type = 'button';
    pr.id = 'btnCodeChangeCreatePr';
    pr.className = 'chat-turn-changes__action';
    pr.textContent = 'Create PR';
    pr.title = 'Push and open a pull request for this branch';
    pr.hidden = true;

    actions.append(commit, pr);
    header.append(actions);

    const undo = document.createElement('button');
    undo.type = 'button';
    undo.id = 'btnCodeChangeUndo';
    undo.className = 'chat-turn-changes__undo';
    undo.setAttribute('aria-label', 'Undo last agent turn');
    undo.title = 'Undo last agent turn';
    undo.disabled = true;
    undo.hidden = true;
    undo.setAttribute('aria-disabled', 'true');
    undo.appendChild(createIcon('undo', { className: 'chat-turn-changes__undo-icon', size: 14 }));
    header.append(undo);
  }

  const planPath = findTurnPlanPath(chat, files.map((file) => file.path));
  if (planPath) header.append(createPlanActions(chat, planPath));

  const review = document.createElement('button');
  review.type = 'button';
  review.className = 'chat-turn-changes__review';
  review.textContent = 'Review';
  review.title = 'Open changes in the diff viewer';
  header.append(review);
  card.append(header);

  const rows: HTMLElement[] = [];
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'chat-turn-changes__file';
    row.hidden = rows.length >= 3;
    const path = document.createElement('button');
    path.type = 'button';
    path.className = 'chat-turn-changes__path';
    path.textContent = file.path;
    path.title = `Open ${file.path}`;
    path.addEventListener('click', () => {
      const root = chat.workspacePath?.replace(/\\/g, '/').replace(/\/$/, '');
      const absolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(file.path);
      const target = !absolute && root ? `${root}/${file.path}` : file.path;
      void import('./file-viewer').then((m) => m.openFileInViewer(target));
    });
    const counts = document.createElement('span');
    counts.className = 'chat-turn-changes__counts';
    counts.hidden = file.countsKnown === false;
    const add = document.createElement('span');
    add.className = 'chat-turn-changes__add';
    add.textContent = `+${file.additions}`;
    const del = document.createElement('span');
    del.className = 'chat-turn-changes__del';
    del.textContent = `−${file.deletions}`;
    counts.append(add, del);
    row.append(path, counts);
    rows.push(row);
    card.append(row);
  }
  let showAll = false;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'chat-turn-changes__more';
  const syncMore = () => {
    rows.forEach((row, i) => { row.hidden = !showAll && i >= 3; });
    more.textContent = showAll ? 'Show fewer files' : `Show ${files.length - 3} more files`;
    more.setAttribute('aria-expanded', String(showAll));
  };
  if (files.length > 3) {
    syncMore();
    more.addEventListener('click', () => { showAll = !showAll; syncMore(); });
    card.append(more);
  }
  review.addEventListener('click', async () => {
    review.disabled = true;
    try {
      const { reviewTurnChanges } = await import('./chat-turn-review');
      const result = await reviewTurnChanges(chat, start, end);
      if (!result.ok && !result.cancelled) throw new Error(result.error || 'Could not open review');
    } catch (error) {
      const { setStatus } = await import('./status');
      setStatus('err', error instanceof Error ? error.message : 'Could not open review');
    } finally {
      review.disabled = false;
    }
  });
  return card;
}

/** Plan file written by a Plan-mode turn; the card offers next steps for it. */
export function findTurnPlanPath(chat: Chat, paths: string[]): string | undefined {
  const mode = normalizeModeId(chat.modeId);
  if (mode !== 'plan' && mode !== 'super-plan') return undefined;
  for (const path of paths) {
    const plan = normalizeOrchestratePlanPath(path);
    if (plan) return plan;
  }
  return undefined;
}

function createPlanActions(chat: Chat, planPath: string): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'chat-turn-changes__actions chat-turn-changes__plan-actions';
  const button = (label: string, title: string, onClick: () => void) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chat-turn-changes__action';
    el.textContent = label;
    el.title = title;
    el.addEventListener('click', onClick);
    actions.append(el);
  };
  button('Open plan', planPath, () => {
    void import('./file-viewer').then((m) => m.openFileInViewer(planPath));
  });
  button('Build here', 'Switch this chat to Build and implement the plan', async () => {
    const { setChatMode } = await import('./mode-selector');
    if (!setChatMode('build', chat).ok) return;
    const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
    if (!input) return;
    input.value = `Implement the plan in \`${planPath}\`.`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const { sendMessage } = await import('../chat/messaging');
    await sendMessage();
  });
  button('Orchestrate', 'Create a board from this plan', () => {
    void import('./orchestrate-launch').then((m) => m.launchBoardFromPlan(planPath));
  });
  return actions;
}

/** Primary turn-changes card in the active transcript, if any. */
export function findPrimaryTurnChangesCard(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.chat-turn-changes[data-turn-changes-primary]');
}
