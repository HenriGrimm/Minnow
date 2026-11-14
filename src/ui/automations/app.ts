/**
 * Automations app: the running-agents hub, preset gallery, setup and run views.
 * Mounted into the Scheduler app's page (app id `scheduler`, shown as Automations).
 */

import {
  fetchAutomationsOverview,
  retryPrReviewPull,
  retryWatchedGithubIssue,
  startAutomation,
  updateSchedulerJob,
  type AutomationActivity,
  type AutomationJob,
  type AutomationLiveRun,
  type AutomationsOverview,
} from '../../scheduler/client';
import { AUTOMATION_PRESETS, getAutomationPreset, type AutomationPreset } from '../../lib/automation-presets.mjs';
import { describeAnySchedule } from '../../lib/natural-schedule.mjs';
import { isLocalServerAvailable } from '../../tools/config';
import {
  button, clockTime, el, elapsedText, enter, icon, liveDot, renderTicks, setStreamingText, streamingText, toggleSwitch, untilText, workspaceBasename,
} from './dom';
import { renderJobView, type JobViewHandle } from './job-view';
import { renderSetupView, type SetupDraft } from './setup-view';

export interface AutomationsChrome {
  summary: HTMLElement | null;
  controls: HTMLElement | null;
  addButton: HTMLButtonElement | null;
  notify: (state: 'ok' | 'err', message: string) => void;
}

type View =
  | { name: 'hub' }
  | { name: 'job'; jobId: string; runId?: string }
  | { name: 'gallery' }
  | { name: 'setup'; presetId: string; jobId?: string; draft?: SetupDraft };

export interface AutomationsApp {
  refresh(): Promise<void>;
  openGallery(): void;
  dispose(): void;
}

const FAST_POLL_MS = 2000;
const SLOW_POLL_MS = 8000;

export function presetFor(job: Pick<AutomationJob, 'preset' | 'githubWatch'>): AutomationPreset | null {
  if (job.preset?.id) return getAutomationPreset(job.preset.id);
  if (job.githubWatch) return getAutomationPreset('issue-watch');
  return null;
}

export function jobIcon(job: Pick<AutomationJob, 'preset' | 'githubWatch'>): string {
  return presetFor(job)?.icon ?? 'automations';
}

export function jobSubtitle(job: AutomationJob): string {
  const repo = job.preset?.config?.repository || job.githubWatch?.repository;
  if (repo && job.githubWatch) return `${repo} · label: minnow`;
  if (repo) return repo;
  return job.workspacePath ? workspaceBasename(job.workspacePath) : 'Scheduler workspace';
}

export function triggerText(job: Pick<AutomationJob, 'schedule' | 'preset' | 'githubWatch'>): string {
  const preset = presetFor(job);
  const when = describeAnySchedule(job.schedule);
  if (preset?.id === 'pr-review') return `New or updated PRs · ${when.toLowerCase()}`;
  if (preset?.id === 'issue-watch') return `Labeled issues · ${when.toLowerCase()}`;
  return when;
}

function nextText(job: AutomationJob): { text: string; tone: string } {
  if (job.live || job.running) return { text: 'Running', tone: 'run' };
  if (!job.enabled) return { text: 'Paused', tone: 'idle' };
  if (job.schedule.kind === 'manual') return { text: 'Manual', tone: 'idle' };
  return { text: untilText(job.nextRunAt) || '—', tone: 'idle' };
}

function jobTone(job: AutomationJob): 'run' | 'ok' | 'fail' | 'warn' | 'idle' {
  if (job.live || job.running) return 'run';
  if (!job.enabled) return 'idle';
  if (job.attention) return job.attention.kind === 'run' ? 'fail' : 'warn';
  return 'ok';
}

