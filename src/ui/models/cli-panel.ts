import {
  listAgentClis,
  setAgentCliEnabled,
  updateAgentCliSettings,
  verifyAgentCli,
  type AgentCliKind,
  type AgentCliSettingsPatch,
  type AgentCliStatus,
} from '../../models/agent-clis';
import { invalidateProviderCache } from '../../providers/store';
import { el, skeletonRows } from './dom';

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
  list: listAgentClis,
  verify: verifyAgentCli,
  setEnabled: setAgentCliEnabled,
  updateSettings: updateAgentCliSettings,
  launchSignIn: defaultLaunchSignIn,
  launchInstall: defaultLaunchInstall,
};

let deps = defaultDeps;
let mounted = false;
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

function host(): HTMLElement | null {
  return document.getElementById('modelsSection-clis');
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

function renderSettingsForm(status: AgentCliStatus): HTMLDetailsElement {
  const details = el('details', 'models-cli-settings');
  details.open = openSettings.has(status.kind);
  details.addEventListener('toggle', () => {
    if (details.open) openSettings.add(status.kind);
    else openSettings.delete(status.kind);
  });

  const summary = el('summary', 'models-cli-settings__summary', 'Settings');
  const form = el('form', 'models-cli-settings__form');

  const binPath = el('input', 'models-cli-input');
  binPath.type = 'text';
  binPath.name = 'binPath';
  binPath.autocomplete = 'off';
  binPath.placeholder = status.binPath || 'Auto-detect';
  binPath.value = status.binPathOverride ?? '';
  binPath.setAttribute('aria-label', `${status.label} binary path override`);

  const maxConcurrent = el('input', 'models-cli-input models-cli-input--number');
  maxConcurrent.type = 'number';
  maxConcurrent.name = 'maxConcurrent';
  maxConcurrent.min = '1';
  maxConcurrent.max = '16';
  maxConcurrent.step = '1';
  maxConcurrent.required = true;
  maxConcurrent.value = String(status.maxConcurrent);

  form.append(
    field('Binary path override', binPath, 'Leave blank to use automatic detection.'),
    field('Maximum concurrent runs', maxConcurrent),
  );

  if (status.kind === 'claude') {
    const budget = el('input', 'models-cli-input models-cli-input--number');
    budget.type = 'number';
    budget.name = 'maxBudgetUsd';
    budget.min = '0';
    budget.step = '0.01';
    budget.placeholder = 'No limit';
    budget.value = status.maxBudgetUsd === undefined ? '' : String(status.maxBudgetUsd);
    form.append(field('Maximum budget per run (USD)', budget, 'Leave blank for no CLI budget cap.'));
  }

  const utilityLabel = el('label', 'models-cli-check');
  const utility = el('input');
  utility.type = 'checkbox';
  utility.name = 'allowUtilityRoles';
  utility.checked = status.allowUtilityRoles;
  utilityLabel.append(
    utility,
    el('span', 'models-cli-check__copy', 'Allow utility roles'),
    el('span', 'models-cli-field__hint', 'Let Minnow use this CLI for helper tasks such as summaries and titles.'),
  );
  form.append(utilityLabel);

  const save = makeButton('Save settings', 'models-inline-btn is-primary');
  save.type = 'submit';
  save.dataset.label = 'Save settings';
  const isSaving = pending.get(status.kind) === 'Saving settings';
  setBusy(save, isSaving, 'Saving…');
  save.disabled = save.disabled || Boolean(loadController);
  form.append(save);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const patch: AgentCliSettingsPatch = {
      binPath: binPath.value.trim() || null,
      maxConcurrent: Number(maxConcurrent.value),
      allowUtilityRoles: utility.checked,
    };
    if (status.kind === 'claude') {
      const rawBudget = new FormData(form).get('maxBudgetUsd');
      patch.maxBudgetUsd = String(rawBudget ?? '').trim() ? Number(rawBudget) : null;
    }
    void runAction(
      status.kind,
      'Saving settings',
      (signal) => deps.updateSettings(status.kind, patch, signal),
      true,
    );
  });

  details.append(summary, form);
  return details;
}

