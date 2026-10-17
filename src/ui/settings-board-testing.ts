import { runSettingsAction } from './settings-controls';
import '../styles/settings-general.css';
import '../styles/settings-about.css';
import { detectConfigServer } from '../config/storage-mode';
import { fetchWorkspace } from '../config/workspace-api';
import {
  ensureResearchWorkspaceOption,
  populateResearchWorkspaceSelect,
} from '../research/workspace-scope-ui';
import {
  fetchBoardTestingStatus,
  seedTestBoard,
  startFakeModel,
  stopFakeModel,
  type BoardTestingStatus,
} from '../api/board-testing';
import { loadSessionsFromStorage } from '../state/sessions';
import {
  appendSettingsGroup,
  linkToRepositoryDoc,
  linkToSettingsSection,
} from './settings-layout';
import {
  appendSettingsOfflineHint,
  createSettingsActionsRow,
  createSettingsSelectRow,
} from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { renderBoardScenarioRunner } from './board-scenario-runner';
import { setStatus } from './status';

let disposeBoardScenarioRunner: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clearMount(id: string): HTMLElement | null {
  const mount = document.getElementById(id);
  if (!mount) return null;
  mount.replaceChildren();
  return mount;
}

/** Render a compact status chip row (running/stopped, registered, seeded). */
function renderStatusChips(host: HTMLElement, status: BoardTestingStatus | null): void {
  host.replaceChildren();
  host.className = 'diagnostics-health-strip';

  const list = el('ul', 'diagnostics-health-strip__list');
  list.setAttribute('role', 'list');

  const rows = [
    {
      ok: status?.fakeModel.running === true,
      label: 'Fake model',
      detail: status?.fakeModel.running
        ? `${status.fakeModel.baseUrl ?? ''} (${status.fakeModel.requestCount} req)`
        : 'Stopped',
    },
    {
      ok: status?.providerRegistered === true,
      label: 'Provider',
      detail: status?.providerRegistered ? 'fake-board registered' : 'Not registered',
    },
    {
      ok: status?.seededBoard.present === true,
      label: 'Test boards',
      detail: status?.seededBoard.present
        ? `${status.seededBoard.count} in workspace`
        : 'None seeded',
    },
  ];

  for (const row of rows) {
    const item = el('li', 'diagnostics-health-strip__item');
    item.setAttribute('role', 'listitem');

    const dot = el('span', 'diagnostics-health-strip__dot');
    if (row.ok) dot.classList.add('is-ok');
    else dot.classList.add('is-err');

    const label = el('span', 'diagnostics-health-strip__label', row.label);
    const detail = el('span', 'diagnostics-health-strip__detail', row.detail ?? '');

    item.append(dot, label, detail);
    list.appendChild(item);
  }

  host.appendChild(list);
}