export function mountAutomationsApp(mount: HTMLElement, chrome: AutomationsChrome): AutomationsApp {
  let view: View = { name: 'hub' };
  let overview: AutomationsOverview | null = null;
  let pollTimer: number | undefined;
  let clockTimer: number | undefined;
  let disposed = false;
  let filter: 'all' | 'running' | 'paused' = 'all';
  let hub: ReturnType<typeof createHub> | null = null;
  let jobView: JobViewHandle | null = null;
  let viewCleanup: (() => void) | null = null;
  let loadError: string | null = null;

  mount.replaceChildren();
  mount.classList.add('auto-root');

  const filterSeg = el('div', 'auto-seg');
  filterSeg.setAttribute('role', 'group');
  filterSeg.setAttribute('aria-label', 'Show automations');
  const filterButtons = (['all', 'running', 'paused'] as const).map((value) => {
    const b = el('button', undefined, value === 'all' ? 'All' : value === 'running' ? 'Running' : 'Paused');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(filter === value));
    b.addEventListener('click', () => {
      filter = value;
      for (const other of filterButtons) other.setAttribute('aria-pressed', String(other === b));
      hub?.applyFilter();
    });
    return b;
  });
  filterSeg.append(...filterButtons);
  if (chrome.controls) {
    chrome.controls.querySelector('.auto-seg')?.remove();
    chrome.controls.prepend(filterSeg);
  }
  if (chrome.addButton) {
    chrome.addButton.replaceChildren(icon('plus', 15), el('span', undefined, 'New automation'));
    chrome.addButton.onclick = () => navigate({ name: 'gallery' });
  }

  function updateChrome(): void {
    const onHub = view.name === 'hub';
    filterSeg.hidden = !onHub || !overview?.jobs.length;
    if (chrome.addButton) chrome.addButton.hidden = view.name === 'setup' || view.name === 'gallery';
    if (!chrome.summary) return;
    if (!overview) { chrome.summary.textContent = loadError ? 'Tool server offline' : '—'; return; }
    const running = overview.jobs.filter((job) => job.live || job.running).length;
    const needs = overview.jobs.filter((job) => job.attention).length;
    const parts = [];
    if (running) parts.push(`${running} running`);
    if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`);
    parts.push(`${overview.jobs.length} automation${overview.jobs.length === 1 ? '' : 's'}`);
    chrome.summary.textContent = overview.jobs.length ? parts.join(' · ') : 'Agents that run on their own while Minnow is open';
  }

  function teardownView(): void {
    viewCleanup?.();
    viewCleanup = null;
    jobView = null;
    hub = null;
  }

  function navigate(next: View): void {
    teardownView();
    view = next;
    mount.replaceChildren();
    mount.scrollTop = 0;
    if (next.name === 'hub') {
      hub = createHub();
      mount.append(hub.root);
      if (overview) hub.update(overview);
    } else if (next.name === 'gallery') {
      mount.append(renderGallery({
        onPick: (presetId, draft) => navigate({ name: 'setup', presetId, draft }),
        onBack: () => navigate({ name: 'hub' }),
      }));
    } else if (next.name === 'setup') {
      const existing = next.jobId ? overview?.jobs.find((job) => job.id === next.jobId) : undefined;
      const handle = renderSetupView({
        presetId: next.presetId,
        jobId: next.jobId,
        existingJob: existing,
        draft: next.draft,
        notify: chrome.notify,
        onCancel: () => navigate(next.jobId ? { name: 'job', jobId: next.jobId } : { name: 'gallery' }),
        onBack: () => navigate({ name: 'hub' }),
        onSaved: async (jobId, runId) => {
          await poll();
          navigate({ name: 'job', jobId, runId: runId ?? undefined });
        },
      });
      mount.append(handle.root);
      viewCleanup = handle.dispose;
    } else if (next.name === 'job') {
      const job = overview?.jobs.find((row) => row.id === next.jobId);
      if (!job) { navigate({ name: 'hub' }); return; }
      jobView = renderJobView({
        job,
        runId: next.runId,
        notify: chrome.notify,
        onBack: () => navigate({ name: 'hub' }),
        onEdit: () => navigate({ name: 'setup', presetId: presetFor(job)?.id ?? 'custom', jobId: job.id }),
        onDeleted: async () => { await poll(); navigate({ name: 'hub' }); },
        onChanged: () => void poll(),
      });
      mount.append(jobView.root);
      viewCleanup = jobView.dispose;
    }
    updateChrome();
    schedulePoll(0);
  }

  // ---------- hub ----------

  function createHub() {
    const root = el('div', 'auto-hub');
    const main = el('div', 'auto-hub__main');
    const aside = el('aside', 'auto-hub__aside');
    root.append(main, aside);

    const section = (title: string) => {
      const node = el('section', 'auto-section');
      const head = el('div', 'auto-section__head');
      const count = el('span', 'auto-section__count');
      head.append(el('h2', undefined, title), count);
      const body = el('div', 'auto-section__body');
      node.append(head, body);
      return { node, body, count };
    };

    const needs = section('Needs you');
    needs.body.classList.add('auto-attn-list');
    const running = section('Running now');
    running.body.classList.add('auto-run-grid');
    const all = section('All automations');
    const table = el('div', 'auto-table');
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Automations');
    const head = el('div', 'auto-row auto-row--head');
    head.setAttribute('role', 'row');
    for (const label of ['Automation', 'Runs when', 'Last 20 runs', 'Next', 'On']) {
      const cell = el('span', undefined, label);
      cell.setAttribute('role', 'columnheader');
      head.append(cell);
    }
    table.append(head);
    const tableScroll = el('div', 'auto-table-scroll');
    tableScroll.append(table);
    const note = el('p', 'auto-note', 'Automations run while Minnow is open, including when it is hidden in the tray. Missed runs are not replayed.');
    all.body.append(tableScroll, note);

    const empty = el('div', 'auto-empty');
    main.append(empty, needs.node, running.node, all.node);

    const activityHead = el('div', 'auto-section__head');
    activityHead.append(el('h2', undefined, 'Activity'), el('span', 'auto-section__count', 'today'));
    const feed = el('ol', 'auto-feed');
    aside.append(activityHead, feed);

    const attentionCards = new Map<string, { node: HTMLElement; update: (job: AutomationJob) => void }>();
    const runCards = new Map<string, { node: HTMLElement; update: (job: AutomationJob, run: AutomationLiveRun) => void }>();
    const rows = new Map<string, { node: HTMLElement; job: AutomationJob; update: (job: AutomationJob) => void }>();
    const seenActivity = new Set<string>();
    let firstPaint = true;

    function renderEmpty(): void {
      empty.replaceChildren();
      const art = el('div', 'auto-empty__mark');
      art.append(icon('automations', 22));
      empty.append(art, el('h2', 'auto-empty__title', 'Nothing runs on its own yet'),
        el('p', 'auto-empty__text', 'Start from a preset or describe your own. Each automation is an agent that wakes up on a schedule, does its job, and reports back here.'));
      const picks = el('div', 'auto-empty__picks');
      for (const preset of AUTOMATION_PRESETS.slice(0, 3)) {
        const pick = el('button', 'auto-pick');
        pick.type = 'button';
        pick.append(icon(preset.icon, 15), el('span', undefined, preset.name));
        pick.addEventListener('click', () => navigate({ name: 'setup', presetId: preset.id }));
        picks.append(pick);
      }
      const browse = button('Browse presets', { variant: 'primary' });
      browse.addEventListener('click', () => navigate({ name: 'gallery' }));
      picks.append(browse);
      empty.append(picks);
    }

    function attentionCard(job: AutomationJob) {
      const node = el('div', 'auto-attn');
      const mark = el('span', 'auto-attn__icon');
      mark.append(icon('warning', 15));
      const body = el('div', 'auto-attn__body');
      const title = el('div', 'auto-attn__title');
      const text = el('div', 'auto-attn__text');
      body.append(title, text);
      const actions = el('div', 'auto-attn__actions');
      const open = button('Open', { small: true });
      const retry = button('Retry', { small: true, variant: 'ghost' });
      actions.append(open, retry);
      node.append(mark, body, actions);
      let current = job;
      open.addEventListener('click', () => navigate({ name: 'job', jobId: current.id, runId: current.attention?.runId }));
      retry.addEventListener('click', () => {
        void (async () => {
          retry.disabled = true;
          try {
            const a = current.attention;
            if (a?.kind === 'pr' && a.number) await retryPrReviewPull(current.id, a.number);
            if (a?.kind === 'issue' && a.number) await retryWatchedGithubIssue(current.id, a.number);
            const started = await startAutomation(current.id);
            chrome.notify('ok', started.started ? `${current.label} started` : `${current.label} will retry on its next run`);
            await poll();
          } catch (error) {
            chrome.notify('err', error instanceof Error ? error.message : String(error));
          } finally {
            retry.disabled = false;
          }
        })();
      });
      const update = (next: AutomationJob) => {
        current = next;
        const a = next.attention!;
        title.replaceChildren(el('b', undefined, next.label));
        if (a.number) title.append(el('span', 'auto-muted', ` · ${a.kind === 'pr' ? '#' : 'Issue #'}${a.number}${a.title ? ` ${a.title}` : ''}`));
        text.textContent = a.text;
      };
      update(job);
      return { node, update };
    }

    function runCard(job: AutomationJob, run: AutomationLiveRun) {
      const node = el('button', 'auto-run');
      node.type = 'button';
      const top = el('div', 'auto-run__top');
      const ico = el('span', 'auto-ico');
      ico.append(icon(jobIcon(job), 15));
      const names = el('div', 'auto-run__names');
      const name = el('div', 'auto-run__name');
      const sub = el('div', 'auto-run__sub');
      names.append(name, sub);
      const timer = el('span', 'auto-run__timer');
      const elapsed = el('span', 'auto-elapsed');
      elapsed.dataset.since = run.startedAt;
      timer.append(liveDot('run'), elapsed);
      top.append(ico, names, timer);
      const focus = el('div', 'auto-run__focus');
      const agents = el('div', 'auto-run__agents');
      const step = streamingText('div', 'auto-run__step', run.step || 'Starting');
      const bar = el('div', 'auto-bar');
      bar.append(el('i'));
      node.append(top, focus, agents, step, bar);
      node.addEventListener('click', () => navigate({ name: 'job', jobId: job.id, runId: run.runId }));
      const update = (nextJob: AutomationJob, nextRun: AutomationLiveRun) => {
        name.textContent = nextJob.label;
        sub.textContent = jobSubtitle(nextJob);
        elapsed.dataset.since = nextRun.startedAt;
        elapsed.textContent = elapsedText(nextRun.startedAt);
        const f = nextRun.focus;
        focus.replaceChildren();
        if (f) {
          focus.append(el('span', 'auto-mono auto-muted', `#${f.number}`), document.createTextNode(` ${f.title}`));
        } else {
          focus.textContent = nextRun.headline || nextRun.brief || triggerText(nextJob);
        }
        agents.replaceChildren(...nextRun.children.map((child) => {
          const done = child.status !== 'running';
          const c = el('span', `auto-chip${done ? (child.status === 'completed' ? ' auto-chip--ok' : ' auto-chip--fail') : ''}`);
          c.append(done ? icon(child.status === 'completed' ? 'check' : 'close', 11) : liveDot('run', true), el('span', undefined, child.roleLabel ?? child.label));
          return c;
        }));
        agents.hidden = nextRun.children.length === 0;
        const activeChild = nextRun.children.find((child) => child.status === 'running');
        const stepText = activeChild ? `${(activeChild.roleLabel ?? '').toLowerCase()} › ${activeChild.step}` : nextRun.step || 'Starting';
        setStreamingText(step, stepText);
        node.setAttribute('aria-label', `${nextJob.label}, running for ${elapsed.textContent}. ${stepText}`);
      };
      update(job, run);
      return { node, update };
    }

    function tableRow(job: AutomationJob) {
      const node = el('div', 'auto-row');
      node.setAttribute('role', 'row');
      node.tabIndex = 0;
      const nameCell = el('span', 'auto-row__name');
      nameCell.setAttribute('role', 'cell');
      const dot = el('span');
      const titles = el('span', 'auto-row__titles');
      const name = el('span', 'auto-row__label');
      const sub = el('span', 'auto-row__sub');
      titles.append(name, sub);
      nameCell.append(dot, titles);
      const trigger = el('span', 'auto-row__trigger');
      trigger.setAttribute('role', 'cell');
      const ticks = el('span', 'auto-ticks');
      ticks.setAttribute('role', 'cell');
      const next = el('span', 'auto-row__next');
      next.setAttribute('role', 'cell');
      const switchCell = el('span', 'auto-row__switch');
      switchCell.setAttribute('role', 'cell');
      let current = job;
      const sw = toggleSwitch(`Enable ${job.label}`, job.enabled, (on) => {
        void (async () => {
          try {
            await updateSchedulerJob(current.id, { enabled: on });
            chrome.notify('ok', on ? `${current.label} is on` : `${current.label} is paused`);
            await poll();
          } catch (error) {
            chrome.notify('err', error instanceof Error ? error.message : String(error));
            sw.setAttribute('aria-checked', String(!on));
            sw.classList.toggle('is-on', !on);
          }
        })();
      });
      switchCell.append(sw);
      node.append(nameCell, trigger, ticks, next, switchCell);
      const open = () => navigate({ name: 'job', jobId: current.id });
      node.addEventListener('click', open);
      node.addEventListener('keydown', (event) => {
        if (event.target === node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); }
      });
      const seenRuns = new Set<string>();
      const update = (nextJob: AutomationJob) => {
        current = nextJob;
        dot.replaceChildren(liveDot(jobTone(nextJob)));
        name.textContent = nextJob.label;
        sub.textContent = jobSubtitle(nextJob);
        trigger.textContent = triggerText(nextJob);
        renderTicks(ticks, nextJob.recentRuns.filter((run) => run.status !== 'running' || nextJob.live?.runId === run.id), seenRuns);
        const n = nextText(nextJob);
        next.textContent = n.text;
        next.className = `auto-row__next auto-row__next--${n.tone}`;
        node.classList.toggle('is-off', !nextJob.enabled);
        if (sw.getAttribute('aria-checked') !== String(nextJob.enabled)) {
          sw.setAttribute('aria-checked', String(nextJob.enabled));
          sw.classList.toggle('is-on', nextJob.enabled);
        }
        node.setAttribute('aria-label', `${nextJob.label}. ${triggerText(nextJob)}. ${n.text}`);
      };
      update(job);
      return { node, job, update };
    }

    function reconcile<T extends { node: HTMLElement }>(
      parent: HTMLElement, map: Map<string, T>, items: { key: string; create: () => T; update: (entry: T) => void }[], after?: HTMLElement,
    ): void {
      const keep = new Set(items.map((item) => item.key));
      for (const [key, entry] of map) {
        if (!keep.has(key)) { entry.node.classList.add('auto-leave'); const n = entry.node; window.setTimeout(() => n.remove(), 180); map.delete(key); }
      }
      let anchor: Element | null = after ?? null;
      items.forEach((item, index) => {
        let entry = map.get(item.key);
        if (!entry) {
          entry = item.create();
          map.set(item.key, entry);
          enter(entry.node, firstPaint ? index * 40 : 0);
        } else {
          item.update(entry);
        }
        const expected = anchor ? anchor.nextElementSibling : parent.firstElementChild;
        if (expected !== entry.node) {
          if (anchor) anchor.after(entry.node); else parent.prepend(entry.node);
        }
        anchor = entry.node;
      });
    }

    function applyFilter(): void {
      for (const { node, job } of rows.values()) {
        const live = Boolean(job.live || job.running);
        node.hidden = filter === 'running' ? !live : filter === 'paused' ? job.enabled : false;
      }
    }

    function update(data: AutomationsOverview): void {
      const jobs = data.jobs;
      const isEmpty = jobs.length === 0;
      empty.hidden = !isEmpty;
      if (isEmpty && !empty.childElementCount) renderEmpty();
      aside.hidden = isEmpty;
      root.classList.toggle('is-empty', isEmpty);
      all.node.hidden = isEmpty;

      const attention = jobs.filter((job) => job.attention);
      needs.node.hidden = attention.length === 0;
      needs.count.textContent = String(attention.length);
      reconcile(needs.body, attentionCards, attention.map((job) => ({
        key: job.id, create: () => attentionCard(job), update: (entry) => entry.update(job),
      })));

      const live = jobs.filter((job) => job.live).map((job) => ({ job, run: job.live! }));
      running.node.hidden = live.length === 0;
      running.count.textContent = String(live.length);
      reconcile(running.body, runCards, live.map(({ job, run }) => ({
        key: run.runId, create: () => runCard(job, run), update: (entry) => entry.update(job, run),
      })));

      reconcile(table, rows, jobs.map((job) => ({
        key: job.id,
        create: () => tableRow(job),
        update: (entry) => { entry.job = job; entry.update(job); },
      })), head);
      applyFilter();

      renderFeed(data.activity);
      firstPaint = false;
    }

    function renderFeed(events: AutomationActivity[]): void {
      const items = events.slice(0, 30).map((event, index) => {
        const item = el('li', 'auto-ev');
        const b = el('button', 'auto-ev__btn');
        b.type = 'button';
        const tone = event.tone === 'skip' ? 'skip' : event.tone;
        b.append(el('span', 'auto-ev__time', clockTime(event.at)), liveDot(tone === 'run' ? 'ok' : tone as 'ok'), el('span', 'auto-ev__text', event.text));
        b.addEventListener('click', () => {
          if (overview?.jobs.some((job) => job.id === event.jobId)) navigate({ name: 'job', jobId: event.jobId, runId: event.runId });
        });
        item.append(b);
        if (seenActivity.size && !seenActivity.has(event.id)) enter(item, index * 30);
        return item;
      });
      for (const event of events) seenActivity.add(event.id);
      if (!items.length) {
        const none = el('li', 'auto-feed__empty', 'Claims, merges, failures and finished runs show up here.');
        feed.replaceChildren(none);
      } else {
        feed.replaceChildren(...items);
      }
    }

    return { root, update, applyFilter };
  }

  // ---------- polling ----------

  function anyRunning(): boolean {
    return Boolean(overview?.jobs.some((job) => job.live || job.running));
  }

  function schedulePoll(delay?: number): void {
    if (disposed) return;
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => { void poll(); }, delay ?? (anyRunning() ? FAST_POLL_MS : SLOW_POLL_MS));
  }

  async function poll(): Promise<void> {
    if (disposed) return;
    if (pollTimer) { window.clearTimeout(pollTimer); pollTimer = undefined; }
    if (!mount.isConnected || document.hidden) { schedulePoll(SLOW_POLL_MS); return; }
    if (!isLocalServerAvailable()) {
      loadError = 'offline';
      renderOffline();
      updateChrome();
      schedulePoll(SLOW_POLL_MS);
      return;
    }
    try {
      overview = await fetchAutomationsOverview();
      loadError = null;
      if (view.name === 'hub') hub?.update(overview);
      if (view.name === 'job') {
        const job = overview.jobs.find((row) => row.id === (view as { jobId: string }).jobId);
        if (job) jobView?.update(job);
      }
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
    updateChrome();
    schedulePoll();
  }

  function renderOffline(): void {
    if (view.name !== 'hub' || mount.querySelector('.auto-offline')) return;
    const node = el('div', 'auto-offline');
    node.append(el('p', 'auto-offline__title', 'Tool server offline'), el('p', 'auto-offline__text', 'Open Minnow to create and manage automations.'));
    mount.replaceChildren(node);
  }

  clockTimer = window.setInterval(() => {
    for (const node of mount.querySelectorAll<HTMLElement>('.auto-elapsed[data-since]')) {
      node.textContent = elapsedText(node.dataset.since!);
    }
  }, 1000);

  const onVisible = () => { if (!document.hidden) schedulePoll(0); };
  document.addEventListener('visibilitychange', onVisible);

  navigate({ name: 'hub' });

  return {
    async refresh() { await poll(); },
    openGallery() { navigate({ name: 'gallery' }); },
    dispose() {
      disposed = true;
      teardownView();
      if (pollTimer) window.clearTimeout(pollTimer);
      if (clockTimer) window.clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', onVisible);
      filterSeg.remove();
    },
  };
}

