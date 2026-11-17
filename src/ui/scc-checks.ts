import {
  forgeRefresh,
  runCancel,
  runList,
  runLog,
  runRerun,
  runState,
  runView,
  type ForgeStatus,
  type WorkflowJob,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
} from '../state/forge-api';
import { select as selectField } from './scc-action-form';
import { createIcon } from './icon';
import { gitUiCtx, runGitUiOp } from './git-ui-op';
import {
  button,
  chip,
  detailHead,
  drillIn,
  duration,
  el,
  emptyState,
  errorStrip,
  listNavigator,
  relativeTime,
  runStateTone,
  searchBox,
  segmented,
  skeletonRows,
  stateDot,
  stateLabel,
  statePill,
  forgeUnavailableCopy,
  unavailableState,
  type RunState,
  type SccContext,
  type SccView,
} from './scc-shared';

/** Newest run per workflow — shared with the shell for rail badges before Checks is opened. */
export function rollupChecksRailState(runs: WorkflowRunSummary[]): RunState {
  const newest = new Map<string, WorkflowRunSummary>();
  for (const run of runs) {
    if (!newest.has(run.workflow)) newest.set(run.workflow, run);
  }
  const states = [...newest.values()].map((run) => runState(run) as RunState);
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (states.includes('success')) return 'success';
  return 'none';
}

