import '../styles/settings-general.css';

import {
  clampAttemptWallClockMs,
  loadAutopilotMeta,
  saveAutopilotMeta,
  type AutopilotContinueSmartRoute,
  type AutopilotIsolationMode,
  type AutopilotMeta,
} from '../config/autopilot-meta';
import {
  appendSettingsCrosslinks,
  appendSettingsGroup,
  linkToSettingsSection,
} from './settings-layout';
import { msToSeconds, secondsToMs } from './settings-duration';
import {
  createSettingsKvList,
  createSettingsSelectRow,
} from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import {
  appendProviderModelFields,
  fillModelSelect,
  fillProviderSelect,
} from './settings-model-binding';
import { setStatus } from './status';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Compact numeric control for settings-kv rows. */
function createKvNumberInput(
  value: number,
  options: {
    min: string;
    max: string;
    step?: string;
    ariaLabel: string;
  },
): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'settings-select settings-kv-input';
  input.min = options.min;
  input.max = options.max;
  if (options.step) input.step = options.step;
  input.value = String(value);
  input.setAttribute('aria-label', options.ariaLabel);
  return { wrap: input, input };
}

function clampInfraTimeoutSeconds(seconds: number): number {
  return Math.min(600, Math.max(30, Math.round(seconds)));
}

/** Duration control shown in seconds; persisted as milliseconds. */
function createKvSecondsInput(
  valueMs: number,
  options: {
    minSeconds: number;
    maxSeconds: number;
    ariaLabel: string;
  },
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('span', 'settings-kv-input-wrap');
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'settings-select settings-kv-input';
  input.min = String(options.minSeconds);
  input.max = String(options.maxSeconds);
  input.step = '1';
  input.value = String(msToSeconds(valueMs));
  input.setAttribute('aria-label', options.ariaLabel);
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'settings-kv-suffix', 'sec'));
  return { wrap, input };
}

