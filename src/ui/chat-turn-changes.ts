import type { Chat } from '../types';
import { getPerFileChangeSummary } from '../usage/code-change-ledger';
import { createIcon } from './icon';

/** Recorded changes for this turn, with inline review loaded on demand. */
export function createTurnChanges(chat: Chat, start: number, end: number): HTMLElement | null {
  const files = getPerFileChangeSummary(chat, start, end);
  if (!files.length) return null;
  const card = document.createElement('section');
  card.className = 'chat-turn-changes';
  card.setAttribute('aria-label', 'Changes made in this turn');
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
  const review = document.createElement('button');
  review.type = 'button';
  review.className = 'chat-turn-changes__review';
  review.textContent = 'Review';
  review.setAttribute('aria-expanded', 'false');
  header.append(review);
  card.append(header);

  const rows: HTMLDetailsElement[] = [];
  for (const file of files) {
    const row = document.createElement('details');
    row.className = 'chat-turn-changes__file';
    row.hidden = rows.length >= 3;
    const summary = document.createElement('summary');
    const path = document.createElement('span');
    path.className = 'chat-turn-changes__path';
    path.textContent = file.path;
    path.title = file.path;
    const counts = document.createElement('span');
    counts.className = 'chat-turn-changes__counts';
    const add = document.createElement('span');
    add.className = 'chat-turn-changes__add';
    add.textContent = `+${file.additions}`;
    const del = document.createElement('span');
    del.className = 'chat-turn-changes__del';
    del.textContent = `−${file.deletions}`;
    counts.append(add, del);
    summary.append(path, counts, createIcon('chevronDown', { size: 14 }));
    row.append(summary);
    let loaded = false;
    row.addEventListener('toggle', async () => {
      if (!row.open || loaded) return;
      loaded = true;
      const body = document.createElement('div');
      body.className = 'chat-turn-changes__diff';
      row.append(body);
      if (!file.diffChunks.length) {
        body.textContent = 'No diff was recorded for this change.';
        return;
      }
      try {
        const { renderUnifiedPromptDiff } = await import('./prompt-diff-unified');
        for (const chunk of file.diffChunks) {
          const host = document.createElement('div');
          renderUnifiedPromptDiff(host, chunk.lines);
          body.append(host);
          if (chunk.truncated) {
            const note = document.createElement('p');
            note.textContent = 'Diff truncated for display.';
            body.append(note);
          }
        }
      } catch {
        body.textContent = 'Could not load the diff. Close and reopen to retry.';
        loaded = false;
        row.addEventListener('toggle', () => { if (!row.open) body.remove(); }, { once: true });
      }
    });
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
  review.addEventListener('click', () => {
    const open = review.getAttribute('aria-expanded') !== 'true';
    review.setAttribute('aria-expanded', String(open));
    review.textContent = open ? 'Close review' : 'Review';
    showAll = open;
    syncMore();
    rows.forEach((row) => { row.open = open; });
  });
  return card;
}