// ---------- gallery ----------

const DESCRIBE_SUGGESTIONS = ['When a PR opens, ', 'Every night at 2, ', 'Every weekday at 9, '];

function renderGallery(options: { onPick: (presetId: string, draft?: SetupDraft) => void; onBack: () => void }): HTMLElement {
  const root = el('div', 'auto-gallery');
  const crumbs = el('nav', 'auto-crumbs');
  crumbs.setAttribute('aria-label', 'Breadcrumb');
  const back = el('button', 'auto-crumbs__link', 'Automations');
  back.type = 'button';
  back.addEventListener('click', options.onBack);
  crumbs.append(back, el('span', 'auto-crumbs__sep', '/'), el('span', 'auto-crumbs__here', 'New automation'));

  const wrap = el('div', 'auto-gallery__wrap');
  const title = el('h1', 'auto-display', 'What should run on its own?');
  const lede = el('p', 'auto-lede', 'Describe it and Minnow drafts the setup, or start from a preset.');
  const composer = el('div', 'auto-composer');
  const label = el('label', 'auto-sr', 'Describe an automation');
  const area = el('textarea', 'auto-composer__input');
  area.id = 'automationDescribe';
  label.htmlFor = area.id;
  area.rows = 2;
  area.placeholder = 'Every weekday at 9, summarize what merged yesterday into a Brain page';
  const bar = el('div', 'auto-composer__bar');
  for (const text of DESCRIBE_SUGGESTIONS) {
    const s = el('button', 'auto-suggest', text.replace(/, $/, '…'));
    s.type = 'button';
    s.addEventListener('click', () => {
      area.value = text + area.value.replace(/^(When a PR opens|Every night at 2|Every weekday at 9),\s*/i, '');
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
    bar.append(s);
  }
  bar.append(el('span', 'auto-spacer'));
  const draft = button('Draft setup', { variant: 'primary' });
  const submit = () => {
    const text = area.value.trim();
    if (!text) { area.focus(); return; }
    if (/^when a (pr|pull request) (opens|is opened)/i.test(text)) {
      options.onPick('pr-review', { guidance: text.replace(/^when a (pr|pull request) (opens|is opened),?\s*/i, '') });
      return;
    }
    options.onPick('custom', draftFromDescription(text));
  };
  draft.addEventListener('click', submit);
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
  });
  bar.append(draft);
  composer.append(label, area, bar);
  wrap.append(title, lede, composer);

  const groups: { title: string; group: 'github' | 'workspace' }[] = [
    { title: 'GitHub', group: 'github' },
    { title: 'Workspace', group: 'workspace' },
  ];
  let delay = 0;
  for (const { title: groupTitle, group } of groups) {
    wrap.append(el('h2', 'auto-gallery__group', groupTitle));
    const grid = el('div', 'auto-preset-grid');
    if (group === 'workspace') grid.append(presetCard(null, () => options.onPick('custom'), (delay += 40)));
    for (const preset of AUTOMATION_PRESETS.filter((p) => p.group === group)) {
      grid.append(presetCard(preset, () => options.onPick(preset.id), (delay += 40)));
    }
    wrap.append(grid);
  }
  root.append(crumbs, wrap);
  window.setTimeout(() => area.focus(), 0);
  return root;
}

