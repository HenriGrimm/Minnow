import '../styles/scc-actions.css';
import { actionApi, type ActionCommand, type ActionWorkflow } from '../state/actions-api';
import { createChecksView } from './scc-checks';
import { type ForgeStatus } from '../state/forge-api';
import { button, el, emptyState, type SccContext, type SccView } from './scc-shared';
import {
  field,
  labeled,
  operationButton,
  select,
  statusLine,
  textArea,
} from './scc-action-form';
import { confirmAction as appConfirm } from './scc-action-form';
import { actionHeader, actionRow, selectActionRow } from './scc-action-layout';
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
  const root = el('div', 'scc-actions');
  const toolbar = el('div', 'scc-actions__navigation');
  const targets = el('div', 'scc-actions__target');
  const body = el('div', 'scc-actions__body');
  root.append(actionHeader('Actions', 'Follow builds, run workflows, and manage project commands.'), toolbar, body);
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
  const tabNames = ['runs', 'workflows', 'commands'];
  const tabs = tabNames.map((name) =>
    button({
      label: name[0]!.toUpperCase() + name.slice(1),
      onClick: () => {
        tab = name;
        page = 1;
        void mount();
      },
    }),
  );
  const tabHost = el('div', 'scc-actions__tabs');
  tabHost.setAttribute('role', 'group');
  tabHost.setAttribute('aria-label', 'Actions views');
  tabHost.append(...tabs);
  toolbar.append(tabHost, targets);
  const valid = (g: number) => !destroyed && g === generation && cwd === ctx.getCwd();
  function split() {
    const wrap = el('div', 'scc-split');
    const listCol = el('div', 'scc-split__list');
    const list = el('div', 'scc-split__list-body');
    const detail = el('div', 'scc-split__detail scc-action-detail');
    listCol.append(list);
    wrap.append(listCol, detail);
    body.append(wrap);
    return { list, detail };
  }
  function contextLine() {
    return el(
      'p',
      'scc-action-context',
      `${options.getForgeStatus()?.repo || ''} · ${cwd || 'Current workspace'} · ${branch || 'Detached HEAD'}`,
    );
  }

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
    tabs.forEach((node, i) => {
      const selected = tabNames[i] === tab;
      node.classList.toggle('is-active', selected);
      node.setAttribute('aria-pressed', String(selected));
    });
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
      targets.append(labeled('Location', target));
      if (location === 'remote') {
        checks = createChecksView(ctx, options);
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
    targets.append(labeled('Run on', target));
    const { list, detail } = split();
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
        void workflowForm(workflow, detail, g);
      });
      list.append(row);
    }
    if (page > 1)
      list.append(
        button({
          label: 'Previous',
          onClick: () => {
            page--;
            void mount();
          },
        }),
      );
    if (result.hasMore)
      list.append(
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
    detail.replaceChildren(el('h2', undefined, summary.name), contextLine());
    if (!local) {
      await renderRemoteWorkflowForm(summary, detail, {
        cwd: capturedCwd, branch, isCurrent: () => valid(g) && request === formRequest,
        onWorkflowLoaded: (workflow, host) => {
          const repo = workflowRepo;
          const status = statusLine();
          const mapping = button({ label: 'Use for releases', onClick: () => {
            if (!valid(g) || request !== formRequest) return;
            try {
              const mapped = getReleaseWorkflow(repo)?.id === workflow.id;
              setReleaseWorkflow(repo, mapped ? null : workflow);
              update();
              status.textContent = mapped ? 'Release workflow mapping removed.' : 'The Releases button now runs this workflow.';
            } catch (error) { status.textContent = String(error); }
          } });
          const update = () => {
            const mapped = getReleaseWorkflow(repo)?.id === workflow.id;
            mapping.textContent = mapped ? 'Remove release mapping' : 'Use for releases';
            mapping.setAttribute('aria-pressed', String(mapped));
          };
          update();
          host.append(mapping, status);
        },
      });
      return;
    }
    const status = statusLine();
    const form = el('div', 'scc-action-form');
    detail.append(form, status);
    if (summary.error) {
      status.textContent = summary.error;
      return;
    }
    try {
      const caps = await actionApi('localCapabilities', { cwd });
      if (!valid(g) || request !== formRequest) return;
      if (!caps.act?.available || !caps.docker?.available) {
        status.textContent = `Install act and start Docker, then select this workflow again. ${caps.act?.detail || ''} ${caps.docker?.detail || ''}`;
        const link = el('a', undefined, 'act setup instructions');
        link.href = 'https://nektosact.com/installation/';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        form.append(link);
        return;
      }
      form.append(
        el(
          'p',
          undefined,
          'Uses the selected worktree, including current edits. Linux container jobs only; local results may differ from GitHub.',
        ),
      );
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
        if (!valid(g) || request !== formRequest || refGeneration !== refRequest) return;
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
          controls.append(
            labeled(`${def.name}${def.required ? ' *' : ''} · ${def.description}`, input),
          );
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
        controls.append(
          labeled('Event', event),
          labeled('Job', job),
          labeled('Runner image', image),
          labeled('Local secret names (comma separated)', secretNames),
        );
        secretForm(controls, capturedCwd);
        controls.append(
          operationButton(
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
          ),
        );
      };
      await load();
    } catch (error) {
      if (valid(g) && request === formRequest) status.textContent = String(error);
    }
  }

  function secretForm(host: HTMLElement, capturedCwd: string | undefined) {
    const details = el('details');
    details.append(el('summary', undefined, 'Local secrets'));
    const name = field('Secret name');
    const value = field('Secret value', '', 'password');
    const status = statusLine();
    details.append(
      labeled('Name', name),
      labeled('Value', value),
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
      status,
    );
    host.append(details);
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
    list.append(button({ label: 'New command', onClick: () => editCommand(undefined, detail, g) }));
    for (const command of result.commands || []) {
      const row = actionRow(command.label, command.command, () => {
        selectActionRow(list, row);
        editCommand(command, detail, g);
      });
      list.append(row);
    }
    if (!result.commands?.length) list.append(emptyState({ title: 'No project commands', body: 'Save a command here, or add scripts to package.json.' }));
    detail.append(
      emptyState({
        title: 'Project commands',
        body: 'Run package scripts or save a named command for this repository.',
      }),
    );
  }
  function editCommand(command: ActionCommand | undefined, detail: HTMLElement, g: number) {
    const capturedCwd = cwd;
    const status = statusLine();
    detail.replaceChildren(el('h2', undefined, command?.label || 'New command'), contextLine());
    const id = field('ID', command?.id);
    const label = field('Label', command?.label);
    const script = textArea('Command', command?.command);
    const directory = field('Working directory', command?.cwd || '.');
    const shell = field('Shell profile ID (optional)', command?.shellProfile);
    const env = textArea('Environment JSON', JSON.stringify(command?.env || {}, null, 2));
    const secrets = textArea(
      'Secret references JSON',
      JSON.stringify(command?.secrets || {}, null, 2),
    );
    if (command?.script !== undefined)
      detail.append(el('pre', 'scc-log', `${command.command}\n${command.script}`));
    else {
      id.disabled = Boolean(command);
      detail.append(
        labeled('ID', id),
        labeled('Label', label),
        labeled('Command', script),
        labeled('Working directory', directory),
      );
      const advanced = el('details', 'scc-action-advanced');
      advanced.append(el('summary', undefined, 'Environment and shell'), labeled('Shell profile ID (optional)', shell), labeled('Environment JSON', env), labeled('Secret references JSON', secrets));
      detail.append(advanced);
      detail.append(
        operationButton(
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
        ),
      );
      if (command)
        detail.append(
          operationButton(
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
          ),
        );
    }
    if (command)
      detail.append(
        operationButton(
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
        ),
      );
    secretForm(detail, capturedCwd);
    detail.append(status);
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
            selectedRun = run.id;
            logOffset = 0;
            logText = '';
            loadingLog = false;
            const host = localDetail!;
            host.replaceChildren(
              el('h2', undefined, run.label),
              el(
                'p',
                undefined,
                `${run.cwd} · ${run.branch} · ${run.sha.slice(0, 8)}${run.dirty ? ' · uncommitted edits' : ''}`,
              ),
            );
            runStatus = statusLine();
            logNode = el('pre', 'scc-log');
            logNode.tabIndex = 0;
            cancelRun = operationButton('Cancel run', runStatus, () =>
              actionApi('localRunCancel', { cwd: run.cwd, id: run.id }),
            );
            cancelRun.hidden = run.status !== 'running';
            host.append(
              cancelRun,
              operationButton(
                'Run again',
                runStatus,
                () => actionApi('localRunRerun', { cwd: run.cwd, id: run.id }),
                () => void refreshLocalRuns(g),
              ),
              runStatus,
              logNode,
            );
            void refreshLog(g);
          });
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
