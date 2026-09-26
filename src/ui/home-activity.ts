import { fetchCodeActivity, type ActivitySource, type CodeActivity } from '../usage/code-activity';
import { isNarrowLayout } from './mobile-layout';

const DAY = 86400000;
export function activityCalendar(data: CodeActivity, days = 365, now = Date.now()) {
  // Days are the viewer's local calendar days; the UTC math below only walks date strings.
  const local = new Date(now);
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  const end = Date.parse(`${today}T00:00:00Z`);
  const totals = new Map<string, { additions: number; deletions: number }>();
  for (const row of data.days) {
    const value = totals.get(row.day) ?? { additions: 0, deletions: 0 };
    value.additions += row.additions;
    value.deletions += row.deletions;
    totals.set(row.day, value);
  }
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(end - (days - i - 1) * DAY).toISOString().slice(0, 10);
    return { day, tracked: day >= data.trackingSince.slice(0, 10), ...(totals.get(day) ?? { additions: 0, deletions: 0 }) };
  });
}

export function activitySummary(cells: ReturnType<typeof activityCalendar>) {
  let total = 0, active = 0, longest = 0, streak = 0;
  const months = new Map<string, number>();
  let bestDay = '';
  let best = 0;
  for (const cell of cells) {
    const count = cell.additions + cell.deletions;
    total += count;
    if (count > 0) { active++; streak++; longest = Math.max(longest, streak); }
    else streak = 0;
    if (count > best) { best = count; bestDay = cell.day; }
    const month = cell.day.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + count);
  }
  // A streak stays current until the end of today's local day.
  let current = 0;
  let i = cells.length - 1;
  if (i >= 0 && cells[i].additions + cells[i].deletions === 0) i--;
  for (; i >= 0 && cells[i].additions + cells[i].deletions > 0; i--) current++;
  const bestMonth = [...months].sort((a, b) => b[1] - a[1])[0];
  return { total, active, longest, current, bestDay, bestMonth: bestMonth?.[1] ? bestMonth[0] : '' };
}

function text(tag: string, value: string, className = ''): HTMLElement {
  const el = document.createElement(tag); el.textContent = value; el.className = className; return el;
}

export type HomeActivityCell = ReturnType<typeof activityCalendar>[number];

let activityGridSequence = 0;

/**
 * A year of activity is one keyboard stop, not hundreds of tiny buttons.
 * aria-activedescendant keeps the explored day available to assistive tech;
 * Enter/Space or a pointer click requests that day's event detail.
 */