function presetCard(preset: AutomationPreset | null, onPick: () => void, delayMs: number): HTMLElement {
  const card = el('button', `auto-preset${preset ? '' : ' auto-preset--custom'}`);
  card.type = 'button';
  const top = el('div', 'auto-preset__top');
  const ico = el('span', 'auto-ico auto-ico--lg');
  ico.append(icon(preset?.icon ?? 'plus', 17));
  top.append(ico, icon('chevronRight', 16, 'auto-preset__go'));
  const name = el('h3', 'auto-preset__name', preset?.name ?? 'Custom');
  const text = el('p', 'auto-preset__text', preset?.summary ?? 'Your own instructions on a schedule, or only when you run it.');
  const meta = el('div', 'auto-preset__meta');
  meta.append(el('span', undefined, preset?.trigger ?? 'Any schedule'));
  for (const can of preset?.can ?? []) meta.append(el('span', 'auto-can', can));
  card.append(top, name, text, meta);
  card.addEventListener('click', onPick);
  return enter(card, delayMs);
}

/** Pull a schedule phrase out of a description: "Every weekday at 9, do X". */
export function draftFromDescription(text: string): SetupDraft {
  const match = /^((?:every|each|daily|weekly|hourly|weekdays?|weekends?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|nightly|at)\b[^,.:]*?)[,:.]\s*(.+)$/is.exec(text.trim());
  const scheduleText = match?.[1]?.trim();
  const body = (match?.[2] ?? text).trim();
  const prompt = body.charAt(0).toUpperCase() + body.slice(1);
  const first = prompt.split(/[.\n]/)[0].replace(/^(please\s+)/i, '').trim();
  // A short name at a word boundary, without a dangling connective.
  const words: string[] = [];
  for (const word of first.split(/\s+/)) {
    if ([...words, word].join(' ').length > 44) break;
    words.push(word);
  }
  while (words.length > 2 && /^(since|and|to|of|for|the|in|into|with|a|an|on|at|from|that)$/i.test(words.at(-1)!)) words.pop();
  const label = words.join(' ') || first.slice(0, 44);
  return { label: label.charAt(0).toUpperCase() + label.slice(1), prompt, scheduleText };
}
