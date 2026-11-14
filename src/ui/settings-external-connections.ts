import type { ShellProfile } from '../api/terminal-pty';
import { mountGitHubAccount } from './github-account';
import { runCommandInNewTerminal } from './terminal-command-launcher';
import { notify, showToast } from './toast';
import '../styles/settings-external-connections.css';

const SERVICES = [
  {
    id: 'fly', name: 'Fly.io', purpose: 'Apps, deployments, and logs.', skill: '/fly-cli',
    docs: 'https://docs.fly.io/flyctl/install',
    install: {
      win32: 'winget install --id Fly-io.flyctl --exact',
      darwin: 'brew install flyctl',
      linux: 'curl -fsSL https://fly.io/install.sh | sh',
    },
  },
  {
    id: 'supabase', name: 'Supabase', purpose: 'Projects, migrations, and Edge Functions.', skill: '/supabase-cli',
    docs: 'https://supabase.com/docs/guides/local-development/cli/getting-started',
    install: {
      // Scoop is not included with Windows. Use the guide rather than assume it exists.
      win32: '',
      darwin: 'brew install supabase/tap/supabase',
      linux: '',
    },
  },
  {
    id: 'clerk', name: 'Clerk', purpose: 'Application authentication and configuration.', skill: '/clerk-cli',
    docs: 'https://clerk.com/docs/cli',
    install: {
      win32: 'npm install -g clerk',
      darwin: 'npm install -g clerk',
      linux: 'npm install -g clerk',
    },
  },
] as const;

type Service = typeof SERVICES[number];
type Connection = {
  state: 'connected' | 'signed-out' | 'unverified' | 'missing' | 'unavailable';
  bin?: 'fly' | 'flyctl' | 'supabase' | 'clerk';
};
type Connections = {
  platform: string;
  shellProfileId?: string;
  connections: Record<Service['id'], Connection>;
};

const STATUS_LABELS: Record<Connection['state'], string> = {
  connected: 'Connected',
  'signed-out': 'Signed out',
  unverified: 'CLI found · Sign-in could not be verified',
  missing: 'CLI needed',
  unavailable: 'Could not check CLI',
};

const mounts = new WeakMap<HTMLElement, () => void>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function action(label: string): HTMLButtonElement {
  const button = el('button', 'settings-action-btn', label);
  button.type = 'button';
  return button;
}

function setupCommand(service: Service, platform: string, profile?: ShellProfile, bin?: Connection['bin']): string {
  const powershell = platform === 'win32' && /(?:powershell|pwsh)(?:\.exe)?$/i.test(profile?.shell ?? '');
  const cmd = platform === 'win32' && /\bcmd(?:\.exe)?$/i.test(profile?.shell ?? '');
  let command: string = service.install[platform as keyof Service['install']];
  if (bin) {
    if (service.id === 'supabase') command = `${bin} login`;
    else if (service.id === 'clerk') command = `${powershell ? 'cmd.exe /d /c ' : ''}${bin} auth login --mode human`;
    else command = `${bin} auth login`;
  } else if (service.id === 'clerk' && powershell) {
    command = command.replace(/^npm /, 'npm.cmd ');
  }
  // Account operations should resolve commands and vendor config outside the repository.
  if (powershell) return `& { Set-Location -LiteralPath $env:USERPROFILE -ErrorAction Stop; ${command} }`;
  if (cmd) return `cd /d "%USERPROFILE%" && (${command})`;
  return `cd ~ && ${command}`;
}

