import '../styles/ship-gate.css';

import { loadShipGateState, saveShipGateConfig } from '../api/ship-gate';
import { gitDiff, gitLog, gitStatus } from '../state/git-api';
import {
  assessShipGateEvidence,
  gitStateFingerprint,
  shipGateReadinessLabel,
  type ShipGateCheckConfig,
  type ShipGateConfig,
  type ShipGateReadiness,
  type ShipGateState,
} from '../ship-gate/model';
import { runShipGate, type ShipGateRunHandle } from '../ship-gate/runner';
import { appConfirm } from './app-dialog';
import { showToast } from './toast';
import { button, el } from './scc-shared';

async function currentReadiness(state: ShipGateState, cwd?: string): Promise<ShipGateReadiness> {
  const [log, status, working, staged] = await Promise.all([
    gitLog({ cwd, count: 1 }),
    gitStatus(cwd),
    gitDiff({ cwd, workingTree: true }),
    gitDiff({ cwd, cached: true }),
  ]);
  return assessShipGateEvidence({
    config: state.config,
    configSignature: state.configSignature,
    evidence: state.evidence,
    headSha: log.ok ? (log.commits?.[0]?.hash ?? null) : null,
    gitFingerprint: status.ok
      ? gitStateFingerprint(status, working.ok ? working.patch : '', staged.ok ? staged.patch : '')
      : '',
  });
}

/** Gate a PR action without uploading or changing repository state. */
export async function confirmShipGateForPr(cwd?: string): Promise<boolean> {
  let state: ShipGateState;
  try {
    state = await loadShipGateState(cwd);
  } catch (err) {
    return appConfirm(
      `Minnow could not read the local ship gate: ${err instanceof Error ? err.message : String(err)}\n\nCreate the pull request without local evidence?`,
      { title: 'Ship gate unavailable', confirmLabel: 'Create anyway' },
    );
  }
  const readiness = await currentReadiness(state, cwd);
  if (readiness === 'disabled' || readiness === 'passed') return true;

  if (state.config.policy === 'block') {
    showToast(`${shipGateReadinessLabel(readiness)} — run the local ship gate first`, 'error');
    const { openSourceControlCenter } = await import('./source-control-center');
    await openSourceControlCenter({ section: 'checks', cwd });
    return false;
  }

  return appConfirm(
    `${shipGateReadinessLabel(readiness)}. The configured checks have not passed against this exact HEAD and working tree.`,
    {
      title: 'Create pull request anyway?',
      confirmLabel: 'Create anyway',
    },
  );
}

function statusClass(readiness: ShipGateReadiness): string {
  if (readiness === 'passed') return 'is-pass';
  if (readiness === 'failed') return 'is-fail';
  return 'is-pending';
}