function renderCli(status: AgentCliStatus): HTMLElement {
  const section = el('article', 'models-cli-row');
  section.dataset.kind = status.kind;

  const identity = el('div', 'models-cli-row__identity');
  const titleLine = el('div', 'models-cli-row__title-line');
  titleLine.append(el('h3', 'models-cli-row__title', status.label));
  titleLine.append(el('span', `models-cli-badge models-cli-badge--${status.installed ? 'ready' : 'neutral'}`, status.installed ? 'Installed' : 'Not installed'));
  titleLine.append(el('span', `models-cli-badge models-cli-badge--${authTone(status)}`, authLabel(status)));
  identity.append(titleLine);

  const metadata = el('p', 'models-cli-row__meta');
  if (status.installed) {
    metadata.textContent = [status.version, status.binPath].filter(Boolean).join(' · ') || 'CLI detected';
  } else {
    metadata.textContent = 'Install the CLI in Terminal, then scan again.';
  }
  identity.append(metadata);
  if (status.kind === 'codex') {
    identity.append(el(
      'p',
      'models-cli-row__meta',
      "Sign in creates a file-backed Codex login for Minnow's isolated runs. Your Codex config stays unchanged.",
    ));
  }

  const enableLabel = el('label', 'models-cli-enable');
  const enable = el('input');
  enable.type = 'checkbox';
  enable.checked = status.enabled;
  enable.disabled = !status.installed || pending.has(status.kind) || Boolean(loadController);
  enable.setAttribute('aria-label', `Enable ${status.label} provider`);
  enable.addEventListener('change', () => {
    const next = enable.checked;
    enable.disabled = true;
    void runAction(
      status.kind,
      next ? 'Enabling' : 'Disabling',
      (signal) => deps.setEnabled(status.kind, next, signal),
      true,
    );
  });
  enableLabel.append(enable, el('span', 'models-cli-enable__label', status.enabled ? 'Enabled' : 'Disabled'));

  const actions = el('div', 'models-cli-row__actions');
  const verifying = pending.get(status.kind) === 'Verifying';
  const verify = makeButton('Verify');
  verify.dataset.label = 'Verify';
  setBusy(verify, verifying, 'Verifying…');
  verify.disabled = verify.disabled || !status.installed || Boolean(loadController);
  verify.addEventListener('click', () => {
    void runAction(status.kind, 'Verifying', (signal) => deps.verify(status.kind, signal));
  });
  actions.append(verify);

  if (!status.installed) {
    const install = makeButton('Install', 'models-inline-btn is-primary');
    const installing = pending.get(status.kind) === 'Opening terminal';
    setBusy(install, installing, 'Opening…');
    install.disabled = install.disabled || Boolean(loadController);
    install.addEventListener('click', () => void launchInstall(status.kind));
    actions.append(install);
  } else if (status.authStatus !== 'signed-in' && status.authStatus !== 'token') {
    const signIn = makeButton('Sign in', 'models-inline-btn is-primary');
    signIn.disabled = pending.has(status.kind) || Boolean(loadController);
    signIn.addEventListener('click', () => void launchSignIn(status.kind));
    actions.append(signIn);
  }

  section.append(identity, enableLabel, actions);

  const error = itemErrors.get(status.kind);
  if (error) section.append(el('p', 'models-cli-row__error', error));
  section.append(renderSettingsForm(status));
  return section;
}

function render(): void {
  const mount = host();
  if (!mount || !mounted) return;
  mount.replaceChildren();

  const header = el('div', 'models-cli-header');
  const heading = el('div');
  heading.append(
    el('h2', undefined, 'CLIs'),
    el('p', 'models-lead', 'Use installed coding CLIs as model providers. Minnow keeps tool approvals and results in the same chat flow.'),
  );
  const scan = makeButton(statuses.length ? 'Scan again' : 'Scan for CLIs');
  scan.dataset.label = statuses.length ? 'Scan again' : 'Scan for CLIs';
  scan.disabled = Boolean(loadController) || pending.size > 0;
  if (loadController) scan.textContent = 'Scanning…';
  scan.addEventListener('click', () => void scanAll());
  header.append(heading, scan);
  mount.append(header);

  const live = el('div', `models-cli-notice${loadError ? ' is-error' : ''}`);
  live.setAttribute(loadError ? 'role' : 'aria-live', loadError ? 'alert' : 'polite');
  live.textContent = loadError || notice;
  if (live.textContent) mount.append(live);

  if (!statuses.length && loadController) {
    mount.append(skeletonRows(3));
    return;
  }

  if (!statuses.length) {
    mount.append(el('p', 'models-cli-empty', loadError ? 'Could not load CLI status.' : 'No supported CLIs were reported by the tool server.'));
    return;
  }

  const list = el('div', 'models-cli-list');
  for (const status of sortedStatuses()) list.append(renderCli(status));
  mount.append(list);
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
    const next = await deps.list(controller.signal);
    if (!mounted || controller.signal.aborted || sequence !== loadSequence) return;
    statuses = next;
  } catch (error) {
    if (controller.signal.aborted || sequence !== loadSequence) return;
    loadError = errorMessage(error);
  } finally {
    if (sequence === loadSequence) loadController = null;
    render();
  }
}

async function scanAll(): Promise<void> {
  if (pending.size > 0) return;
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
  const results = await Promise.allSettled(
    sortedStatuses().map((status) => deps.verify(status.kind, controller.signal)),
  );
  if (!mounted || controller.signal.aborted || sequence !== loadSequence) return;
  let failures = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') replaceStatus(result.value);
    else failures += 1;
  }
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
  if (loadController) return;
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
  itemErrors.delete(kind);
  notice = '';
  pending.set(kind, 'Opening terminal');
  render();
  try {
    const status = statuses.find((row) => row.kind === kind);
    if (!status) throw new Error('CLI status is unavailable. Scan again and retry.');
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
  itemErrors.delete(kind);
  notice = '';
  pending.set(kind, 'Opening terminal');
  render();
  try {
    const status = statuses.find((row) => row.kind === kind);
    if (!status) throw new Error('CLI status is unavailable. Scan again and retry.');
    await deps.launchInstall(status);
    notice = `${status.label} install started in Terminal. When it finishes, return and scan again.`;
  } catch (error) {
    itemErrors.set(kind, errorMessage(error));
  } finally {
    pending.delete(kind);
    render();
  }
}

export async function mountCliPanel(): Promise<void> {
  const mount = host();
  if (!mount) return;
  if (mounted) {
    render();
    return;
  }
  mounted = true;
  sectionObserver?.disconnect();
  sectionObserver = new MutationObserver(() => {
    if (!mount.classList.contains('is-active')) teardownCliPanel();
  });
  sectionObserver.observe(mount, { attributes: true, attributeFilter: ['class'] });
  render();
  await load();
}

export function teardownCliPanel(): void {
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
  statuses = [];
  notice = '';
  loadError = '';
}

export function setCliPanelDepsForTests(overrides: Partial<CliPanelDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}