export function renderExternalConnections(mount: HTMLElement): void {
  mounts.get(mount)?.();
  const controller = new AbortController();
  const group = el('div', 'settings-group');
  const rows = el('div', 'settings-group__body external-connections');
  const toolbar = el('div', 'settings-actions external-connections__toolbar');
  const check = action('Check workspace CLIs');
  const message = el('p', 'settings-field-hint');
  message.setAttribute('role', 'status');
  toolbar.append(check, message);
  group.append(rows);
  mount.replaceChildren(toolbar, group);
  const disposeGitHub = mountGitHubAccount(rows, undefined, 'h3', true);
  mounts.set(mount, () => {
    controller.abort();
    disposeGitHub();
  });

  const views = SERVICES.map(service => {
    const row = el('section', 'settings-row settings-row--actions external-connections__row');
    row.dataset.settingsSearchKey = `externalConnections.${service.id}`;
    const label = el('div', 'settings-row__label');
    const details = el('p', 'settings-field-hint external-connections__details');
    details.append(service.purpose, ' Use ', el('code', '', service.skill), ' in chat.');
    const status = el('p', 'external-connections__status', 'Checking…');
    status.setAttribute('role', 'status');
    label.append(el('h3', 'settings-row__title', service.name), details, status);
    const controls = el('div', 'settings-actions');
    const button = action('Sign in');
    const docs = el('a', 'settings-action-btn', 'Install guide');
    docs.href = service.docs;
    docs.target = '_blank';
    docs.rel = 'noopener noreferrer';
    docs.setAttribute('aria-label', `${service.name} install guide`);
    button.hidden = docs.hidden = true;
    controls.append(button, docs);
    row.append(label, controls);
    rows.append(row);
    return { service, row, status, button, docs };
  });

  async function checkConnections(): Promise<void> {
    check.disabled = true;
    rows.setAttribute('aria-busy', 'true');
    message.textContent = 'Checking the workspace shell…';
    for (const { button } of views) button.disabled = true;
    try {
      const response = await fetch('/api/system/external-connections', {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(32_000)]),
      });
      if (controller.signal.aborted) return;
      if (response.status === 403) {
        check.hidden = true;
        message.textContent = 'Open External Connections on the computer running Minnow.';
        for (const { status } of views) status.textContent = 'Desktop setup';
        return;
      }
      if (!response.ok) throw new Error('Connection check failed');
      const result = await response.json() as Connections;
      if (controller.signal.aborted) return;
      message.textContent = '';
      for (const { service, row, status, button, docs } of views) {
        const connection = result.connections[service.id];
        const { state, bin } = connection;
        const install = service.install[result.platform as keyof Service['install']];
        row.dataset.state = state;
        status.textContent = STATUS_LABELS[state];
        docs.hidden = state !== 'missing' && state !== 'unavailable';
        button.textContent = bin ? 'Sign in' : 'Install CLI';
        button.setAttribute('aria-label', bin ? `Sign in to ${service.name}` : `Install the ${service.name} CLI`);
        button.hidden = bin ? state === 'connected' : state !== 'missing' || !install;
        button.disabled = false;
        button.onclick = async () => {
          for (const view of views) view.button.disabled = true;
          check.disabled = true;
          try {
            await runCommandInNewTerminal(
              profile => setupCommand(service, result.platform, profile, bin),
              { shellProfileId: result.shellProfileId, privateHistory: Boolean(bin) },
            );
            notify({
              tone: 'info',
              message: bin ? 'Finish signing in, then return to External Connections to check the connection.'
                : 'Finish installing, then check the connection. Restart Minnow if the CLI is still missing.',
            });
          } catch (error) {
            showToast(error instanceof Error ? error.message : 'Could not open the terminal.', 'error');
          } finally {
            for (const view of views) view.button.disabled = false;
            check.disabled = false;
          }
        };
      }
    } catch {
      if (controller.signal.aborted) return;
      message.textContent = 'Could not check connections. Try again.';
      for (const { row, status, button } of views) {
        delete row.dataset.state;
        status.textContent = 'Status unavailable';
        button.hidden = true;
      }
    } finally {
      check.disabled = false;
      rows.removeAttribute('aria-busy');
    }
  }

  check.onclick = () => void checkConnections();
  void checkConnections();
}
