import '../../styles/models-cli.css';
import '../../styles/settings-controls.css';
import {
  listAgentClis,
  setAgentCliEnabled,
  updateAgentCliSettings,
  verifyAgentCli,
  fetchAgentCliAccountUsage,
  type AgentCliKind,
  type AgentCliSettingsPatch,
  type AgentCliStatus,
} from '../../models/agent-clis';
import { invalidateProviderCache } from '../../providers/store';
import { modelProducerLogoSvg } from '../../providers/model-producer';
import { createSettingsSwitch } from '../settings-switch';
import { el, skeletonRows } from './dom';
import { accountUsageSummary, createAccountUsageView } from '../cli-account-usage';

const CLI_ORDER: AgentCliKind[] = ['claude', 'codex', 'cursor'];
const LOGIN_COMMANDS: Record<AgentCliKind, string> = {
  claude: 'claude auth login',
  codex: 'codex -c cli_auth_credentials_store=file login',
  cursor: 'cursor-agent login',
};
const INSTALL_COMMANDS: Record<AgentCliKind, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  cursor: 'curl https://cursor.com/install -fsS | bash',
};
const CURSOR_INSTALL_POWERSHELL = "irm 'https://cursor.com/install?win32=true' | iex";
const CURSOR_INSTALL_CMD =
  "powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm 'https://cursor.com/install?win32=true' | iex\"";

interface CliPanelDeps {
  usage: typeof fetchAgentCliAccountUsage;
  list: typeof listAgentClis;
  verify: typeof verifyAgentCli;
  setEnabled: typeof setAgentCliEnabled;
  updateSettings: typeof updateAgentCliSettings;
  launchSignIn: (status: AgentCliStatus) => Promise<void>;
  launchInstall: (status: AgentCliStatus) => Promise<void>;
}

const LOGIN_ARGS: Record<AgentCliKind, string> = {
  claude: 'auth login',
  codex: '-c cli_auth_credentials_store=file login',
  cursor: 'login',
};

function isPowerShellShell(shell: string | undefined): boolean {
  return /\b(?:pwsh|powershell)(?:\.exe)?$/i.test(shell ?? '');
}

function isCmdShell(shell: string | undefined): boolean {
  return /\bcmd(?:\.exe)?$/i.test(shell ?? '');
}

function quoteExecutable(path: string, shell: string | undefined): string {
  if (isPowerShellShell(shell)) {
    return `& '${path.replaceAll("'", "''")}'`;
  }
  if (isCmdShell(shell)) {
    return `"${path.replaceAll('"', '""')}"`;
  }
  return `'${path.replaceAll("'", `'"'"'`)}'`;
}

/** Fixed auth argv plus shell-appropriate quoting for a configured executable override. */
export function buildAgentCliLoginCommand(
  status: Pick<AgentCliStatus, 'kind' | 'binPath'>,
  shell?: string,
): string {
  return status.binPath
    ? `${quoteExecutable(status.binPath, shell)} ${LOGIN_ARGS[status.kind]}`
    : LOGIN_COMMANDS[status.kind];
}

/** Vendor install command matched to the destination terminal shell. */
export function buildAgentCliInstallCommand(kind: AgentCliKind, shell?: string): string {
  if (kind !== 'cursor') return INSTALL_COMMANDS[kind];
  if (isPowerShellShell(shell)) return CURSOR_INSTALL_POWERSHELL;
  if (isCmdShell(shell)) return CURSOR_INSTALL_CMD;
  if (!shell && typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)) {
    return CURSOR_INSTALL_POWERSHELL;
  }
  return INSTALL_COMMANDS.cursor;
}