/** Populate Settings → Advanced → Board testing. */
export async function renderBoardTestingSettingsSection(): Promise<void> {
  disposeBoardScenarioRunner?.();
  disposeBoardScenarioRunner = null;
  const mount = clearMount('settingsBoardTestingBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Manual orchestrate board workflow: fake model, seed a test board, run catalog scenarios. For the full automated suite, see ',
    linkToRepositoryDoc(
      'orchestrate-board-testing.md',
      'documentation/contributor/orchestrate-board-testing.md',
    ),
    '. Planner chat must use the fake board model under ',
    linkToSettingsSection('Providers', 'providers'),
    '.',
  );
  shell.appendChild(lead);

  const serverUp = (await detectConfigServer()) === 'server';
  if (!serverUp) {
    appendSettingsOfflineHint(
      shell,
      'Board testing requires Minnow running locally. CLI commands remain available for CI.',
    );
  }

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  try {
    await loadSessionsFromStorage();
  } catch {
  }

  const statusHost = el('div', 'board-testing-status-host');
  content.appendChild(statusHost);

  let currentStatus: BoardTestingStatus | null = null;

  async function refreshStatus(): Promise<void> {
    if (!serverUp) {
      renderStatusChips(statusHost, null);
      return;
    }
    try {
      currentStatus = await fetchBoardTestingStatus();
      renderStatusChips(statusHost, currentStatus);
    } catch {
      renderStatusChips(statusHost, null);
    }
  }

  const fakeGroup = appendSettingsGroup(
    content,
    'Fake model',
    'In-process OpenAI-v1 stub in Minnow. Start registers provider fake-board.',
    'advanced.boardTesting.fakeModel',
    { emphasis: true },
  );

  const fakeActions = createSettingsActionsRow(
    [
      {
        label: 'Start',
        variant: 'primary',
        onClick: () => {
          void runSettingsAction(fakeActions.querySelector('button'), 'Starting fake model…', async () => {
            if (!serverUp) {
              setStatus('err', 'Tool server offline');
              return;
            }
            try {
              await startFakeModel();
              await refreshStatus();
            } catch (err) {
              setStatus('err', err instanceof Error ? err.message : 'Start failed');
            }
          });
        },
      },
      {
        label: 'Stop',
        onClick: () => {
          void runSettingsAction(fakeActions.querySelector('button:nth-child(2)'), 'Stopping fake model…', async () => {
            if (!serverUp) {
              setStatus('err', 'Tool server offline');
              return;
            }
            try {
              await stopFakeModel();
              await refreshStatus();
            } catch (err) {
              setStatus('err', err instanceof Error ? err.message : 'Stop failed');
            }
          });
        },
      },
      {
        label: 'Refresh status',
        onClick: () => {
          void refreshStatus();
        },
      },
    ],
    { searchKey: 'advanced.boardTesting.fakeModel.actions' },
  );
  fakeGroup.appendChild(fakeActions);

  const seedGroup = appendSettingsGroup(
    content,
    'Seed test board',
    'Writes a pre-initialized planner + board into ~/.minnow sessions. Each seed creates a new board folder.',
    'advanced.boardTesting.seed',
    { emphasis: true },
  );

  let preset: 'quick' | 'smoke' = 'quick';
  let mode: 'manual' | 'afk' | 'auto' | 'sequential' = 'manual';
  let autoStart = false;
  let workspacePath = '';

  const workspaceInfo = serverUp ? await fetchWorkspace() : null;
  workspacePath = workspaceInfo?.path ?? '';

  const { row: presetRow, select: presetSelect } = createSettingsSelectRow('Preset', {
    options: [
      { value: 'quick', label: 'Quick (3 parallel W1 tasks)' },
      { value: 'smoke', label: 'Smoke (full board-smoke plan)' },
    ],
    value: preset,
    searchKey: 'advanced.boardTesting.seed.preset',
    onChange: (value) => {
      preset = value === 'smoke' ? 'smoke' : 'quick';
    },
  });
  presetSelect.id = 'boardTestingPreset';
  seedGroup.appendChild(presetRow);

  const { row: modeRow, select: modeSelect } = createSettingsSelectRow('Seed status', {
    options: [
      { value: 'manual', label: 'Stopped (manual start)' },
      { value: 'afk', label: 'Running (unattended)' },
      { value: 'auto', label: 'Running' },
      { value: 'sequential', label: 'Running at N = 1' },
    ],
    value: mode,
    searchKey: 'advanced.boardTesting.seed.mode',
    onChange: (value) => {
      if (value === 'afk' || value === 'auto' || value === 'sequential') mode = value;
      else mode = 'manual';
    },
  });
  modeSelect.id = 'boardTestingMode';
  seedGroup.appendChild(modeRow);

  const { row: autoStartRow } = createSettingsToggleRow('Auto-start board', {
    checked: autoStart,
    description: 'Start the leftover seed as Running after it is written.',
    searchKey: 'advanced.boardTesting.seed.autoStart',
    onChange: (next) => {
      autoStart = next;
    },
  });
  seedGroup.appendChild(autoStartRow);

  const { row: workspaceRow, select: workspaceSelect } = createSettingsSelectRow('Workspace', {
    searchKey: 'advanced.boardTesting.seed.workspace',
    description: 'Folder for the seeded planner and board group.',
    onChange: (value) => {
      workspacePath = value;
    },
  });
  workspaceSelect.id = 'boardTestingWorkspace';
  populateResearchWorkspaceSelect(workspaceSelect, workspaceInfo);
  if (workspacePath.trim()) {
    ensureResearchWorkspaceOption(workspaceSelect, workspacePath);
    workspaceSelect.value = workspacePath;
  }
  seedGroup.appendChild(workspaceRow);

  const seedResultHost = el('pre', 'diagnostics-log-tail');
  seedResultHost.setAttribute('aria-live', 'polite');
  seedGroup.appendChild(seedResultHost);

  const seedActions = createSettingsActionsRow(
    [
      {
        label: 'Seed board',
        variant: 'primary',
        onClick: () => {
          void runSettingsAction(seedActions.querySelector('button'), 'Seeding test board…', async () => {
            if (!serverUp) {
              setStatus('err', 'Tool server offline');
              return;
            }
            try {
              const result = await seedTestBoard({
                workspacePath: workspacePath.trim() || undefined,
                preset,
                mode,
                autoStart,
              });
              await loadSessionsFromStorage({ force: true });
              if (result.workspacePath?.trim()) {
                workspacePath = result.workspacePath.trim();
                ensureResearchWorkspaceOption(workspaceSelect, workspacePath);
                workspaceSelect.value = workspacePath;
              }
              seedResultHost.textContent = [
                `group:    ${result.groupId}`,
                `planner:  ${result.plannerId}`,
                `workspace: ${result.workspacePath}`,
                `tasks:    ${result.taskCount}`,
                '',
                'Restart Minnow or re-open the workspace if the board was already open.',
              ].join('\n');
              await refreshStatus();
            } catch (err) {
              seedResultHost.textContent = '';
              setStatus('err', err instanceof Error ? err.message : 'Seed failed');
            }
          });
        },
      },
    ],
    { searchKey: 'advanced.boardTesting.seed.actions' },
  );
  seedGroup.appendChild(seedActions);

  const logGroup = appendSettingsGroup(
    content,
    'Board log validation',
    'V1 JSONL invariant checking is retired. Live board history is the journal under ~/.minnow/boards/.',
    'advanced.boardTesting.log',
    { emphasis: true },
  );
  const retiredNote = el(
    'p',
    'settings-section-lead',
    'POST /api/orchestrate/board-testing/check-log and npm run check:board-log return 410. Tail leftover JSONL with the existing log-tail API if you still have V1 files on disk.',
  );
  logGroup.appendChild(retiredNote);

  disposeBoardScenarioRunner = renderBoardScenarioRunner(content, {
    serverUp,
    announce: setStatus,
  });

  await refreshStatus();
}