export function createHomeActivityGrid(
  cells: HomeActivityCell[],
  onActivate: (cell: HomeActivityCell) => void,
): { grid: HTMLElement; weeks: number } {
  const offset = new Date(`${cells[0]?.day ?? '1970-01-01'}T00:00:00Z`).getUTCDay();
  const weeks = Math.max(1, Math.ceil((offset + cells.length) / 7));
  const max = Math.max(1, ...cells.map(c => c.additions + c.deletions));
  const grid = text('div', '', 'home-calendar');
  const gridId = `home-activity-grid-${++activityGridSequence}`;
  grid.id = gridId;
  grid.tabIndex = 0;
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'Daily code edits. Use arrow keys to explore days; press Enter for details.');
  grid.setAttribute('aria-rowcount', '7');
  grid.setAttribute('aria-colcount', String(weeks));

  const dayCells: HTMLElement[] = [];
  const rows = Array.from({ length: 7 }, (_, index) => {
    const row = text('span', '', 'home-calendar-row');
    row.setAttribute('role', 'row');
    row.setAttribute('aria-rowindex', String(index + 1));
    grid.append(row);
    return row;
  });
  const monthLabels: HTMLElement[] = [];
  let activeIndex = Math.max(0, cells.length - 1);
  const setActive = (index: number) => {
    if (!dayCells.length) return;
    const nextIndex = Math.max(0, Math.min(dayCells.length - 1, index));
    const previous = dayCells[activeIndex];
    previous?.classList.remove('is-active');
    previous?.setAttribute('aria-selected', 'false');
    activeIndex = nextIndex;
    const next = dayCells[activeIndex];
    next.classList.add('is-active');
    next.setAttribute('aria-selected', 'true');
    grid.setAttribute('aria-activedescendant', next.id);
  };

  cells.forEach((cell, index) => {
    const edits = cell.additions + cell.deletions;
    const day = text('span', '', 'home-day');
    day.id = `${gridId}-day-${index}`;
    day.dataset.index = String(index);
    day.dataset.level = !cell.tracked ? 'unknown' : edits === 0 ? '0' : String(Math.min(4, Math.ceil(edits / max * 4)));
    day.style.gridColumn = String(Math.floor((offset + index) / 7) + 1);
    day.style.gridRow = String((offset + index) % 7 + 2);
    day.title = `${cell.day}: ${cell.tracked ? `+${cell.additions} −${cell.deletions}` : 'Before tracking began'}`;
    day.setAttribute('role', 'gridcell');
    day.setAttribute('aria-label', day.title);
    day.setAttribute('aria-colindex', String(Math.floor((offset + index) / 7) + 1));
    day.setAttribute('aria-rowindex', String((offset + index) % 7 + 1));
    day.setAttribute('aria-selected', 'false');
    dayCells.push(day);
    rows[(offset + index) % 7].append(day);

    if (cell.day.endsWith('-01') || index === 0) {
      const label = text('span', new Date(`${cell.day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }), 'home-month');
      const column = Math.floor((offset + index) / 7) + 1;
      label.style.gridColumn = `${column} / span ${Math.min(3, weeks - column + 1)}`;
      label.style.gridRow = '1';
      label.setAttribute('aria-hidden', 'true');
      monthLabels.push(label);
    }
  });
  grid.append(...monthLabels);

  setActive(activeIndex);
  grid.addEventListener('keydown', (event) => {
    const delta = ({ ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[event.key];
    if (delta != null) {
      event.preventDefault();
      setActive(activeIndex + delta);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const cell = cells[activeIndex];
      if (cell) onActivate(cell);
    }
  });
  grid.addEventListener('click', (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('.home-day[data-index]');
    if (!target || !grid.contains(target)) return;
    setActive(Number(target.dataset.index));
    const cell = cells[activeIndex];
    if (cell) onActivate(cell);
  });
  return { grid, weeks };
}

export function mountHomeActivity(host: HTMLElement, workspace: string, isCurrent: () => boolean,
  openFile: (path: string, workspace: string) => void, openChat: (id: string) => void,
  hasChat: (id: string) => boolean): () => void {
  let source: ActivitySource = 'all';
  let count = 365;
  let generation = 0;
  let disposed = false;
  let lastData: CodeActivity | null = null;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const header = text('div', '', 'home-section-heading');
  header.append(text('h2', 'AI code edits'));
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Edit source');
  for (const [value, label] of [['all', 'All AI'], ['completions', 'Completions'], ['agent', 'Agent']]) {
    select.add(new Option(label, value));
  }
  const range = document.createElement('select'); range.setAttribute('aria-label', 'Activity period');
  range.add(new Option('Past 12 months', '365')); range.add(new Option('Past 90 days', '90')); range.add(new Option('Past 30 days', '30'));
  const controls = text('div', '', 'home-actions'); controls.append(select, range); header.append(controls);
  const body = text('div', 'Loading code activity…', 'home-activity-body');
  const detail = text('div', '', 'home-activity-detail'); detail.setAttribute('aria-live', 'polite');
  const note = text('p', 'Applied additions + deletions, including repeated edits. Accepted editor suggestions and file-tool edits only; shell commands and external edits are excluded. Days use UTC.', 'home-muted');
  host.replaceChildren(header, body, detail, note);

  async function showDay(day: string) {
    const version = ++generation;
    detail.textContent = `Loading ${day}…`;
    try {
      const data = await fetchCodeActivity(workspace, source, day);
      if (disposed || !isCurrent() || version !== generation) return;
      detail.replaceChildren(text('h3', `${day} · most recent 100 edits`));
      if (!data.events.length) detail.append(text('p', 'No recorded edits on this day.', 'home-muted'));
      for (const event of data.events) {
        const row = text('div', '', 'home-activity-event');
        row.append(text('span', `+${event.additions} −${event.deletions} · ${event.source === 'agent' ? 'Agent' : 'Completions'}`, 'home-mono'));
        for (const path of event.paths) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = path;
          button.addEventListener('click', () => openFile(path, event.workspace)); row.append(button);
        }
        // Older board edits recorded the board id, and chats can be deleted since.
        if (event.chatId && hasChat(event.chatId)) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Open chat';
          button.addEventListener('click', () => openChat(event.chatId!)); row.append(button);
        }
        detail.append(row);
      }
    } catch { if (isCurrent() && !disposed && version === generation) detail.textContent = 'Could not load this day. Select the day to retry.'; }
  }

  function render(data: CodeActivity) {
    const cells = activityCalendar(data, count);
    const summary = activitySummary(cells);
    body.replaceChildren();
    body.append(text('p', `${summary.total.toLocaleString()} edited lines · ${summary.active} active ${summary.active === 1 ? 'day' : 'days'}`, 'home-activity-total home-mono'));
    const scroll = text('div', '', 'home-calendar-scroll');
    const { grid, weeks } = createHomeActivityGrid(cells, cell => {
      if (cell.tracked) void showDay(cell.day);
      else detail.textContent = `${cell.day}: activity was not tracked yet.`;
    });
    // Square cells: the stylesheet derives both track sizes from the week count. Short ranges
    // get a bigger cap so a 30-day grid is not a thumbnail in a full-width card.
    // Set on the card so the wide two-column layout can size the calendar column from them too.
    host.style.setProperty('--home-weeks', String(weeks));
    host.style.setProperty('--home-cell-max', weeks > 30 ? '28px' : weeks > 10 ? '34px' : '44px');
    scroll.append(grid); body.append(scroll);
    // A phone shows about half the year; open on the recent end, not last September.
    if (isNarrowLayout()) scroll.scrollLeft = scroll.scrollWidth;
    const legend = text('div', '', 'home-legend'); legend.append(text('span', 'Fewer'));
    for (let i = 0; i <= 4; i++) { const dot = text('span', '', 'home-day'); dot.dataset.level = String(i); legend.append(dot); }
    legend.append(text('span', 'More'), text('span', `Tracking since ${data.trackingSince.slice(0, 10)}`)); body.append(legend);
    const stats = text('dl', '', 'home-activity-stats');
    for (const [label, value] of [['Most active month', summary.bestMonth || '—'], ['Most active day', summary.bestDay || '—'], ['Longest streak', `${summary.longest} days`], ['Current streak', `${summary.current} days`]]) {
      const item = text('div', ''); item.append(text('dt', label), text('dd', value)); stats.append(item);
    }
    body.append(stats);
    const accessible = document.createElement('details'); accessible.append(text('summary', 'Daily activity list'));
    for (const cell of cells.filter(c => c.additions + c.deletions > 0).reverse()) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'home-row';
      button.textContent = `${cell.day} · +${cell.additions} −${cell.deletions}`;
      button.addEventListener('click', () => void showDay(cell.day)); accessible.append(button);
    }
    if (!summary.active) accessible.append(text('p', 'No recorded edits in this period. Accepted suggestions and applied agent file edits appear here.', 'home-muted'));
    body.append(accessible);
  }
  async function load() {
    const version = ++generation;
    detail.replaceChildren();
    try {
      const data = await fetchCodeActivity(workspace, source);
      if (disposed || !isCurrent() || version !== generation) return;
      lastData = data; render(data);
    } catch {
      if (disposed || !isCurrent() || version !== generation) return;
      body.replaceChildren(text('p', 'Code activity is unavailable.', 'home-muted'));
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.onclick = () => void load(); body.append(retry);
    }
  }
  async function refreshActivity() {
    if (!disposed && isCurrent() && !document.hidden) {
      try {
        const selectedSource = source;
        const data = await fetchCodeActivity(workspace, selectedSource);
        if (!disposed && isCurrent() && source === selectedSource && JSON.stringify(data) !== JSON.stringify(lastData)) {
          // Avoid replacing the keyboard user's calendar while it has focus.
          if (!body.contains(document.activeElement)) { lastData = data; render(data); }
        }
      } catch { /* Explicit Refresh remains available; preserve the last successful view. */ }
    }
    if (!disposed) poll = setTimeout(() => void refreshActivity(), 30000);
  }
  select.onchange = () => { source = select.value as ActivitySource; void load(); };
  range.onchange = () => { count = Number(range.value); if (lastData) render(lastData); };
  void load();
  poll = setTimeout(() => void refreshActivity(), 30000);
  return () => { disposed = true; generation++; clearTimeout(poll); };
}