async function runCommandInNewTerminal(
  buildCommand: (shell?: string) => string,
): Promise<void> {
  const [{ launchApp }, terminalPanel, terminalTabs, terminalXterm] = await Promise.all([
    import('../../os/router'),
    import('../terminal-panel'),
    import('../terminal-tabs'),
    import('../terminal-xterm'),
  ]);

  launchApp('code', { codeSection: 'chat' });
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  terminalPanel.openTerminalPanel();

  for (let attempt = 0; attempt < 50 && !terminalTabs.isTerminalTabsInitialized(); attempt += 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
  if (!terminalTabs.isTerminalTabsInitialized()) {
    throw new Error('Minnow terminal is not available. Restart Minnow and try again.');
  }

  const tabId = await terminalTabs.addTab();
  await terminalXterm.waitForTerminalInputReady(tabId);
  const shell = terminalTabs.getTerminalTabShellProfile(tabId)?.shell;
  terminalXterm.insertTextAtTerminalInput(`${buildCommand(shell)}\r`);
}

async function defaultLaunchSignIn(status: AgentCliStatus): Promise<void> {
  await runCommandInNewTerminal((shell) => buildAgentCliLoginCommand(status, shell));
}

async function defaultLaunchInstall(status: AgentCliStatus): Promise<void> {
  await runCommandInNewTerminal((shell) => buildAgentCliInstallCommand(status.kind, shell));
}

const defaultDeps: CliPanelDeps = {
  usage: fetchAgentCliAccountUsage,
  list: listAgentClis,
  verify: verifyAgentCli,
  setEnabled: setAgentCliEnabled,
  updateSettings: updateAgentCliSettings,
  launchSignIn: defaultLaunchSignIn,
  launchInstall: defaultLaunchInstall,
};

let deps = defaultDeps;
let mounted = false;
let mountTarget: HTMLElement | null = null;
let statusListener: ((statuses: readonly AgentCliStatus[]) => void) | null = null;
let showCommandInstructions = false;
let statuses: AgentCliStatus[] = [];
let loadError = '';
let notice = '';
let loadController: AbortController | null = null;
let loadSequence = 0;
let sectionObserver: MutationObserver | null = null;
const actionControllers = new Map<AgentCliKind, AbortController>();
const actionSequences = new Map<AgentCliKind, number>();
const pending = new Map<AgentCliKind, string>();
const itemErrors = new Map<AgentCliKind, string>();
const openSettings = new Set<AgentCliKind>();
interface CliView {
  dispose: () => void;
  row: HTMLElement;
  update: (status: AgentCliStatus) => void;
  flush: () => void;
  busy: () => boolean;
}
const views = new Map<AgentCliKind, CliView>();
const settingsWrites = new Set<Promise<void>>();

function host(): HTMLElement | null {
  return mountTarget ?? document.getElementById('modelsSection-clis');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshNormalModelPicker(): Promise<void> {
  invalidateProviderCache();
  if (!document.getElementById('modelSelect')) return;
  await (await import('../../api/models')).fetchModels();
}

function replaceStatus(next: AgentCliStatus): void {
  const index = statuses.findIndex((row) => row.kind === next.kind);
  if (index >= 0) statuses[index] = next;
  else statuses.push(next);
}

function sortedStatuses(): AgentCliStatus[] {
  return [...statuses].sort(
    (a, b) => CLI_ORDER.indexOf(a.kind) - CLI_ORDER.indexOf(b.kind),
  );
}

function authLabel(status: AgentCliStatus): string {
  switch (status.authStatus) {
    case 'signed-in': return 'Signed in';
    case 'token': return 'Token configured';
    case 'signed-out': return 'Signed out';
    default: return 'Sign-in unverified';
  }
}

function authTone(status: AgentCliStatus): string {
  if (status.authStatus === 'signed-in' || status.authStatus === 'token') return 'ready';
  if (status.authStatus === 'signed-out') return 'warning';
  return 'neutral';
}

function makeButton(label: string, className = 'models-inline-btn'): HTMLButtonElement {
  const button = el('button', className, label);
  button.type = 'button';
  return button;
}

function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel: string): void {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.label ?? button.textContent;
}

function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const label = el('label', 'models-cli-field');
  label.append(el('span', 'models-cli-field__label', labelText), control);
  if (hint) label.append(el('span', 'models-cli-field__hint', hint));
  return label;
}