export function createShipGatePanel(options: {
  cwd?: string;
  onClose: () => void;
  onEvidenceChange?: (readiness: ShipGateReadiness) => void;
}): HTMLElement {
  const root = el('section', 'ship-gate');
  root.setAttribute('aria-label', 'Local ship gate');
  let state: ShipGateState | null = null;
  let config: ShipGateConfig | null = null;
  let activeRun: ShipGateRunHandle | null = null;

  const head = el('header', 'ship-gate__head');
  const titleWrap = el('div', 'ship-gate__title-wrap');
  titleWrap.append(
    el('p', 'ship-gate__eyebrow', 'Local evidence'),
    el('h2', 'ship-gate__title', 'Ship gate'),
    el('p', 'ship-gate__intro', 'Run the project’s selected checks locally before opening a pull request. Commands and evidence stay on this machine.'),
  );
  const closeBtn = button({ label: 'Back to CI', variant: 'ghost', onClick: options.onClose });
  head.append(titleWrap, closeBtn);

  const status = el('div', 'ship-gate__status', 'Loading configuration…');
  status.setAttribute('role', 'status');
  const checksHost = el('div', 'ship-gate__checks');
  const log = el('pre', 'ship-gate__log');
  log.tabIndex = 0;
  log.setAttribute('aria-label', 'Ship gate output');
  log.hidden = true;

  const policyRow = el('div', 'ship-gate__policy');
  const policyLabel = el('label', 'ship-gate__policy-label');
  policyLabel.append(el('span', undefined, 'Before pull requests'));
  const policySelect = el('select', 'scc-input ship-gate__policy-select');
  policySelect.setAttribute('aria-label', 'Ship gate pull request policy');
  policySelect.append(new Option('Warn when evidence is missing or stale', 'warn'), new Option('Block until the gate passes', 'block'));
  policyLabel.appendChild(policySelect);
  policyRow.appendChild(policyLabel);

  const actions = el('div', 'ship-gate__actions');
  const saveBtn = button({ label: 'Save configuration', variant: 'ghost' });
  const cancelBtn = button({ label: 'Cancel run', variant: 'danger' });
  cancelBtn.hidden = true;
  const runBtn = button({ label: 'Run selected checks', icon: 'statusRunning', variant: 'primary' });
  actions.append(saveBtn, cancelBtn, runBtn);

  root.append(head, status, checksHost, policyRow, actions, log);

  function paintChecks(): void {
    if (!config) return;
    const fragment = document.createDocumentFragment();
    for (const check of config.checks) {
      const row = el('div', 'ship-gate__check');
      row.dataset.checkId = check.id;
      const enabledLabel = el('label', 'ship-gate__check-toggle');
      const enabled = el('input');
      enabled.type = 'checkbox';
      enabled.checked = check.enabled;
      enabled.addEventListener('change', () => {
        check.enabled = enabled.checked;
      });
      enabledLabel.append(enabled, el('span', 'ship-gate__check-label', check.label));
      const command = el('input', 'scc-input ship-gate__command');
      command.type = 'text';
      command.value = check.command;
      command.placeholder = check.id === 'secrets' ? 'Configure a local secret scanner command' : 'Command';
      command.setAttribute('aria-label', `${check.label} command`);
      command.addEventListener('input', () => {
        check.command = command.value;
      });
      const result = el('span', 'ship-gate__check-result', check.enabled ? 'Ready' : 'Skipped');
      row.append(enabledLabel, command, result);
      fragment.appendChild(row);
    }
    checksHost.replaceChildren(fragment);
  }

  async function refreshState(): Promise<void> {
    state = await loadShipGateState(options.cwd);
    config = structuredClone(state.config);
    policySelect.value = config.policy;
    paintChecks();
    const readiness = await currentReadiness(state, options.cwd);
    status.className = `ship-gate__status ${statusClass(readiness)}`;
    status.textContent = state.evidence
      ? `${shipGateReadinessLabel(readiness)} · last run ${new Date(state.evidence.completedAt).toLocaleString()}`
      : shipGateReadinessLabel(readiness);
    options.onEvidenceChange?.(readiness);
  }

  async function persistConfig(): Promise<void> {
    if (!config) return;
    config.policy = policySelect.value === 'block' ? 'block' : 'warn';
    try {
      await saveShipGateConfig(config, options.cwd);
      await refreshState();
      showToast('Ship gate configuration saved', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not save ship gate', 'error');
    }
  }

  function setRunning(running: boolean): void {
    runBtn.disabled = running;
    saveBtn.disabled = running;
    closeBtn.disabled = running;
    policySelect.disabled = running;
    cancelBtn.hidden = !running;
    for (const input of checksHost.querySelectorAll<HTMLInputElement>('input')) input.disabled = running;
  }

  async function run(): Promise<void> {
    if (!config) return;
    config.policy = policySelect.value === 'block' ? 'block' : 'warn';
    const selected = config.checks.filter((check) => check.enabled && check.command.trim());
    if (selected.length === 0) {
      showToast('Select at least one check with a command', 'error');
      return;
    }
    await saveShipGateConfig(config, options.cwd);
    state = await loadShipGateState(options.cwd);
    config = structuredClone(state.config);
    paintChecks();
    setRunning(true);
    log.hidden = false;
    log.textContent = '';
    status.className = 'ship-gate__status is-running';
    status.textContent = `Running 0 of ${selected.length} checks…`;
    let index = 0;
    activeRun = runShipGate({
      checks: state.config.checks,
      configSignature: state.configSignature,
      workspaceRoot: options.cwd,
      callbacks: {
        onCheckStart: (check) => {
          index += 1;
          status.textContent = `Running ${index} of ${selected.length}: ${check.label}`;
          const row = checksHost.querySelector<HTMLElement>(`[data-check-id="${check.id}"]`);
          const result = row?.querySelector<HTMLElement>('.ship-gate__check-result');
          if (result) result.textContent = 'Running…';
          log.textContent = `${log.textContent ?? ''}$ ${check.command}\n`;
        },
        onOutput: (_check, text) => {
          log.textContent = `${log.textContent ?? ''}${text}`.slice(-12_000);
          log.scrollTop = log.scrollHeight;
        },
        onCheckComplete: (check, evidence) => {
          const row = checksHost.querySelector<HTMLElement>(`[data-check-id="${check.id}"]`);
          const result = row?.querySelector<HTMLElement>('.ship-gate__check-result');
          if (result) result.textContent = evidence.outcome === 'pass' ? 'Passed' : evidence.outcome === 'cancelled' ? 'Cancelled' : 'Failed';
          row?.classList.toggle('is-pass', evidence.outcome === 'pass');
          row?.classList.toggle('is-fail', evidence.outcome === 'fail');
        },
      },
    });
    try {
      const evidence = await activeRun.result;
      await refreshState();
      showToast(
        evidence.outcome === 'pass' ? 'Local ship gate passed' : evidence.outcome === 'cancelled' ? 'Ship gate cancelled' : 'Local ship gate failed',
        evidence.outcome === 'pass' ? 'success' : 'error',
      );
    } catch (err) {
      status.className = 'ship-gate__status is-fail';
      status.textContent = err instanceof Error ? err.message : 'Ship gate failed';
    } finally {
      activeRun = null;
      setRunning(false);
    }
  }

  saveBtn.addEventListener('click', () => void persistConfig());
  runBtn.addEventListener('click', () => void run());
  cancelBtn.addEventListener('click', () => void activeRun?.cancel());
  void refreshState().catch((err) => {
    status.className = 'ship-gate__status is-fail';
    status.textContent = err instanceof Error ? err.message : 'Could not load ship gate';
  });
  return root;
}
