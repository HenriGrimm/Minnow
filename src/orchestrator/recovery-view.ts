import type { BoardState } from '../../server/orchestrator/core/types';
import { button, el } from './dom';

export function renderRecovery(state: BoardState, check: (key: string) => Promise<void>): HTMLElement | null {
  const holds = Object.values(state.recoveryHolds ?? {});
  if (!holds.length) return null;
  const section = el('section', 'ov2-recovery');
  section.setAttribute('aria-label', 'Board recovery');
  for (const hold of holds) {
    const row = el('div', 'ov2-recovery__row');
    const description = el('div', 'ov2-recovery__description');
    const title = hold.attention ? 'Action needed' : 'Waiting to resume';
    description.appendChild(el('strong', '', `${hold.taskId ? `${hold.taskId}: ` : ''}${title}`));
    description.appendChild(el('p', '', hold.failure.message));
    const status = el('p', 'ov2-recovery__status', state.status !== 'running'
      ? 'Recovery resumes when you start the board.'
      : hold.attention ? hold.failure.prerequisites?.length
        ? 'Your work is retained. Continues automatically when this prerequisite is ready.'
        : 'Your work is retained. Resolve this prerequisite, then check again.'
      : `Your work is retained. Resumes automatically after ${new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(hold.retryAt)}.`);
    status.setAttribute('role', 'status');
    description.appendChild(status);
    row.appendChild(description);
    if (hold.attention && state.status === 'running') {
      const ready = button({ label: 'Check again', onClick: () => {
        ready.disabled = true;
        ready.textContent = 'Checking…';
        void check(hold.key).catch((error) => { status.textContent = error instanceof Error ? error.message : 'Could not check the prerequisite. Your work is retained.'; }).finally(() => {
          ready.disabled = false;
          ready.textContent = 'Check again';
        });
      } });
      ready.dataset.focusKey = `recovery:${hold.key}`;
      row.appendChild(ready);
    }
    section.appendChild(row);
  }
  return section;
}