function renderSettingsForm(status: AgentCliStatus): {
  form: HTMLFormElement;
  flush: () => void;
  busy: () => boolean;
} {
  const form = el('form', 'models-cli-settings__form');
  const grid = el('div', 'models-cli-settings__grid');
  const binPath = el('input', 'models-cli-input');
  binPath.type = 'text';
  binPath.name = 'binPath';
  binPath.autocomplete = 'off';
  binPath.placeholder = status.binPath || 'Auto-detect';
  binPath.value = status.binPathOverride ?? '';
  binPath.setAttribute('aria-label', `${status.label} binary path override`);

  const maxConcurrent = el('input', 'models-cli-input');
  maxConcurrent.type = 'number';
  maxConcurrent.name = 'maxConcurrent';
  maxConcurrent.min = '1';
  maxConcurrent.max = '16';
  maxConcurrent.step = '1';
  maxConcurrent.required = true;
  maxConcurrent.value = String(status.maxConcurrent);

  const contextWindow = el('input', 'models-cli-input');
  contextWindow.type = 'number';
  contextWindow.name = 'contextWindowTokens';
  contextWindow.min = '1000';
  contextWindow.max = '1000000';
  contextWindow.step = '1';
  contextWindow.placeholder = 'Automatic';
  contextWindow.value = status.contextWindowTokens === undefined ? '' : String(status.contextWindowTokens);
  grid.append(
    field('Concurrent runs', maxConcurrent, 'Run 1 to 16 requests at once. Additional requests wait.'),
    field('Context window (tokens)', contextWindow, status.kind === 'cursor'
      ? 'Automatic uses the model default. A custom limit only lowers Minnow’s budget.'
      : status.kind === 'claude'
        ? 'Automatic uses the model default. Above 200,000 requires extended context for Sonnet or Opus. Haiku stays at 200,000.'
        : 'Automatic uses the model default. Your Codex model must support a custom window.'),
  );

  let budget: HTMLInputElement | undefined;
  if (status.kind === 'claude') {
    budget = el('input', 'models-cli-input');
    budget.type = 'number';
    budget.name = 'maxBudgetUsd';
    budget.min = '0';
    budget.step = '0.01';
    budget.placeholder = 'No limit';
    budget.value = status.maxBudgetUsd === undefined ? '' : String(status.maxBudgetUsd);
    grid.append(field('Budget per turn (USD)', budget, 'Covers one message and its tool steps. Each new message starts a fresh budget.'));
  }
  form.append(grid);

  const advanced = el('details', 'models-cli-advanced');
  advanced.open = !status.installed;
  const advancedBody = el('div', 'models-cli-advanced__body');
  advancedBody.append(field('Binary path override', binPath, 'Leave blank to find the CLI automatically.'));
  const utilityLabel = el('label', 'models-cli-check');
  const utility = el('input');
  utility.type = 'checkbox';
  utility.name = 'allowUtilityRoles';
  utility.checked = status.allowUtilityRoles;
  utilityLabel.append(
    utility,
    el('span', 'models-cli-check__copy', 'Allow helper tasks'),
    el('span', 'models-cli-field__hint', 'Use this CLI for summaries, chat titles, and other utility tasks.'),
  );
  advancedBody.append(utilityLabel);
  advanced.append(el('summary', undefined, 'Advanced settings'), advancedBody);
  form.append(advanced);

  const feedback = el('div', 'models-cli-save-feedback');
  const saveStatus = el('p', 'models-cli-save-status', 'Changes save automatically.');
  saveStatus.setAttribute('role', 'status');
  saveStatus.setAttribute('aria-live', 'polite');
  const retry = makeButton('Retry');
  retry.hidden = true;
  feedback.append(saveStatus, retry);
  form.append(feedback);

  const updateSettings = deps.updateSettings;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let editRevision = 0;
  let queued: AgentCliSettingsPatch | undefined;
  let failed: AgentCliSettingsPatch | undefined;
  const readPatch = (): AgentCliSettingsPatch => ({
    binPath: binPath.value.trim() || null,
    maxConcurrent: Number(maxConcurrent.value),
    allowUtilityRoles: utility.checked,
    contextWindowTokens: contextWindow.value.trim() ? Number(contextWindow.value) : null,
    ...(budget ? { maxBudgetUsd: budget.value.trim() ? Number(budget.value) : null } : {}),
  });
  let savedKey = JSON.stringify(readPatch());
  const isCurrent = (): boolean => mounted && views.get(status.kind)?.row.contains(form) === true;
  const refreshView = (): void => { if (isCurrent()) render(); };
  const persist = async (): Promise<void> => {
    if (saving || !queued) return;
    const patch = queued;
    const revision = editRevision;
    queued = undefined;
    if (JSON.stringify(patch) === savedKey && !failed) {
      saveStatus.textContent = 'Saved';
      refreshView();
      return;
    }
    saving = true;
    failed = undefined;
    retry.hidden = true;
    saveStatus.dataset.tone = '';
    saveStatus.textContent = 'Saving…';
    refreshView();
    try {
      const next = await updateSettings(status.kind, patch);
      savedKey = JSON.stringify(patch);
      if (isCurrent()) replaceStatus(next);
      if (revision === editRevision) saveStatus.textContent = 'Saved';
      void refreshNormalModelPicker().catch(() => {});
    } catch (error) {
      failed = patch;
      if (revision === editRevision) {
        saveStatus.textContent = `Could not save: ${errorMessage(error)}`;
        saveStatus.dataset.tone = 'error';
        retry.hidden = false;
      }
    } finally {
      saving = false;
      refreshView();
      if (queued && !timer) startSave();
    }
  };
  const startSave = (): void => {
    const write = persist();
    settingsWrites.add(write);
    void write.finally(() => settingsWrites.delete(write));
  };
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (!saving && queued) startSave();
  };
  const queue = (immediate: boolean): void => {
    editRevision += 1;
    clearTimeout(timer);
    timer = undefined;
    const controls = [maxConcurrent, contextWindow, ...(budget ? [budget] : [])];
    const invalid = controls.find((input) => !input.validity.valid);
    for (const input of controls) input.setAttribute('aria-invalid', String(!input.validity.valid));
    if (invalid) {
      queued = undefined;
      saveStatus.textContent = invalid.validationMessage || 'Enter a valid value to save this change.';
      saveStatus.dataset.tone = 'error';
      retry.hidden = true;
      refreshView();
      return;
    }
    queued = readPatch();
    saveStatus.dataset.tone = '';
    saveStatus.textContent = 'Changes pending…';
    if (immediate) flush();
    else timer = setTimeout(flush, 500);
    refreshView();
  };
  form.addEventListener('input', () => queue(false));
  form.addEventListener('change', () => queue(true));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (form.reportValidity()) queue(true);
  });
  retry.addEventListener('click', () => queue(true));
  return { form, flush, busy: () => saving || queued !== undefined || timer !== undefined };
}

