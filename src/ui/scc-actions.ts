import '../styles/scc-actions.css';
import { actionApi, type ActionCommand, type ActionWorkflow } from '../state/actions-api';
import { createChecksView } from './scc-checks';
import { runList, runState, type ForgeStatus, type WorkflowRunSummary } from '../state/forge-api';
import { createIcon } from './icon';
import {
  button, chip, detailHead, searchBox, drillIn, duration, durationLabel, el, emptyState, pageBar, relativeTime, section, segmented,
  stateDot, statePill, stateLabel, runStateTone, type RunState, type SccContext, type SccView,
} from './scc-shared';
import {
  field,
  inputField,
  labeled,
  operationButton,
  select,
  statusLine,
  textArea,
} from './scc-action-form';
import { confirmAction as appConfirm } from './scc-action-form';
import { actionRow, selectActionRow } from './scc-action-layout';
import { errorStrip, skeletonRows } from './scc-shared';
import { getReleaseWorkflow, setReleaseWorkflow } from '../state/release-workflow';
import { renderRemoteWorkflowForm } from './scc-workflow-form';

let pendingTab = '';
export function requestActionWorkflow(): void {
  pendingTab = 'workflows';
}
export function requestActionRuns(): void {
  pendingTab = 'runs';
}

export function createActionsView(
  ctx: SccContext,
  options: { getForgeStatus: () => ForgeStatus | null },
): SccView {
  const root = el('div', 'scc-page scc-actions');
  const bar = pageBar('Actions');
  const targets = bar.actions;
  const body = el('div', 'scc-actions__body');
  root.append(bar.root, body);
  let tab = pendingTab || 'runs';
  pendingTab = '';
  let location = 'remote';
  let destroyed = false;
  let generation = 0;
  let cwd = ctx.getCwd();
  let branch = ctx.getBranch();
  let checks: SccView | null = null;
  let localList: HTMLElement | null = null;
  let localDetail: HTMLElement | null = null;
  let selectedRun = '';
  let logOffset = 0;
  let logText = '';
  let logNode: HTMLElement | null = null;
  let runStatus: HTMLElement | null = null;
  let cancelRun: HTMLButtonElement | null = null;
  let loadingLog = false;
  let page = 1;
  let workflowRepo = '';
  /** Set by a workflow page: open Runs filtered to that workflow, optionally on one run. */
  let runsFocus: { workflow: string; runId?: number } | null = null;
  const tabs = segmented<'runs' | 'workflows' | 'commands'>({
    label: 'Actions views',
    items: [
      { value: 'runs', label: 'Runs' },
      { value: 'workflows', label: 'Workflows' },
      { value: 'commands', label: 'Commands' },
    ],
    value: tab as 'runs',
    onChange: (name) => {
      tab = name;
      page = 1;
      void mount();
    },
  });
  bar.controls.append(tabs.root);
  const valid = (g: number) => !destroyed && g === generation && cwd === ctx.getCwd();
  let drill: ReturnType<typeof drillIn> | null = null;
  function split() {
    const wrap = el('div', 'scc-split');
    drill = drillIn(wrap);
    const listCol = el('div', 'scc-split__list');
    const list = el('div', 'scc-split__list-body');
    const foot = el('div', 'scc-split__foot');
    const detail = el('div', 'scc-split__detail scc-action-detail');
    listCol.append(list, foot);
    wrap.append(listCol, detail);
    body.append(wrap);
    return { list, detail, foot };
  }
  const openRow = () => drill?.open();

  async function mount() {
    const g = ++generation;
    checks?.destroy();
    checks = null;
    selectedRun = '';
    localList = null;
    localDetail = null;
    cancelRun = null;
    body.replaceChildren();
    targets.replaceChildren();
    drill = null;
    tabs.setValue(tab as 'runs');
    if (tab === 'runs') {
      const target = select(
        'Run location',
        [
          { value: 'remote', label: 'GitHub' },
          { value: 'local', label: 'Local runs' },
        ],
        location,
      );
      target.addEventListener('change', () => {
        location = target.value;
        void mount();
      });
      targets.append(target);
      if (location === 'remote') {
        checks = createChecksView(ctx, { ...options, focus: runsFocus ?? undefined });
        runsFocus = null;
        body.append(checks.root);
      } else {
        const panes = split();
        localList = panes.list;
        localDetail = panes.detail;
        localList.append(skeletonRows(5));
        localDetail.append(emptyState({ title: 'Select a local run', body: 'Review its output and captured worktree, or start a workflow or command.' }));
        await refreshLocalRuns(g);
      }
      return;
    }
    if (tab === 'commands') {
      await commands(g);
      return;
    }
    const target = select(
      'Workflow location',
      [
        { value: 'remote', label: 'GitHub' },
        { value: 'local', label: 'Local workflow (act)' },
      ],
      location,
    );
    target.addEventListener('change', () => {
      location = target.value;
      page = 1;
      void mount();
    });
    targets.append(target);
    const { list, detail, foot } = split();
    list.append(skeletonRows(5));
    const result = await actionApi('workflowList', { cwd, location, page });
    if (!valid(g)) return;
    list.replaceChildren();
    if (!result.ok) {
      list.append(errorStrip(result.error || 'Could not load workflows', () => void mount()));
      return;
    }
    workflowRepo = result.repo || '';
    if (!result.workflows?.length)
      list.append(
        emptyState({
          title: 'No workflows',
          body:
            location === 'local'
              ? 'Add a workflow under .github/workflows in this worktree.'
              : 'No workflows are available in this GitHub repository.',
        }),
      );
    for (const workflow of result.workflows || []) {
      const row = actionRow(workflow.name, workflow.path, () => {
        selectActionRow(list, row);
        openRow();
        void workflowForm(workflow, detail, g);
      }, { icon: 'workflow' });
      list.append(row);
    }
    if (page > 1)
      foot.append(
        button({
          label: 'Previous',
          onClick: () => {
            page--;
            void mount();
          },
        }),
      );
    if (result.hasMore)
      foot.append(
        button({
          label: 'Next',
          onClick: () => {
            page++;
            void mount();
          },
        }),
      );
    detail.append(
      emptyState({
        title: 'Select a workflow',
        body: 'Choose where to run it, review its inputs, then start a run.',
      }),
    );
  }

  let formRequest = 0;
  async function workflowForm(summary: ActionWorkflow, detail: HTMLElement, g: number) {
    const request = ++formRequest;
    const capturedCwd = cwd;
    const local = location === 'local';
    const current = () => valid(g) && request === formRequest;
    const file = summary.path.split('/').pop() ?? summary.path;
    const headActions = el('div');
    if (!local && workflowRepo) {
      const link = el('a', 'scc-btn scc-btn--ghost', 'Open on GitHub');
      link.append(createIcon('externalLink', { size: 13 }));
      link.href = `https://${workflowRepo}/actions/workflows/${encodeURIComponent(file)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      headActions.append(link);
    }
    const head = detailHead({
      eyebrow: [el('span', 'scc-mono', summary.path), local ? statePill('Runs locally with act', 'neutral') : el('span', undefined, workflowRepo || 'GitHub')],
      title: summary.name,
      actions: headActions.childElementCount ? headActions : undefined,
      onBack: () => drill?.close(),
      backLabel: 'Workflows',
    });
    detail.replaceChildren(head.root);

    if (!local) {
      const run = section('Run workflow', { description: `Starts ${file} on GitHub, the same as Run workflow on github.com.` });
      run.root.classList.add('scc-section-block--form');
      const recent = section('Recent runs');
      const releases = section('Releases', { description: 'Connect this workflow to Run release workflow on the Releases page.' });
      releases.root.hidden = true;
      detail.append(run.root, recent.root, releases.root);
      void recentRuns(summary, recent.body, current);
      await renderRemoteWorkflowForm(summary, run.body, {
        cwd: capturedCwd, branch, isCurrent: current,
        onWorkflowLoaded: (workflow) => {
          const repo = workflowRepo;
          const status = statusLine();
          const mapping = button({ label: 'Use for releases', onClick: () => {
            if (!current()) return;
            try {
              const mapped = getReleaseWorkflow(repo)?.id === workflow.id;
              setReleaseWorkflow(repo, mapped ? null : workflow);
              update();
              status.textContent = mapped ? 'Disconnected from Releases.' : 'Run release workflow on the Releases page now runs this workflow.';
            } catch (error) { status.textContent = String(error); }
          } });
          const state = el('span', 'scc-section-block__state');
          const update = () => {
            const mapped = getReleaseWorkflow(repo)?.id === workflow.id;
            mapping.querySelector('.scc-btn__label')!.textContent = mapped ? 'Remove release mapping' : 'Use for releases';
            mapping.setAttribute('aria-pressed', String(mapped));
            state.replaceChildren(mapped ? statePill('Connected', 'success') : statePill('Not connected', 'neutral'));
          };
          update();
          const row = el('div', 'scc-setting-row');
          row.append(state, mapping);
          releases.body.replaceChildren(row, status);
          releases.root.hidden = false;
        },
      });
      return;
    }

    const runLocal = section('Run locally', {
      description: 'Runs in this worktree with act, including uncommitted edits. Linux container jobs only; results can differ from GitHub.',
    });
    runLocal.root.classList.add('scc-section-block--form');
    const status = statusLine();
    const form = el('div', 'scc-action-form');
    runLocal.body.append(form, status);
    detail.append(runLocal.root);
    if (summary.error) {
      status.textContent = summary.error;
      return;
    }
    try {
      const caps = await actionApi('localCapabilities', { cwd });
      if (!current()) return;
      if (!caps.act?.available || !caps.docker?.available) {
        const missing = el('div', 'scc-prform__notice');
        missing.dataset.tone = 'warning';
        missing.append(
          createIcon('warning', { size: 14, className: 'scc-prform__notice-icon' }),
          el('span', 'scc-prform__notice-text', `Install act and start Docker, then select this workflow again. ${caps.act?.detail || ''} ${caps.docker?.detail || ''}`.trim()),
        );
        const link = el('a', 'scc-btn scc-btn--ghost', 'act setup instructions');
        link.href = 'https://nektosact.com/installation/';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        missing.append(link);
        form.append(missing);
        return;
      }
      const controls = el('div', 'scc-action-form');
      form.append(controls);
      let refRequest = 0;
      const load = async () => {
        const refGeneration = ++refRequest;
        controls.replaceChildren();
        const result = await actionApi('workflowView', {
          cwd: capturedCwd,
          location: 'local',
          path: summary.path,
          id: summary.id,
        });
        if (!current() || refGeneration !== refRequest) return;
        if (!result.ok || !result.workflow) {
          status.textContent = result.error || 'Could not read workflow';
          return;
        }
        const workflow = result.workflow;
        status.textContent = '';
        const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
        for (const def of workflow.inputs || []) {
          let input: HTMLInputElement | HTMLSelectElement;
          if (def.type === 'choice')
            input = select(
              def.description,
              def.options.map((value) => ({ value, label: value })),
              String(def.default ?? def.options[0] ?? ''),
            );
          else if (def.type === 'boolean')
            input = select(
              def.description,
              [
                { value: 'false', label: 'False' },
                { value: 'true', label: 'True' },
              ],
              String(def.default ?? false),
            );
          else
            input = field(
              def.description,
              String(def.default ?? ''),
              def.type === 'number' ? 'number' : 'text',
            );
          input.required = def.required;
          inputs.set(def.name, input);
          controls.append(inputField(def, input));
        }
        const event = select(
          'Event',
          (workflow.events || []).map((value) => ({ value, label: value })),
          workflow.dispatchable ? 'workflow_dispatch' : workflow.events?.[0],
        );
        const job = select('Job', [
          { value: '', label: 'All jobs' },
          ...(workflow.jobs || []).map((j) => ({
            value: j.id,
            label: `${j.label}${j.supported ? '' : ' (unsupported runner)'}`,
          })),
        ]);
        const image = field('Runner image', 'catthehacker/ubuntu:act-latest');
        const secretNames = field('Secret names', '');
        secretNames.placeholder = 'GITHUB_TOKEN, NPM_TOKEN';
        const grid = el('div', 'scc-field-grid');
        grid.append(labeled('Event', event), labeled('Job', job));
        const advanced = el('details', 'scc-action-advanced');
        advanced.append(
          el('summary', undefined, 'Runner and secrets'),
          labeled('Runner image', image, 'Docker image act uses for ubuntu-latest jobs.'),
          labeled('Secret names', secretNames, 'Comma separated. Values come from Local secrets below.'),
        );
        const runButton = operationButton(
          'Run locally',
          status,
          async () => {
            for (const input of inputs.values())
              if (!input.reportValidity())
                return { ok: false, error: 'Complete the required inputs.' };
            const values = Object.fromEntries(
              [...inputs].map(([name, input]) => [name, input.value]),
            );
            return actionApi('localRunStart', {
              cwd: capturedCwd,
              id: summary.id,
              path: summary.path,
              kind: 'workflow',
              event: event.value,
              job: job.value || undefined,
              inputs: values,
              image: image.value,
              secretNames: secretNames.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            });
          },
          () => {
            tab = 'runs';
            location = 'local';
            void mount();
          },
        );
        runButton.classList.add('scc-btn--primary');
        controls.append(grid, advanced, runButton);
      };
      await load();
      detail.append(secretSection(capturedCwd));
    } catch (error) {
      if (current()) status.textContent = String(error);
    }
  }

  /** The newest runs of one workflow; each opens in Runs. */
  async function recentRuns(summary: ActionWorkflow, host: HTMLElement, current: () => boolean) {
    host.replaceChildren(skeletonRows(3));
    // gh accepts the file name, which also reads better in the Runs filter than a numeric ID.
    const workflow = summary.path.split('/').pop() || String(summary.id);
    const result = await runList({ cwd, workflow, limit: 5 }).catch(() => null);
    if (!current()) return;
    const runs: WorkflowRunSummary[] = result?.ok ? result.runs ?? [] : [];
    if (!runs.length) {
      host.replaceChildren(el('p', 'scc-prdetail__muted', result?.ok ? 'This workflow has not run yet.' : 'Recent runs are unavailable right now.'));
      return;
    }
    const list = el('div', 'scc-lines scc-recent-runs');
    for (const run of runs) {
      const state = runState(run) as RunState;
      const row = el('button', 'scc-row scc-recent-run');
      row.type = 'button';
      const lead = el('span', 'scc-row__lead');
      lead.append(stateDot(state, stateLabel(state)));
      const meta = el('span', 'scc-row__meta');
      meta.append(el('span', 'scc-fact', run.branch), el('span', 'scc-fact scc-mono', run.sha.slice(0, 7)));
      if (run.startedAt && state !== 'pending') {
        const end = el('span', 'scc-row__end');
        end.append(durationLabel(duration(run.startedAt, run.updatedAt)));
        meta.append(end);
      }
      // Manual and scheduled runs are titled after the workflow itself; say what started them instead.
      const title = run.title.trim() === summary.name.trim() ? eventLabel(run.event) : run.title;
      row.append(lead, el('span', 'scc-row__title', title), el('span', 'scc-row__aside', relativeTime(run.createdAt)), meta);
      row.addEventListener('click', () => openRuns(workflow, run.id));
      list.append(row);
    }
    const all = button({ label: 'All runs of this workflow', variant: 'ghost', onClick: () => openRuns(workflow) });
    host.replaceChildren(list, all);
  }

  function openRuns(workflow: string, runId?: number) {
    runsFocus = { workflow, runId };
    tab = 'runs';
    location = 'remote';
    page = 1;
    void mount();
  }

  /** Values act passes as secrets; stored encrypted on this machine, never sent to GitHub. */
  function secretSection(capturedCwd: string | undefined) {
    const block = section('Local secrets', { description: 'Stored encrypted on this machine for local runs. Never sent to GitHub.' });
    const details = el('details', 'scc-action-advanced');
    details.append(el('summary', undefined, 'Add or remove a secret'));
    const name = field('Secret name');
    name.placeholder = 'NPM_TOKEN';
    const value = field('Secret value', '', 'password');
    const status = statusLine();
    const grid = el('div', 'scc-field-grid');
    grid.append(labeled('Name', name), labeled('Value', value));
    const buttons = el('div', 'scc-button-row');
    buttons.append(
      operationButton(
        'Save secret',
        status,
        () =>
          actionApi('actionSecrets', { cwd: capturedCwd, name: name.value, value: value.value }),
        () => {
          value.value = '';
        },
      ),
      operationButton('Delete secret', status, () =>
        actionApi('actionSecrets', { cwd: capturedCwd, name: name.value, remove: true }),
      ),
    );
    details.append(grid, buttons, status);
    block.body.append(details);
    return block.root;
  }

  async function commands(g: number) {
    const { list, detail } = split();
    list.append(skeletonRows(5));
    const result = await actionApi('commandList', { cwd });
    if (!valid(g)) return;
    list.replaceChildren();
    if (!result.ok) {
      list.append(errorStrip(result.error || 'Could not load commands', () => void mount()));
      return;
    }
    targets.append(button({ label: 'New command', icon: 'plus', variant: 'primary', onClick: () => { openRow(); editCommand(undefined, detail, g); } }));
    for (const command of result.commands || []) {
      const row = actionRow(command.label, command.command, () => {
        selectActionRow(list, row);
        openRow();
        editCommand(command, detail, g);
      }, { icon: 'terminal' });
      list.append(row);
    }
    if (!result.commands?.length) list.append(emptyState({ title: 'No project commands', body: 'Save a command here, or add scripts to package.json.' }));
    else if (result.commands.length > 8) {
      // Many package.json scripts: filter by name or command line.
      const filters = el('div', 'scc-split__filters');
      const find = searchBox('Filter commands');
      const empty = el('p', 'scc-prdetail__muted scc-split__none', 'No commands match.');
      empty.hidden = true;
      find.input.addEventListener('input', () => {
        const query = find.input.value.trim().toLowerCase();
        let shown = 0;
        for (const row of list.querySelectorAll<HTMLElement>('.scc-action-row')) {
          const match = !query || (row.title || row.textContent || '').toLowerCase().includes(query);
          row.hidden = !match;
          if (match) shown++;
        }
        empty.hidden = shown > 0;
      });
      filters.append(find.root);
      list.parentElement!.prepend(filters);
      list.append(empty);
    }
    detail.append(
      emptyState({
        icon: 'terminal',
        title: 'Project commands',
        body: 'Run package scripts or save a named command for this repository. Runs appear under Runs → Local runs.',
      }),
    );
  }
  function editCommand(command: ActionCommand | undefined, detail: HTMLElement, g: number) {
    const capturedCwd = cwd;
    const status = statusLine();
    const isScript = command?.script !== undefined;
    const headActions = el('div');
    if (command) {
      const run = operationButton(
        'Run saved command',
        status,
        () =>
          actionApi('localRunStart', {
            cwd: capturedCwd,
            kind: 'command',
            commandId: command.id,
          }),
        () => {
          tab = 'runs';
          location = 'local';
          void mount();
        },
      );
      run.classList.add('scc-btn--primary');
      headActions.append(run);
    }
    const head = detailHead({
      eyebrow: [statePill(isScript ? 'package.json script' : command ? 'Saved command' : 'New command', 'neutral')],
      title: command?.label || 'New command',
      facts: command ? [el('span', 'scc-mono', command.cwd || '.')] : undefined,
      actions: headActions.childElementCount ? headActions : undefined,
      onBack: () => drill?.close(),
      backLabel: 'Commands',
    });
    detail.replaceChildren(head.root, status);

    if (isScript) {
      const block = section('Script', { description: 'Defined in package.json. Edit it there.' });
      block.body.append(el('pre', 'scc-log scc-log--code', `$ ${command!.command}\n${command!.script}`));
      detail.append(block.root);
      detail.append(secretSection(capturedCwd));
      return;
    }

    const id = field('ID', command?.id);
    id.placeholder = 'build';
    const label = field('Label', command?.label);
    label.placeholder = 'Build';
    const script = textArea('Command', command?.command);
    script.rows = 3;
    script.placeholder = 'npm run build';
    const directory = field('Working directory', command?.cwd || '.');
    const shell = field('Shell profile ID (optional)', command?.shellProfile);
    const env = textArea('Environment JSON', JSON.stringify(command?.env || {}, null, 2));
    const secrets = textArea(
      'Secret references JSON',
      JSON.stringify(command?.secrets || {}, null, 2),
    );
    id.disabled = Boolean(command);

    const block = section('Command', { description: 'Runs in this worktree. Use it from Runs → Local runs or from a chat.' });
    block.root.classList.add('scc-section-block--form');
    const grid = el('div', 'scc-field-grid');
    grid.append(labeled('Label', label), labeled('ID', id, command ? 'Fixed once saved.' : 'Letters, numbers and dashes.'));
    const advanced = el('details', 'scc-action-advanced');
    advanced.append(
      el('summary', undefined, 'Environment and shell'),
      labeled('Shell profile ID (optional)', shell),
      labeled('Environment JSON', env, 'Variables set for this command, as { "NAME": "value" }.'),
      labeled('Secret references JSON', secrets, 'Map variables to Local secrets, as { "NAME": "SECRET_NAME" }.'),
    );
    const save = operationButton(
      'Save command',
      status,
      () =>
        actionApi('commandSave', {
          cwd: capturedCwd,
          command: {
            id: id.value,
            label: label.value,
            command: script.value,
            cwd: directory.value,
            shellProfile: shell.value,
            env: JSON.parse(env.value),
            secrets: JSON.parse(secrets.value),
          },
        }),
      () => {
        if (valid(g)) void mount();
      },
    );
    save.classList.add(command ? 'scc-btn--secondary' : 'scc-btn--primary');
    const footer = el('div', 'scc-form-footer');
    if (command) {
      const remove = operationButton(
        'Delete command',
        status,
        async () =>
          (await appConfirm({
            message: `Delete saved command ${command.label}?`,
            danger: true,
          }))
            ? actionApi('commandSave', { cwd: capturedCwd, id: command.id, remove: true })
            : { ok: true, note: 'Cancelled' },
        () => {
          if (valid(g)) void mount();
        },
      );
      remove.classList.add('scc-btn--ghost', 'scc-btn--danger-hover');
      footer.append(remove);
    }
    footer.append(save);
    block.body.append(grid, labeled('Command', script), labeled('Working directory', directory, 'Relative to the worktree root.'), advanced, footer);
    detail.append(block.root, secretSection(capturedCwd));
  }

  async function refreshLocalRuns(g: number) {
    const result = await actionApi('localRunList', { cwd });
    if (!valid(g) || !localList) return;
    if (!result.ok) {
      localList.replaceChildren(errorStrip(result.error || 'Could not load local runs', () => void refreshLocalRuns(g)));
      delete localList.dataset.signature;
      return;
    }
    const nodes: HTMLElement[] = [];
    for (const run of result.runs || []) {
      const row = actionRow(run.label, `${run.kind === 'workflow' ? 'Workflow' : 'Command'} · ${run.branch} · ${run.status}`, () => {
            selectActionRow(localList!, row);
            openRow();
            selectedRun = run.id;
            logOffset = 0;
            logText = '';
            loadingLog = false;
            const host = localDetail!;
            runStatus = statusLine();
            logNode = el('pre', 'scc-log scc-log--tall');
            logNode.tabIndex = 0;
            logNode.setAttribute('aria-label', `Output of ${run.label}`);
            cancelRun = operationButton('Cancel run', runStatus, () =>
              actionApi('localRunCancel', { cwd: run.cwd, id: run.id }),
            );
            cancelRun.classList.add('scc-btn--danger-hover');
            cancelRun.hidden = run.status !== 'running';
            const actions = el('div');
            actions.append(
              operationButton(
                'Run again',
                runStatus,
                () => actionApi('localRunRerun', { cwd: run.cwd, id: run.id }),
                () => void refreshLocalRuns(g),
              ),
              cancelRun,
            );
            const state = localRunState(run.status);
            const facts: HTMLElement[] = [chip(run.branch, 'branch'), chip(run.sha.slice(0, 8), 'sha')];
            if (run.dirty) facts.push(el('span', 'scc-tag', 'Uncommitted edits'));
            facts.push(el('span', 'scc-mono scc-local-run__cwd', run.cwd));
            const head = detailHead({
              eyebrow: [statePill(sentence(run.status), runStateTone(state)), el('span', undefined, run.kind === 'workflow' ? 'Workflow with act' : 'Command')],
              title: run.label,
              facts,
              actions,
              onBack: () => drill?.close(),
              backLabel: 'Local runs',
            });
            const output = section('Output');
            output.body.append(logNode);
            host.replaceChildren(head.root, runStatus, output.root);
            void refreshLog(g);
          }, { state: localRunState(run.status) });
      row.classList.toggle('is-selected', run.id === selectedRun);
      row.setAttribute('aria-pressed', String(run.id === selectedRun));
      nodes.push(row);
    }
    if (!nodes.length) nodes.push(emptyState({ title: 'No local runs yet', body: 'Start a project command or run a workflow with act.' }));
    const signature = JSON.stringify((result.runs || []).map((r) => [r.id, r.status]));
    if (localList.dataset.signature !== signature) {
      localList.replaceChildren(...nodes);
      localList.dataset.signature = signature;
    }
    await refreshLog(g);
  }
  async function refreshLog(g: number) {
    if (!selectedRun || loadingLog) return;
    const id = selectedRun;
    loadingLog = true;
    try {
      const result = await actionApi('localRunView', { cwd, id, offset: logOffset });
      if (!valid(g) || id !== selectedRun || !logNode || !runStatus) return;
      if (result.run && cancelRun) cancelRun.hidden = result.run.status !== 'running';
      logOffset = result.nextOffset ?? logOffset;
      logText = (logText + (result.log || '')).slice(-128000);
      const atBottom = logNode.scrollHeight - logNode.scrollTop - logNode.clientHeight < 30;
      if (logNode.textContent !== logText) logNode.textContent = logText;
      if (atBottom) logNode.scrollTop = logNode.scrollHeight;
      runStatus.textContent =
        result.error ||
        `${result.run?.status || ''}${result.run?.truncated ? ' · log capped at 4 MiB' : ''}${result.run?.error ? ` · ${result.run.error}` : ''}${result.run?.cleanupError ? ` · Container cleanup failed: ${result.run.cleanupError}` : ''}`;
    } finally {
      loadingLog = false;
    }
  }
  void mount();
  return {
    root,
    activate: () => {
      const requested = pendingTab;
      pendingTab = '';
      if (requested && requested !== tab) {
        tab = requested;
        page = 1;
        void mount();
      }
    },
    refresh: async () => {
      if (cwd !== ctx.getCwd() || branch !== ctx.getBranch()) {
        cwd = ctx.getCwd();
        branch = ctx.getBranch();
        await mount();
      } else if (checks) await checks.refresh();
      else if (tab === 'runs') await refreshLocalRuns(generation);
    },
    destroy: () => {
      destroyed = true;
      generation++;
      checks?.destroy();
      root.remove();
    },
  };
}

function localRunState(status: string): RunState {
  if (status === 'running' || status === 'queued') return 'pending';
  if (status === 'success' || status === 'succeeded' || status === 'completed') return 'success';
  if (status === 'failure' || status === 'failed' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'none';
}

function sentence(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Unknown';
}

const EVENT_LABEL: Record<string, string> = {
  workflow_dispatch: 'Manual run',
  schedule: 'Scheduled run',
  push: 'Push',
  pull_request: 'Pull request',
  release: 'Release',
  workflow_run: 'After another workflow',
};

function eventLabel(event: string): string {
  return EVENT_LABEL[event] ?? sentence(event.replace(/_/g, ' '));
}
