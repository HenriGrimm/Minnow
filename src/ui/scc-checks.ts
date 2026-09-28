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
import { gitUiCtx, runGitUiOp } from './git-ui-op';
import {
  button,
  chip,
  duration,
  el,
  emptyState,
  errorStrip,
  listNavigator,
  relativeTime,
  skeletonRows,
  stateDot,
  stateLabel,
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

  const listCol = el('div', 'scc-split__list');
  const toolbar = el('div', 'scc-list-view__toolbar');
  const listBody = el('div', 'scc-split__list-body');
  listCol.append(toolbar, listBody);

  const detailCol = el('div', 'scc-split__detail');
  root.append(listCol, detailCol);

  let destroyed = false;
  let branchOnly = true;
  let selectedId: number | null = null;
  let openJobId: number | null = null;
  let cache: WorkflowRunSummary[] = [];

  const branchToggle = button({
    label: 'This branch',
    title: 'Toggle between this branch and every branch',
    variant: 'ghost',
    onClick: () => {
      branchOnly = !branchOnly;
      branchToggle.querySelector('.scc-btn__label')!.textContent = branchOnly
        ? 'This branch'
        : 'All branches';
      branchToggle.classList.toggle('is-active', branchOnly);
      void refresh();
    },
  });
  branchToggle.classList.add('is-active');

  const refreshBtn = button({
    icon: 'refresh',
    title: 'Refresh runs',
    variant: 'ghost',
    onClick: () => void refresh(),
  });

  toolbar.append(branchToggle, refreshBtn);

  async function refresh(): Promise<void> {
    if (destroyed) return;

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
    });
    if (destroyed) return;

    if (!result.ok) {
      listBody.replaceChildren(errorStrip(result.error ?? 'Could not list runs', () => void refresh()));
      ctx.setBadge('checks', null);
      return;
    }

    cache = result.runs ?? [];
    ctx.setBadge('checks', cache.length ? { kind: 'state', value: rollup(cache) } : null);

    renderList(result.note);

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

    const hint = !status.cliInstalled
      ? 'winget install GitHub.cli'
      : !status.authenticated
        ? 'gh auth login'
        : undefined;

    listBody.replaceChildren(
      unavailableState({
        title: status.cliInstalled ? 'CI unavailable' : 'GitHub CLI not found',
        body: status.reason,
        hint,
        action: hint
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
                onClick: () => branchToggle.click(),
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
    const row = el('div', 'scc-runrow');
    row.tabIndex = 0;
    row.dataset.id = String(run.id);
    row.setAttribute('role', 'button');
    if (run.id === selectedId) row.classList.add('is-selected');
    if (state === 'pending') row.classList.add('is-running');

    const top = el('div', 'scc-runrow__top');
    top.append(
      stateDot(state, `${run.workflow}: ${stateLabel(state)}`),
      el('span', 'scc-runrow__workflow', run.workflow),
      el('span', 'scc-runrow__title', run.title),
    );

    const meta = el('div', 'scc-runrow__meta');
    meta.append(chip(run.sha, 'sha'), el('span', undefined, run.branch), el('span', undefined, run.event));
    const age = relativeTime(run.createdAt);
    if (age) meta.appendChild(el('span', undefined, age));
    if (state === 'pending' && run.startedAt) {
      meta.appendChild(el('span', 'scc-runrow__elapsed', duration(run.startedAt, '')));
    } else if (run.startedAt && run.updatedAt) {
      meta.appendChild(el('span', undefined, duration(run.startedAt, run.updatedAt)));
    }

    row.append(top, meta);
    row.addEventListener('click', () => void select(run.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void select(run.id);
      }
    });
    return row;
  }

  async function select(id: number): Promise<void> {
    selectedId = id;
    openJobId = null;
    for (const row of listBody.querySelectorAll('.scc-runrow')) {
      row.classList.toggle('is-selected', (row as HTMLElement).dataset.id === String(id));
    }
    await renderDetail(id);
  }

  function renderDetailPlaceholder(): void {
    detailCol.replaceChildren(
      emptyState({
        icon: 'statusRunning',
        title: 'Select a run',
        body: 'Its jobs, steps, and failed-step logs show here.',
      }),
    );
  }

  async function renderDetail(id: number): Promise<void> {
    if (!detailCol.querySelector('.scc-rundetail')) detailCol.replaceChildren(skeletonRows(7));

    const result = await runView({ cwd: ctx.getCwd(), id });
    if (destroyed || selectedId !== id) return;

    if (!result.ok || !result.run) {
      detailCol.replaceChildren(
        errorStrip(result.error ?? 'Could not load the run', () => void renderDetail(id)),
      );
      return;
    }

    detailCol.replaceChildren(buildDetail(result.run));
  }

  function buildDetail(run: WorkflowRunDetail): HTMLElement {
    const state = runState(run) as RunState;
    const wrap = el('div', 'scc-rundetail');

    const head = el('header', 'scc-rundetail__head');
    const titleRow = el('div', 'scc-rundetail__title-row');
    titleRow.append(
      stateDot(state, stateLabel(state)),
      el('h2', 'scc-rundetail__title', run.workflow),
      el('span', 'scc-rundetail__state', stateLabel(state)),
    );
    head.appendChild(titleRow);

    const facts = el('div', 'scc-rundetail__facts');
    facts.append(el('span', undefined, run.title), chip(run.sha, 'sha'), chip(run.branch, 'branch'));
    if (run.startedAt) {
      facts.appendChild(
        el('span', undefined, `${duration(run.startedAt, state === 'pending' ? '' : run.updatedAt)} elapsed`),
      );
    }
    head.appendChild(facts);

    const actions = el('div', 'scc-rundetail__actions');
    if (state === 'pending') {
      actions.appendChild(
        button({
          label: 'Cancel run',
          variant: 'ghost',
          className: 'scc-btn--danger-hover',
          onClick: () => void cancel(run.id),
        }),
      );
    } else {
      actions.appendChild(
        button({ label: 'Re-run all', icon: 'refresh', onClick: () => void rerun(run.id, false) }),
      );
      if (state === 'failure') {
        actions.appendChild(
          button({
            label: 'Re-run failed',
            variant: 'primary',
            onClick: () => void rerun(run.id, true),
          }),
        );
      }
    }
    if (run.url) {
      const link = el('a', 'scc-btn scc-btn--ghost', 'Open on GitHub');
      link.href = run.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.appendChild(link);
    }
    head.appendChild(actions);
    wrap.appendChild(head);

    if (run.jobs.length === 0) {
      wrap.appendChild(buildNoJobsState(run, state));
      return wrap;
    }

    const jobs = el('div', 'scc-rundetail__jobs');
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
    const expanded = openJobId === job.id || state === 'failure';
    head.setAttribute('aria-expanded', String(expanded));
    head.append(
      stateDot(state, `${job.name}: ${stateLabel(state)}`),
      el('span', 'scc-job__name', job.name),
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

    const logHost = el('div', 'scc-job__log-host');
    const logBtn = button({
      label: 'Show log',
      icon: 'terminal',
      variant: 'ghost',
      onClick: () => void loadLog(runId, job, logHost, logBtn),
    });
    body.append(logBtn, logHost);

    head.addEventListener('click', () => {
      const open = !body.hidden;
      body.hidden = open;
      openJobId = open ? null : job.id;
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