function renderCli(status: AgentCliStatus): CliView {
  const row = el('article', 'models-cli-row');
  row.dataset.kind = status.kind;
  const details = el('details', 'models-cli-settings');
  details.open = openSettings.has(status.kind);
  details.addEventListener('toggle', () => {
    if (details.open) openSettings.add(status.kind);
    else openSettings.delete(status.kind);
  });
  const summary = el('summary', 'models-cli-row__head');
  const logo = el('span', 'models-cli-logo');
  logo.setAttribute('aria-hidden', 'true');
  const svg = modelProducerLogoSvg(status.kind === 'codex' ? 'openai' : status.kind);
  if (svg) logo.innerHTML = svg;
  else logo.textContent = 'C';
  const identity = el('span', 'models-cli-row__identity');
  const title = el('span', 'models-cli-row__title', status.label);
  const metadata = el('span', 'models-cli-row__meta');
  identity.append(title, metadata);
  const enabledState = el('span', 'models-cli-row__state');
  const usageSummary = el('span', 'models-cli-row__usage');
  usageSummary.hidden = status.kind === 'cursor';
  const usage = status.kind === 'cursor' ? null : createAccountUsageView(status.kind, {
    request: (kind, options) => deps.usage(kind, options),
    visible: () => row.isConnected && host()?.classList.contains('is-active') === true,
    onChange: (snapshot) => { usageSummary.textContent = accountUsageSummary(snapshot); },
  });
  const chevron = el('span', 'models-cli-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  summary.append(logo, identity, usageSummary, enabledState, chevron);
  const body = el('div', 'models-cli-card-body');
  const connection = el('div', 'models-cli-connection');
  const badges = el('div', 'models-cli-connection__status');
  const installed = el('span', 'models-cli-badge');
  const auth = el('span', 'models-cli-badge');
  badges.append(installed, auth);
  const actions = el('div', 'models-cli-row__actions');
  const enableLabel = el('div', 'models-cli-enable');
  const enableText = el('span');
  const { root: enableRoot, input: enable } = createSettingsSwitch({
    ariaLabel: `Enable ${status.label} provider`,
    checked: status.enabled,
  });
  enableLabel.append(enableText, enableRoot);
  enable.addEventListener('change', () => {
    const next = enable.checked;
    void runAction(status.kind, next ? 'Enabling' : 'Disabling',
      (signal) => deps.setEnabled(status.kind, next, signal), true);
  });
  const verify = makeButton('Verify');
  verify.dataset.label = 'Verify';
  verify.addEventListener('click', () => {
    void runAction(status.kind, 'Verifying', (signal) => deps.verify(status.kind, signal));
  });
  const install = makeButton('Install', 'models-inline-btn is-primary');
  install.addEventListener('click', () => void launchInstall(status.kind));
  const signIn = makeButton('Sign in', 'models-inline-btn is-primary');
  signIn.addEventListener('click', () => void launchSignIn(status.kind));
  actions.append(verify, install, signIn, enableLabel);
  connection.append(badges, actions);
  const info = el('p', 'models-cli-field__hint');
  const path = el('p', 'models-cli-path');
  const error = el('p', 'models-cli-row__error');
  error.setAttribute('role', 'alert');
  const settings = renderSettingsForm(status);
  body.append(connection, info, path, error, settings.form);
  if (usage) connection.after(usage.root);
  details.append(summary, body);
  row.append(details);

  const update = (next: AgentCliStatus): void => {
    usageSummary.hidden = !next.installed || next.kind === 'cursor';
    if (usage) {
      usage.root.hidden = !next.installed;
      if (next.installed && row.isConnected) usage.start();
      else usage.stop();
    }
    const busy = pending.has(next.kind) || settings.busy() || Boolean(loadController);
    metadata.textContent = next.installed
      ? [next.version, authLabel(next)].filter(Boolean).join(' · ')
      : 'Not installed';
    enabledState.textContent = next.enabled ? 'Enabled' : 'Disabled';
    enabledState.dataset.enabled = String(next.enabled);
    installed.textContent = next.installed ? 'Installed' : 'Not installed';
    auth.textContent = authLabel(next);
    auth.className = `models-cli-badge models-cli-badge--${authTone(next)}`;
    auth.hidden = !next.installed;
    enable.checked = next.enabled;
    enable.disabled = busy || !next.installed;
    enableText.textContent = next.enabled ? 'Enabled' : 'Enable provider';
    setBusy(verify, pending.get(next.kind) === 'Verifying', 'Verifying…');
    verify.disabled = busy || !next.installed;
    verify.hidden = !next.installed;
    install.hidden = next.installed;
    install.disabled = busy;
    install.textContent = pending.get(next.kind) === 'Opening terminal' ? 'Opening…' : 'Install';
    signIn.hidden = !next.installed || next.authStatus === 'signed-in' || next.authStatus === 'token';
    signIn.disabled = busy;
    for (const input of settings.form.querySelectorAll('input')) {
      input.disabled = pending.has(next.kind) || Boolean(loadController);
    }
    path.textContent = next.binPath ?? '';
    path.hidden = !next.binPath;
    path.title = next.binPath ?? '';
    const sessionHint = next.fallbackReason || (next.kind === 'cursor' && next.transport !== 'acp'
      ? 'Minnow checks persistent-session support before sending a prompt. Unsupported Cursor versions use isolated replay.'
      : 'Conversations continue automatically. Matching saved conversations resume after eviction or restart.');
    info.textContent = !next.installed
      ? 'Install in Terminal, then scan again. You can also set a binary path in Advanced settings.'
      : next.kind === 'codex'
        ? `Sign in creates a file-backed Codex login for Minnow’s isolated runs. ${sessionHint}`
        : sessionHint;
    error.textContent = itemErrors.get(next.kind) ?? '';
    error.hidden = !error.textContent;
  };
  update(status);
  return { row, update, flush: settings.flush, busy: settings.busy, dispose: () => usage?.stop() };
}

function render(): void {
  statusListener?.(statuses);
  const mount = host();
  if (!mount || !mounted) return;
  if (!mount.querySelector('.models-cli-header')) {
    mount.replaceChildren();
    const header = el('div', 'models-cli-header');
    const heading = el('div');
    heading.append(
      el('h2', undefined, 'CLIs'),
      el('p', 'models-lead', 'Connect your coding agents. Use their models and subscriptions in Minnow.'),
    );
    const scan = makeButton('Scan again');
    scan.addEventListener('click', () => void scanAll());
    header.append(heading, scan);
    const live = el('div', 'models-cli-notice');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    mount.append(header, live, el('div', 'models-cli-list'));
  }
  const scan = mount.querySelector<HTMLButtonElement>('.models-cli-header > button')!;
  scan.textContent = loadController ? 'Scanning…' : statuses.length ? 'Scan again' : 'Scan for CLIs';
  scan.disabled = Boolean(loadController) || pending.size > 0 || [...views.values()].some((view) => view.busy());
  const live = mount.querySelector<HTMLElement>('.models-cli-notice')!;
  live.classList.toggle('is-error', Boolean(loadError));
  live.setAttribute('role', loadError ? 'alert' : 'status');
  live.textContent = loadError || notice;
  live.hidden = !live.textContent;
  const list = mount.querySelector<HTMLElement>('.models-cli-list')!;
  if (!statuses.length) {
    list.replaceChildren(loadController ? skeletonRows(3) : el('p', 'models-cli-empty', loadError
      ? 'Could not load CLI status. Scan again to retry.'
      : 'No supported CLIs were reported by the tool server. Scan again to check.'));
    return;
  }
  if (!views.size) list.replaceChildren();
  for (const status of sortedStatuses()) {
    let view = views.get(status.kind);
    if (!view) {
      view = renderCli(status);
      views.set(status.kind, view);
      list.append(view.row);
    }
    view.update(status);
  }
}

async function load(): Promise<void> {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  const sequence = ++loadSequence;
  loadError = '';
  notice = '';
  render();
  try {
    while (settingsWrites.size) {
      await Promise.allSettled([...settingsWrites]);
      if (!mounted || controller.signal.aborted || sequence !== loadSequence) return;
    }
    const next = await deps.list(controller.signal);
    if (!mounted || controller.signal.aborted || sequence !== loadSequence) return;
    statuses = next;
  } catch (error) {
    if (controller.signal.aborted || sequence !== loadSequence) return;
    loadError = errorMessage(error);
  } finally {
    if (sequence === loadSequence) loadController = null;
    render();
    if (!loadError && mounted && sequence === loadSequence
      && statuses.some((status) => status.installed && status.authStatus === 'unknown')) {
      void scanAll(true);
    }
  }
}

async function scanAll(onlyUnverified = false): Promise<void> {
  if (pending.size > 0 || [...views.values()].some((view) => view.busy())) return;
  if (!statuses.length) {
    await load();
    return;
  }
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  const sequence = ++loadSequence;
  loadError = '';
  notice = '';
  render();
  const candidates = sortedStatuses().filter((status) =>
    !onlyUnverified || (status.installed && status.authStatus === 'unknown'));
  const results = await Promise.allSettled(
    candidates.map((status) => deps.verify(status.kind, controller.signal)),
  );
  if (!mounted || controller.signal.aborted || sequence !== loadSequence) return;
  let failures = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') replaceStatus(result.value);
    else failures += 1;
  }
  void refreshNormalModelPicker().catch(() => {});
  notice = failures ? `Scan finished with ${failures} ${failures === 1 ? 'error' : 'errors'}.` : 'CLI status is up to date.';
  if (sequence === loadSequence) loadController = null;
  render();
}