/** Mount orchestrate autopilot defaults into the settings section body. */
export async function renderAutopilotSettingsSection(mount: HTMLElement): Promise<void> {
  const meta = await loadAutopilotMeta();

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Global defaults for orchestrate boards: concurrency, Running or Stopped start, git worktree isolation (not host containment), test retries, and planner model fallback. Per-board overrides stay on the board header. Sub-agent wall-clock lives under ',
    linkToSettingsSection('Sub-agents', 'sub-agents'),
    '; generation stream limits under ',
    linkToSettingsSection('Watchdog', 'watchdog'),
    '; work agents under ',
    linkToSettingsSection('Agents', 'agent-center'),
    '; provider models under ',
    linkToSettingsSection('Providers', 'providers'),
    '.',
  );
  shell.appendChild(lead);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const persist = async (patch: Parameters<typeof saveAutopilotMeta>[0]): Promise<void> => {
    try {
      await saveAutopilotMeta(patch);
      setStatus('ok', 'Autopilot settings saved');
    } catch {
      setStatus('err', 'Could not save. Open or restart Minnow and try again.');
    }
  };

  const defaultsBody = appendSettingsGroup(
    content,
    'Board defaults',
    'New orchestrate boards inherit these values.',
    'agents.autopilot',
    { emphasis: true },
  );

  const statusSelect = document.createElement('select');
  statusSelect.id = 'settingsAutopilotDefaultStatus';
  statusSelect.className = 'settings-select';
  for (const opt of [
    { value: 'stopped', label: 'Stopped (start each task by hand)' },
    { value: 'running', label: 'Running (unattended)' },
  ]) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    statusSelect.appendChild(option);
  }
  statusSelect.value = meta.defaultStatus;
  defaultsBody.appendChild(
    createSettingsSelectRow('New boards start', {
      select: statusSelect,
      searchKey: 'agents.autopilot.defaultStatus',
      description:
        'Running is unattended at the current concurrency. Stopped is Manual: nothing starts until you start a task. Sequential is Running at N = 1.',
    }).row,
  );

  const isoSelect = document.createElement('select');
  isoSelect.id = 'settingsAutopilotIsolation';
  isoSelect.className = 'settings-select';
  for (const opt of [
    { value: 'auto', label: 'Auto (derive from concurrency)' },
    { value: 'off', label: 'Off' },
    { value: 'per-board', label: 'Per-board' },
    { value: 'per-task', label: 'Per-task' },
    { value: 'per-wave', label: 'Per-wave' },
  ]) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    isoSelect.appendChild(option);
  }
  isoSelect.value = meta.isolationMode;
  defaultsBody.appendChild(
    createSettingsSelectRow('Default isolation mode', {
      select: isoSelect,
      searchKey: 'agents.autopilot.isolation',
      description:
        'Git worktree isolation for parallel board tasks — not OS host containment. Pair with Settings → General → Agent shell sandbox when you need filesystem containment for agent shells.',
    }).row,
  );

  const conc = createKvNumberInput(meta.maxConcurrentTasks, {
    min: '1',
    max: '20',
    step: '1',
    ariaLabel: 'Max concurrent tasks',
  });
  defaultsBody.appendChild(
    createSettingsKvList(
      [{ term: 'Max concurrent tasks', value: conc.wrap }],
      { searchKey: 'agents.autopilot.concurrency', className: 'settings-kv settings-kv--row' },
    ),
  );
  defaultsBody.appendChild(
    el(
      'p',
      'settings-field-hint',
      'How many tasks may start at once. Sequential is this value set to 1.',
    ),
  );

  const testsBody = appendSettingsGroup(
    content,
    'Test & build retries',
    'Global thresholds for per-task test/build failures and final integration tests.',
    'agents.autopilot.retries',
    { emphasis: true },
  );

  const taskAttempts = createKvNumberInput(meta.maxTestAttempts, {
    min: '1',
    max: '10',
    step: '1',
    ariaLabel: 'Per-task test attempts',
  });
  const buildAttempts = createKvNumberInput(meta.maxBuildAttempts, {
    min: '1',
    max: '10',
    step: '1',
    ariaLabel: 'Per-task build attempts',
  });
  const finalAttempts = createKvNumberInput(meta.maxFinalTestAttempts, {
    min: '1',
    max: '10',
    step: '1',
    ariaLabel: 'Final test attempts',
  });
  testsBody.appendChild(
    createSettingsKvList(
      [
        { term: 'Per-task test attempts', value: taskAttempts.wrap },
        { term: 'Per-task build attempts', value: buildAttempts.wrap },
        { term: 'Final test attempts', value: finalAttempts.wrap },
      ],
      { className: 'settings-kv settings-kv--row' },
    ),
  );

  const attemptLimitWrap = el('span', 'settings-kv-input-wrap');
  const attemptLimitInput = document.createElement('input');
  attemptLimitInput.type = 'number';
  attemptLimitInput.className = 'settings-select settings-kv-input';
  attemptLimitInput.min = '0';
  attemptLimitInput.max = '1440';
  attemptLimitInput.step = '1';
  attemptLimitInput.value = String(Math.round(meta.attemptWallClockMs / 60_000));
  attemptLimitInput.setAttribute('aria-label', 'Attempt time limit in minutes');
  attemptLimitWrap.appendChild(attemptLimitInput);
  attemptLimitWrap.appendChild(el('span', 'settings-kv-suffix', 'min'));
  testsBody.appendChild(
    createSettingsKvList(
      [{ term: 'Attempt time limit', value: attemptLimitWrap }],
      { searchKey: 'agents.autopilot.attemptWallClock', className: 'settings-kv settings-kv--row' },
    ),
  );
  testsBody.appendChild(
    el(
      'p',
      'settings-field-hint',
      'Wall-clock cap for one builder or tester attempt. Hitting it ends the attempt as timed out, which retries or abandons the task like any other timeout. 5–1440 minutes; 0 turns it off.',
    ),
  );

  const smartRouteSelect = document.createElement('select');
  smartRouteSelect.id = 'settingsAutopilotContinueSmartRoute';
  smartRouteSelect.className = 'settings-select';
  for (const opt of [
    { value: 'off', label: 'Off — always nudge existing chat' },
    { value: 'conservative', label: 'Conservative — derailed or very large chats' },
    { value: 'aggressive', label: 'Aggressive — lower size thresholds' },
  ]) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    smartRouteSelect.appendChild(option);
  }
  smartRouteSelect.value = meta.continueSmartRoute;
  testsBody.appendChild(
    createSettingsSelectRow('Continue smart-route', {
      select: smartRouteSelect,
      description:
        'When Continue would bloat a derailed build chat, hand off to a fresh summarized chat instead.',
    }).row,
  );

  const plannerBody = appendSettingsGroup(
    content,
    'Planner model fallback',
    'Task chats use the planner chat model when set, then the composer model, then this default.',
    'agents.autopilot.plannerModel',
    { emphasis: true },
  );
  const { providerSelect, modelSelect } = appendProviderModelFields(
    plannerBody,
    { provider: 'settingsAutopilotPlannerProvider', model: 'settingsAutopilotPlannerModel' },
    { provider: 'Provider', model: 'Model' },
  );
  await fillProviderSelect(providerSelect, meta.plannerProviderId || '', {
    includeEmptyOption: true,
  });
  await fillModelSelect(modelSelect, meta.plannerProviderId, meta.plannerModelId || '');

  const selfHealBody = appendSettingsGroup(
    content,
    'Self-heal & provisioning',
    'How the AFK orchestrator handles task failures and infra setup. Worktree isolation is configured under Default isolation mode (git checkouts only — not host containment).',
    'agents.autopilot.selfHeal',
    { emphasis: true },
  );

  const healRounds = createKvNumberInput(meta.selfHealMaxRounds, {
    min: '0',
    max: '6',
    step: '1',
    ariaLabel: 'Max self-heal rounds',
  });
  const infraTimeout = createKvSecondsInput(meta.infraProvisionTimeoutMs, {
    minSeconds: 30,
    maxSeconds: 600,
    ariaLabel: 'Infra provision timeout in seconds',
  });

  selfHealBody.appendChild(
    createSettingsKvList(
      [
        { term: 'Max self-heal rounds', value: healRounds.wrap },
        { term: 'Infra provision timeout', value: infraTimeout.wrap },
      ],
      { className: 'settings-kv settings-kv--row' },
    ),
  );
  selfHealBody.appendChild(
    el(
      'p',
      'settings-field-hint',
      'Self-heal rounds run before unconditional quarantine (0–6). Infra timeout applies to docker and provisioning commands (30–600 s).',
    ),
  );

  const { row: autoProvisionRow, input: autoProvisionToggle } = createSettingsToggleRow(
    'Auto-provision infra',
    {
      id: 'settingsAutopilotAutoProvision',
      checked: meta.autoProvisionInfra,
      searchKey: 'agents.autopilot.autoProvisionInfra',
      description:
        'Automatically attempt docker/infra provisioning when an infra failure is detected.',
    },
  );
  selfHealBody.appendChild(autoProvisionRow);

  const { row: afkRestartStallsRow, input: afkRestartStallsToggle } = createSettingsToggleRow(
    'Auto-restart stalled tasks',
    {
      id: 'settingsAutopilotAfkRestartStalls',
      checked: meta.afkAutoRestartStalls,
      searchKey: 'agents.autopilot.afkAutoRestartStalls',
      description:
        'When off, stalling tasks are quarantined immediately instead of receiving a nudge.',
    },
  );
  selfHealBody.appendChild(afkRestartStallsRow);

  const { row: guardCdRow, input: guardCdToggle } = createSettingsToggleRow(
    'Guard cd outside worktree',
    {
      id: 'settingsAutopilotGuardCd',
      checked: meta.guardCdOutsideWorktree,
      searchKey: 'agents.autopilot.guardCdOutsideWorktree',
      description:
        'Rewrite leading absolute cd commands that escape the task worktree boundary. Git isolation only — does not sandbox the rest of the host filesystem.',
    },
  );
  selfHealBody.appendChild(guardCdRow);

  appendSettingsCrosslinks(content, [
    { label: 'Edit work agents in Agents', sectionId: 'agent-center' },
    { label: 'Configure providers', sectionId: 'providers' },
  ]);

  statusSelect.addEventListener('change', () => {
    const value = statusSelect.value === 'running' ? 'running' : 'stopped';
    statusSelect.value = value;
    void persist({ defaultStatus: value });
  });
  isoSelect.addEventListener('change', () => {
    void persist({
      isolationMode: isoSelect.value as AutopilotIsolationMode,
    });
  });
  conc.input.addEventListener('change', () => {
    const value = Math.min(20, Math.max(1, Math.floor(Number(conc.input.value) || 1)));
    conc.input.value = String(value);
    void persist({ maxConcurrentTasks: value });
  });
  taskAttempts.input.addEventListener('change', () => {
    const value = Math.min(
      10,
      Math.max(1, Math.floor(Number(taskAttempts.input.value) || 1)),
    );
    taskAttempts.input.value = String(value);
    void persist({ maxTestAttempts: value });
  });
  buildAttempts.input.addEventListener('change', () => {
    const value = Math.min(
      10,
      Math.max(1, Math.floor(Number(buildAttempts.input.value) || 1)),
    );
    buildAttempts.input.value = String(value);
    void persist({ maxBuildAttempts: value });
  });
  finalAttempts.input.addEventListener('change', () => {
    const value = Math.min(
      10,
      Math.max(1, Math.floor(Number(finalAttempts.input.value) || 1)),
    );
    finalAttempts.input.value = String(value);
    void persist({ maxFinalTestAttempts: value });
  });
  attemptLimitInput.addEventListener('change', () => {
    const minutes = Math.floor(Number(attemptLimitInput.value));
    const ms = clampAttemptWallClockMs(Number.isFinite(minutes) ? minutes * 60_000 : Number.NaN);
    attemptLimitInput.value = String(Math.round(ms / 60_000));
    void persist({ attemptWallClockMs: ms });
  });
  smartRouteSelect.addEventListener('change', () => {
    void persist({
      continueSmartRoute: smartRouteSelect.value as AutopilotContinueSmartRoute,
    });
  });
  providerSelect.addEventListener('change', async () => {
    await fillModelSelect(modelSelect, providerSelect.value, modelSelect.value);
    void persist({
      plannerProviderId: providerSelect.value,
      plannerModelId: modelSelect.value,
    });
  });
  modelSelect.addEventListener('change', () => {
    void persist({
      plannerProviderId: providerSelect.value,
      plannerModelId: modelSelect.value,
    });
  });
  healRounds.input.addEventListener('change', () => {
    const value = Math.min(6, Math.max(0, Math.floor(Number(healRounds.input.value) || 0)));
    healRounds.input.value = String(value);
    void persist({ selfHealMaxRounds: value });
  });
  infraTimeout.input.addEventListener('change', () => {
    const seconds = clampInfraTimeoutSeconds(Number(infraTimeout.input.value));
    infraTimeout.input.value = String(seconds);
    void persist({ infraProvisionTimeoutMs: secondsToMs(seconds) });
  });
  autoProvisionToggle.addEventListener('change', () => {
    void persist({ autoProvisionInfra: autoProvisionToggle.checked });
  });
  afkRestartStallsToggle.addEventListener('change', () => {
    void persist({ afkAutoRestartStalls: afkRestartStallsToggle.checked });
  });
  guardCdToggle.addEventListener('change', () => {
    void persist({ guardCdOutsideWorktree: guardCdToggle.checked });
  });
}