export function createChecksView(
  ctx: SccContext,
  options: { getForgeStatus: () => ForgeStatus | null },
): SccView {
  const root = el('div', 'scc-split');
  const drill = drillIn(root);

  const listCol = el('div', 'scc-split__list');
  const toolbar = el('div', 'scc-split__filters');
  const listBody = el('div', 'scc-split__list-body');
  const foot = el('div', 'scc-split__foot');
  listCol.append(toolbar, listBody, foot);

  const detailCol = el('div', 'scc-split__detail');
  root.append(listCol, detailCol);

  let destroyed = false;
  let branchOnly = true;
  let selectedId: number | null = null;
  const jobExpansion = new Map<number, boolean>();
  const jobLogs = new Map<number, { host: HTMLElement; trigger: HTMLButtonElement }>();
  let cache: WorkflowRunSummary[] = [];
  let page = 1;
  let requestGeneration = 0;
  let detailRequest = 0;
  let workspace = ctx.getCwd();
  const details = new Map<number, WorkflowRunDetail>();
  const pendingDetails = new Map<number, ReturnType<typeof runView>>();
  const workflowSearch = searchBox('Workflow file or ID', 'Workflow filename or ID');
  const workflowFilter = workflowSearch.input;
  const statusFilter = selectField('Run status', ['', 'queued', 'in_progress', 'success', 'failure', 'cancelled'].map(value => ({ value, label: value || 'All statuses' })));
  workflowFilter.addEventListener('change', () => { page = 1; void refresh(); });
  statusFilter.addEventListener('change', () => { page = 1; void refresh(); });
  const previous = button({ label: 'Newer', icon: 'chevronLeft', variant: 'ghost', onClick: () => { page = Math.max(1, page - 1); void refresh(); } });
  const next = button({ label: 'Older', variant: 'ghost', onClick: () => { page++; void refresh(); } });

  const branchScope = segmented<'branch' | 'all'>({
    label: 'Runs to show',
    items: [
      { value: 'branch', label: 'This branch' },
      { value: 'all', label: 'All branches' },
    ],
    value: 'branch',
    onChange: (scope) => {
      branchOnly = scope === 'branch';
      page = 1;
      void refresh();
    },
  });

  const refreshBtn = button({
    icon: 'refresh',
    title: 'Refresh runs',
    variant: 'ghost',
    onClick: () => void refresh(),
  });

  statusFilter.classList.add('scc-select');
  toolbar.append(branchScope.root, statusFilter, refreshBtn, workflowSearch.root);
  foot.append(previous, next);

  async function refresh(): Promise<void> {
    if (destroyed) return;
    const generation = ++requestGeneration;
    const cwd = ctx.getCwd();
    if (cwd !== workspace) {
      workspace = cwd;
      selectedId = null;
      details.clear();
      pendingDetails.clear();
      jobExpansion.clear();
      jobLogs.clear();
      listBody.replaceChildren();
      delete listBody.dataset.signature;
      renderDetailPlaceholder();
    }

    const status = options.getForgeStatus();
    if (status && !status.supported) {
      renderUnavailable(status);
      ctx.setBadge('checks', null);
      return;
    }

    if (listBody.childElementCount === 0) listBody.appendChild(skeletonRows(6));

    const branch = ctx.getBranch();
    const result = await runList({
      cwd: ctx.getCwd(),
      branch: branchOnly && branch ? branch : undefined,
      limit: 25,
      page,
      workflow: workflowFilter.value || undefined,
      status: statusFilter.value || undefined,
    });
    if (destroyed || generation !== requestGeneration || cwd !== ctx.getCwd()) return;
    previous.disabled = page === 1;
    next.disabled = !result.hasMore;
    previous.hidden = page === 1;
    next.hidden = !result.hasMore;

    if (!result.ok) {
      listBody.replaceChildren(errorStrip(result.error ?? 'Could not list runs', () => void refresh()));
      ctx.setBadge('checks', null);
      return;
    }

    cache = result.runs ?? [];
    ctx.setBadge('checks', cache.length ? { kind: 'state', value: rollup(cache) } : null);

    const signature = JSON.stringify(cache);
    if (listBody.dataset.signature !== signature || listBody.querySelector('.scc-error')) { renderList(result.note); listBody.dataset.signature = signature; }

    if (selectedId && cache.some((run) => run.id === selectedId)) {
      await renderDetail(selectedId);
    } else if (!selectedId && cache.length > 0) {
      await select(cache[0]!.id);
    } else if (cache.length === 0) {
      renderDetailPlaceholder();
    }
  }

  /** The newest run for each workflow decides the rail badge. */
  function rollup(runs: WorkflowRunSummary[]): RunState {
    return rollupChecksRailState(runs);
  }

  function renderUnavailable(status: ForgeStatus): void {
    toolbar.hidden = true;
    detailCol.hidden = true;
    root.classList.add('scc-split--single');

    const copy = forgeUnavailableCopy(status, 'CI');

    listBody.replaceChildren(
      unavailableState({
        ...copy,
        action: copy.hint
          ? button({
              label: 'Check again',
              variant: 'primary',
              onClick: async () => {
                await forgeRefresh(ctx.getCwd());
                toolbar.hidden = false;
                detailCol.hidden = false;
                root.classList.remove('scc-split--single');
                await ctx.refreshAll();
              },
            })
          : undefined,
      }),
    );
  }

  function renderList(note?: string): void {
    if (cache.length === 0) {
      listBody.replaceChildren(
        emptyState({
          icon: 'statusPending',
          title: note ? 'No workflows' : 'No runs yet',
          body:
            note ??
            (branchOnly
              ? `Nothing has run on ${ctx.getBranch() || 'this branch'}. Push a commit, or switch to all branches.`
              : 'Push a commit to trigger the first workflow run.'),
          action: branchOnly
            ? button({
                label: 'Show all branches',
                variant: 'ghost',
                onClick: () => {
                  branchScope.setValue('all');
                  branchOnly = false;
                  page = 1;
                  void refresh();
                },
              })
            : undefined,
        }),
      );
      return;
    }

    const frag = document.createDocumentFragment();
    for (const run of cache) frag.appendChild(buildRow(run));
    listBody.replaceChildren(frag);
  }

  function buildRow(run: WorkflowRunSummary): HTMLElement {
    const state = runState(run) as RunState;
    const row = el('div', 'scc-row scc-row--wrap scc-runrow');
    row.tabIndex = 0;
    row.dataset.id = String(run.id);
    row.setAttribute('role', 'button');
    row.setAttribute('aria-pressed', String(run.id === selectedId));
    if (run.id === selectedId) row.classList.add('is-selected');
    if (state === 'pending') row.classList.add('is-running');

    const lead = el('span', 'scc-row__lead');
    lead.appendChild(stateDot(state, `${run.workflow}: ${stateLabel(state)}`));
    const age = relativeTime(run.createdAt);
    const aside = el('span', 'scc-row__aside', age);
    aside.title = new Date(run.createdAt).toLocaleString();

    const meta = el('span', 'scc-row__meta scc-runrow__meta');
    meta.append(
      el('span', 'scc-fact scc-runrow__workflow', run.workflow),
      el('span', 'scc-fact scc-mono', run.sha.slice(0, 7)),
      el('span', 'scc-fact', run.branch),
    );
    const end = el('span', 'scc-row__end');
    if (state === 'pending' && run.startedAt) {
      end.appendChild(el('span', 'scc-runrow__elapsed', duration(run.startedAt, '')));
    } else if (run.startedAt && run.updatedAt) {
      end.appendChild(el('span', undefined, duration(run.startedAt, run.updatedAt)));
    }
    meta.appendChild(end);

    row.append(lead, el('span', 'scc-row__title scc-runrow__title', run.title), aside, meta);
    row.title = `${run.workflow}: ${stateLabel(state)}\n${run.title}\n${run.event} on ${run.branch}`;
    const activate = () => {
      drill.open();
      void select(run.id);
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
    return row;
  }

  async function select(id: number): Promise<void> {
    if (selectedId === id && detailCol.querySelector('.scc-rundetail')) return;
    selectedId = id;
    jobExpansion.clear();
    jobLogs.clear();
    delete detailCol.dataset.signature;
    const cached = details.get(id);
    const summary = cache.find(run => run.id === id);
    if (cached) {
      detailCol.replaceChildren(buildDetail(cached));
      detailCol.dataset.signature = JSON.stringify(cached);
    } else if (summary) {
      detailCol.replaceChildren(buildDetail({ ...summary, jobs: [] }, false));
    }
    detailCol.scrollTop = 0;
    for (const row of listBody.querySelectorAll('.scc-runrow')) {
      row.classList.toggle('is-selected', (row as HTMLElement).dataset.id === String(id));
      row.setAttribute('aria-pressed', String((row as HTMLElement).dataset.id === String(id)));
    }
    await renderDetail(id);
  }

  function renderDetailPlaceholder(): void {
    ++detailRequest;
    selectedId = null;
    detailCol.setAttribute('aria-busy', 'false');
    delete detailCol.dataset.signature;
    detailCol.replaceChildren(
      emptyState({
        icon: 'statusRunning',
        title: 'Select a run',
        body: 'Its jobs, steps, and failed-step logs show here.',
      }),
    );
  }

  async function renderDetail(id: number): Promise<void> {
    const request = ++detailRequest;
    const cwd = ctx.getCwd();
    if (!detailCol.querySelector('.scc-rundetail')) {
      const summary = cache.find(run => run.id === id);
      detailCol.replaceChildren(summary ? buildDetail({ ...summary, jobs: [] }, false) : skeletonRows(7));
    }
    detailCol.setAttribute('aria-busy', 'true');

    // Share a pending load across clicks and polling; keep loaded runs ready for revisits.
    let pending = pendingDetails.get(id);
    if (!pending) {
      pending = runView({ cwd, id });
      pendingDetails.set(id, pending);
    }
    const result = await pending;
    if (pendingDetails.get(id) === pending) pendingDetails.delete(id);
    if (!destroyed && cwd === ctx.getCwd() && result.ok && result.run) {
      details.delete(id);
      details.set(id, result.run);
      if (details.size > 50) details.delete(details.keys().next().value!);
    }
    if (destroyed || selectedId !== id || request !== detailRequest || cwd !== ctx.getCwd()) return;
    detailCol.setAttribute('aria-busy', 'false');

    if (!result.ok || !result.run) {
      detailCol.replaceChildren(
        errorStrip(result.error ?? 'Could not load the run', () => void renderDetail(id)),
      );
      return;
    }

    const signature = JSON.stringify(result.run);
    if (detailCol.dataset.signature !== signature || !detailCol.querySelector('.scc-rundetail')) {
      const scroll = detailCol.scrollTop;
      detailCol.replaceChildren(buildDetail(result.run)); detailCol.dataset.signature = signature;
      detailCol.scrollTop = scroll;
    }
  }

  function buildDetail(run: WorkflowRunDetail, jobsLoaded = true): HTMLElement {
    const state = runState(run) as RunState;
    const wrap = el('div', 'scc-detail scc-rundetail');

    const actions = el('div', 'scc-rundetail__actions');
    if (state === 'pending') {
      actions.appendChild(
        button({
          label: 'Cancel run',
          className: 'scc-btn--danger-hover',
          onClick: () => void cancel(run.id),
        }),
      );
    } else {
      if (state === 'failure') {
        actions.appendChild(
          button({
            label: 'Re-run failed jobs',
            variant: 'primary',
            onClick: () => void rerun(run.id, true),
          }),
        );
      }
      actions.appendChild(
        button({ label: 'Re-run all', icon: 'refresh', onClick: () => void rerun(run.id, false) }),
      );
    }
    if (run.url) {
      const link = el('a', 'scc-btn scc-btn--ghost', 'Open on GitHub');
      link.appendChild(createIcon('externalLink', { size: 13 }));
      link.href = run.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.appendChild(link);
    }

    const facts: HTMLElement[] = [chip(run.sha, 'sha'), chip(run.branch, 'branch'), el('span', undefined, run.event)];
    if (run.startedAt) {
      facts.push(el('span', 'scc-rundetail__elapsed', `${duration(run.startedAt, state === 'pending' ? '' : run.updatedAt)}${state === 'pending' ? ' so far' : ''}`));
    }
    const head = detailHead({
      eyebrow: [statePill(stateLabel(state), runStateTone(state)), el('span', 'scc-rundetail__workflow', run.workflow)],
      title: run.title,
      titleClass: 'scc-rundetail__title',
      facts,
      actions,
      onBack: () => drill.close(),
      backLabel: 'Runs',
    });
    head.root.classList.add('scc-rundetail__head');
    wrap.appendChild(head.root);

    if (!jobsLoaded) {
      const loading = el('div', 'scc-run-loading');
      loading.setAttribute('role', 'status');
      loading.setAttribute('aria-live', 'polite');
      const wheel = el('span', 'scc-run-loading__wheel');
      wheel.setAttribute('aria-hidden', 'true');
      loading.append(wheel, el('span', undefined, 'Loading jobs…'));
      wrap.appendChild(loading);
      return wrap;
    }

    if (run.jobs.length === 0) {
      wrap.appendChild(buildNoJobsState(run, state));
      return wrap;
    }

    const jobs = el('div', 'scc-lines scc-rundetail__jobs');
    const passed = run.jobs.filter(job => runState(job) === 'success').length;
    const failed = run.jobs.filter(job => runState(job) === 'failure').length;
    const summary = el('div', 'scc-rundetail__summary');
    summary.append(el('h3', undefined, 'Jobs'), el('span', undefined, [`${run.jobs.length} total`, `${passed} passed`, ...(failed ? [`${failed} failed`] : [])].join(' · ')));
    wrap.append(summary);
    for (const job of run.jobs) jobs.appendChild(buildJob(run.id, job));
    wrap.appendChild(jobs);

    return wrap;
  }

  /** A run that reports zero jobs. */
  function buildNoJobsState(run: WorkflowRunDetail, state: RunState): HTMLElement {
    const wrap = el('div', 'scc-nojobs');

    if (state !== 'failure') {
      wrap.appendChild(
        emptyState({
          title: 'No jobs yet',
          body:
            state === 'pending'
              ? 'GitHub has not reported jobs for this run yet.'
              : 'This run finished without reporting job data.',
        }),
      );
      return wrap;
    }

    wrap.appendChild(
      emptyState({
        icon: 'statusFail',
        title: 'The workflow never started',
        body: `No job ran, so ${run.workflowPath || run.workflow} did not parse. The run log has the reason.`,
      }),
    );

    const logHost = el('div', 'scc-nojobs__log');
    const logBtn = button({
      label: 'Show run log',
      icon: 'terminal',
      variant: 'primary',
      onClick: () => void loadRunLog(run.id, logHost, logBtn),
    });

    const actions = el('div', 'scc-nojobs__actions');
    actions.appendChild(logBtn);
    wrap.append(actions, logHost);
    return wrap;
  }

  async function loadRunLog(
    runId: number,
    host: HTMLElement,
    trigger: HTMLButtonElement,
  ): Promise<void> {
    if (host.firstChild) {
      host.replaceChildren();
      trigger.querySelector('.scc-btn__label')!.textContent = 'Show run log';
      return;
    }

    trigger.disabled = true;
    trigger.querySelector('.scc-btn__label')!.textContent = 'Loading…';

    const result = await runLog({ cwd: ctx.getCwd(), id: runId, failedOnly: false, maxLines: 200 });

    trigger.disabled = false;

    if (!result.ok || !result.log?.trim()) {
      const missing = !result.ok && /log not found|no logs/i.test(result.error ?? '');
      host.replaceChildren(
        errorStrip(
          missing
            ? 'GitHub keeps no log for a workflow that failed to parse. Open the run on GitHub for the syntax error, or check the workflow file locally.'
            : (result.error ?? 'Could not read the run log'),
        ),
      );
      trigger.querySelector('.scc-btn__label')!.textContent = 'Show run log';
      return;
    }

    trigger.querySelector('.scc-btn__label')!.textContent = 'Hide run log';
    host.replaceChildren(el('pre', 'scc-log', result.log));
  }

  function buildJob(runId: number, job: WorkflowJob): HTMLElement {
    const state = runState(job) as RunState;
    const wrap = el('section', 'scc-job');
    if (state === 'failure') wrap.classList.add('is-failed');

    const head = el('button', 'scc-job__head');
    head.type = 'button';
    const expanded = jobExpansion.get(job.id) ?? false;
    head.setAttribute('aria-expanded', String(expanded));
    head.append(
      stateDot(state, `${job.name}: ${stateLabel(state)}`),
      el('span', 'scc-job__name', job.name),
      el('span', 'scc-job__state', stateLabel(state)),
      el('span', 'scc-job__duration', job.startedAt ? duration(job.startedAt, job.completedAt) : ''),
    );

    const body = el('div', 'scc-job__body');
    body.hidden = !expanded;

    if (job.steps.length) {
      const steps = el('ol', 'scc-job__steps');
      for (const step of job.steps) {
        const stepState = runState(step) as RunState;
        const item = el('li', 'scc-step');
        if (stepState === 'failure') item.classList.add('is-failed');
        item.append(
          stateDot(stepState, `${step.name}: ${stateLabel(stepState)}`),
          el('span', 'scc-step__name', step.name),
        );
        steps.appendChild(item);
      }
      body.appendChild(steps);
    }

    let logPanel = jobLogs.get(job.id);
    if (!logPanel) {
      const host = el('div', 'scc-job__log-host');
      const trigger = button({
        label: 'Show log',
        icon: 'terminal',
        variant: 'ghost',
        onClick: () => void loadLog(runId, job, host, trigger),
      });
      logPanel = { host, trigger };
      jobLogs.set(job.id, logPanel);
    }
    body.append(logPanel.trigger, logPanel.host);

    head.addEventListener('click', () => {
      const open = !body.hidden;
      body.hidden = open;
      jobExpansion.set(job.id, !open);
      head.setAttribute('aria-expanded', String(!open));
    });

    wrap.append(head, body);
    return wrap;
  }

  async function loadLog(
    runId: number,
    job: WorkflowJob,
    host: HTMLElement,
    trigger: HTMLButtonElement,
  ): Promise<void> {
    if (host.firstChild) {
      host.replaceChildren();
      trigger.querySelector('.scc-btn__label')!.textContent = 'Show log';
      return;
    }

    trigger.disabled = true;
    trigger.querySelector('.scc-btn__label')!.textContent = 'Loading…';

    const result = await runLog({ cwd: ctx.getCwd(), id: runId, jobId: job.id, maxLines: 300 });

    trigger.disabled = false;
    trigger.querySelector('.scc-btn__label')!.textContent = 'Hide log';

    if (!result.ok) {
      host.replaceChildren(errorStrip(result.error ?? 'Could not read the log'));
      trigger.querySelector('.scc-btn__label')!.textContent = 'Show log';
      return;
    }

    const log = el('pre', 'scc-log', result.log ?? '');
    log.setAttribute('tabindex', '0');
    log.setAttribute('aria-label', `Log for ${job.name}`);
    host.replaceChildren(log);
    if (result.truncated) {
      host.appendChild(
        el('p', 'scc-log__note', `Showing the last 300 of ${result.totalLines ?? 0} lines.`),
      );
    }
    log.scrollTop = log.scrollHeight;
  }

  async function rerun(id: number, failedOnly: boolean): Promise<void> {
    const result = await runGitUiOp(() => runRerun({ cwd: ctx.getCwd(), id, failedOnly }), {
      label: 'Re-running workflow…',
      successMessage: failedOnly ? 'Re-running failed jobs' : 'Re-running workflow',
      chatKind: 'github',
      ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
    });
    if (!result.ok) return;
    await refresh();
  }

  async function cancel(id: number): Promise<void> {
    const result = await runGitUiOp(() => runCancel({ cwd: ctx.getCwd(), id }), {
      label: 'Cancelling run…',
      successMessage: 'Run cancelled',
      chatKind: 'github',
      ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
    });
    if (!result.ok) return;
    await refresh();
  }

  const navigate = listNavigator({
    getRows: () => [...listBody.querySelectorAll<HTMLElement>('.scc-runrow')],
  });

  void refresh();

  return {
    root,
    refresh,
    onKey: navigate,
    destroy: () => {
      destroyed = true;
      root.remove();
    },
  };
}