async function runAction(
  kind: AgentCliKind,
  label: string,
  action: (signal: AbortSignal) => Promise<AgentCliStatus>,
  refreshPickers = false,
): Promise<void> {
  if (loadController || pending.has(kind) || views.get(kind)?.busy()) return;
  actionControllers.get(kind)?.abort();
  const controller = new AbortController();
  actionControllers.set(kind, controller);
  const sequence = (actionSequences.get(kind) ?? 0) + 1;
  actionSequences.set(kind, sequence);
  pending.set(kind, label);
  itemErrors.delete(kind);
  render();
  try {
    const next = await action(controller.signal);
    if (!mounted || controller.signal.aborted || actionSequences.get(kind) !== sequence) return;
    replaceStatus(next);
    if (refreshPickers) void refreshNormalModelPicker().catch(() => {});
    notice = `${next.label}: ${label === 'Verifying' ? 'status verified' : 'settings updated'}.`;
  } catch (error) {
    if (controller.signal.aborted || actionSequences.get(kind) !== sequence) return;
    itemErrors.set(kind, errorMessage(error));
  } finally {
    if (actionSequences.get(kind) === sequence) {
      pending.delete(kind);
      actionControllers.delete(kind);
      render();
    }
  }
}

async function launchSignIn(kind: AgentCliKind): Promise<void> {
  if (loadController || pending.has(kind) || views.get(kind)?.busy()) return;
  itemErrors.delete(kind);
  notice = '';
  pending.set(kind, 'Opening terminal');
  render();
  try {
    const status = statuses.find((row) => row.kind === kind);
    if (!status) throw new Error('CLI status is unavailable. Scan again and retry.');
    if (showCommandInstructions) {
      const shell = /windows/i.test(navigator.userAgent) ? 'powershell' : undefined;
      notice = `Run ${buildAgentCliLoginCommand(status, shell)} in your terminal. Finish sign-in, then verify here.`;
      return;
    }
    await deps.launchSignIn(status);
    notice = `${LOGIN_COMMANDS[kind]} opened in Terminal. Finish sign-in there, then return and verify.`;
  } catch (error) {
    itemErrors.set(kind, errorMessage(error));
  } finally {
    pending.delete(kind);
    render();
  }
}

async function launchInstall(kind: AgentCliKind): Promise<void> {
  if (loadController || pending.has(kind) || views.get(kind)?.busy()) return;
  itemErrors.delete(kind);
  notice = '';
  pending.set(kind, 'Opening terminal');
  render();
  try {
    const status = statuses.find((row) => row.kind === kind);
    if (!status) throw new Error('CLI status is unavailable. Scan again and retry.');
    if (showCommandInstructions) {
      const shell = /windows/i.test(navigator.userAgent) ? 'powershell' : undefined;
      notice = `Run ${buildAgentCliInstallCommand(status.kind, shell)} in your terminal. When it finishes, scan again here.`;
      return;
    }
    await deps.launchInstall(status);
    notice = `${status.label} install started in Terminal. When it finishes, return and scan again.`;
  } catch (error) {
    itemErrors.set(kind, errorMessage(error));
  } finally {
    pending.delete(kind);
    render();
  }
}

export async function mountCliPanel(options?: {
  container: HTMLElement;
  onStatusChange: (statuses: readonly AgentCliStatus[]) => void;
  showCommandInstructions?: boolean;
}): Promise<void> {
  if (options) {
    if (mounted) teardownCliPanel();
    mountTarget = options.container;
    statusListener = options.onStatusChange;
    showCommandInstructions = options.showCommandInstructions ?? false;
  }
  const mount = host();
  if (!mount) return;
  if (mounted) {
    render();
    return;
  }
  mounted = true;
  sectionObserver?.disconnect();
  if (!options) {
    sectionObserver = new MutationObserver(() => {
      if (!mount.classList.contains('is-active')) teardownCliPanel();
    });
    sectionObserver.observe(mount, { attributes: true, attributeFilter: ['class'] });
  }
  render();
  await load();
}

export function teardownCliPanel(): void {
  for (const view of views.values()) { view.flush(); view.dispose(); }
  mounted = false;
  loadSequence += 1;
  loadController?.abort();
  loadController = null;
  sectionObserver?.disconnect();
  sectionObserver = null;
  for (const controller of actionControllers.values()) controller.abort();
  actionControllers.clear();
  actionSequences.clear();
  pending.clear();
  itemErrors.clear();
  openSettings.clear();
  views.clear();
  host()?.replaceChildren();
  mountTarget = null;
  statusListener = null;
  showCommandInstructions = false;
  statuses = [];
  notice = '';
  loadError = '';
}

export function setCliPanelDepsForTests(overrides: Partial<CliPanelDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}
