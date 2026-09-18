import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import type { AgentCliKind, AgentCliStatus } from '../../src/models/agent-clis.ts';
import {
  buildAgentCliInstallCommand,
  buildAgentCliLoginCommand,
  mountCliPanel,
  setCliPanelDepsForTests,
  teardownCliPanel,
} from '../../src/ui/models/cli-panel.ts';

let win: Window;

function cli(kind: AgentCliKind, patch: Partial<AgentCliStatus> = {}): AgentCliStatus {
  const labels = { claude: 'Claude Code', codex: 'Codex CLI', cursor: 'Cursor Agent' };
  return {
    kind,
    providerId: `${kind}-cli`,
    label: labels[kind],
    installed: true,
    authStatus: 'signed-in',
    enabled: false,
    version: '1.2.3',
    binPath: `/usr/local/bin/${kind}`,
    binPathOverride: undefined,
    hasCliToken: false,
    allowUtilityRoles: false,
    maxConcurrent: 1,
    sessionMode: 'replay',
    installCommand: `npm install ${kind}`,
    loginCommand: `${kind} login`,
    checkedAt: '2026-09-08T12:00:00.000Z',
    ...patch,
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Models CLI panel', () => {
  beforeEach(() => {
    win = new Window({ url: 'http://localhost/#/app/models/clis' });
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: win.navigator,
    });
    globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
    globalThis.MutationObserver = win.MutationObserver as unknown as typeof MutationObserver;
    globalThis.FormData = win.FormData as unknown as typeof FormData;
    win.document.body.innerHTML = '<section id="modelsSection-clis" class="is-active"></section>';
  });

  afterEach(() => {
    teardownCliPanel();
    setCliPanelDepsForTests(null);
    win.close();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    Reflect.deleteProperty(globalThis, 'navigator');
    delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
    delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  });

  test('shows install, authentication, enabled, and CLI-specific setting states', async () => {
    setCliPanelDepsForTests({
      list: async () => [
        cli('claude', { installed: false, authStatus: 'unknown', version: undefined, binPath: undefined }),
        cli('codex', { enabled: true, authStatus: 'token' }),
        cli('cursor', { authStatus: 'signed-out' }),
      ],
    });

    await mountCliPanel();

    const rows = [...document.querySelectorAll<HTMLElement>('.models-cli-row')];
    assert.deepEqual(rows.map((row) => row.dataset.kind), ['claude', 'codex', 'cursor']);
    assert.match(rows[0].textContent ?? '', /Not installed/);
    assert.ok([...rows[0].querySelectorAll('button')].some((button) => button.textContent === 'Install'));
    assert.equal(rows[0].querySelector('.models-cli-install'), null);
    assert.match(rows[1].textContent ?? '', /Token configured/);
    assert.match(rows[1].textContent ?? '', /file-backed Codex login/);
    assert.equal(rows[1].querySelector<HTMLInputElement>('input[aria-label="Enable Codex CLI provider"]')?.checked, true);
    assert.match(rows[2].textContent ?? '', /Signed out/);
    assert.ok(rows[0].querySelector('input[name="maxBudgetUsd"]'));
    assert.equal(rows[2].querySelector('input[name="maxBudgetUsd"]'), null);
    assert.equal(rows[2].querySelector<HTMLInputElement>('input[name="allowUtilityRoles"]')?.checked, false);
    const cursorPath = rows[2].querySelector<HTMLInputElement>('input[name="binPath"]');
    assert.equal(cursorPath?.value, '');
    assert.equal(cursorPath?.placeholder, '/usr/local/bin/cursor');
  });

  test('uses the PowerShell Cursor installer on Windows shells', () => {
    assert.equal(
      buildAgentCliInstallCommand('claude'),
      'npm install -g @anthropic-ai/claude-code',
    );
    assert.equal(
      buildAgentCliInstallCommand('cursor', '/bin/zsh'),
      'curl https://cursor.com/install -fsS | bash',
    );
    assert.equal(
      buildAgentCliInstallCommand('cursor', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
      "irm 'https://cursor.com/install?win32=true' | iex",
    );
    assert.equal(
      buildAgentCliInstallCommand('cursor', 'C:\\Windows\\System32\\cmd.exe'),
      "powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm 'https://cursor.com/install?win32=true' | iex\"",
    );
  });

  test('uses fixed auth argv and safely quotes an executable override for the tab shell', () => {
    assert.equal(buildAgentCliLoginCommand({ kind: 'claude' }), 'claude auth login');
    assert.equal(
      buildAgentCliLoginCommand({ kind: 'codex' }),
      'codex -c cli_auth_credentials_store=file login',
    );
    assert.equal(
      buildAgentCliLoginCommand(
        { kind: 'claude', binPath: "C:\\Tools\\Claude's CLI\\claude.exe" },
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      ),
      "& 'C:\\Tools\\Claude''s CLI\\claude.exe' auth login",
    );
    assert.equal(
      buildAgentCliLoginCommand({ kind: 'cursor', binPath: "/opt/cursor's agent" }, '/bin/zsh'),
      `'${"/opt/cursor's agent".replaceAll("'", `'"'"'`)}' login`,
    );
  });

  test('enables a provider and saves only the supported inline settings', async () => {
    const enableCalls: Array<{ kind: AgentCliKind; enabled: boolean }> = [];
    const settingsCalls: Array<{ kind: AgentCliKind; patch: Record<string, unknown> }> = [];
    setCliPanelDepsForTests({
      list: async () => [cli('claude')],
      setEnabled: async (kind, enabled) => {
        enableCalls.push({ kind, enabled });
        return cli(kind, { enabled });
      },
      updateSettings: async (kind, patch) => {
        settingsCalls.push({ kind, patch });
        return cli(kind, {
          maxConcurrent: patch.maxConcurrent,
          allowUtilityRoles: patch.allowUtilityRoles,
          maxBudgetUsd: patch.maxBudgetUsd ?? undefined,
        });
      },
    });
    await mountCliPanel();

    document.querySelector<HTMLInputElement>('input[aria-label="Enable Claude Code provider"]')?.click();
    await tick();
    assert.deepEqual(enableCalls, [{ kind: 'claude', enabled: true }]);

    const form = document.querySelector<HTMLFormElement>('.models-cli-settings__form');
    assert.ok(form);
    form.querySelector<HTMLInputElement>('input[name="binPath"]')!.value = '  /opt/claude  ';
    form.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!.value = '4';
    form.querySelector<HTMLInputElement>('input[name="maxBudgetUsd"]')!.value = '2';
    form.querySelector<HTMLInputElement>('input[name="allowUtilityRoles"]')!.checked = true;
    // happy-dom incorrectly rejects number inputs with fractional step values.
    form.reportValidity = () => true;
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    assert.deepEqual(settingsCalls, [{
      kind: 'claude',
      patch: {
        binPath: '/opt/claude',
        maxConcurrent: 4,
        allowUtilityRoles: true,
        maxBudgetUsd: 2,
      },
    }]);
  });

  test('launches sign-in through the terminal dependency and ignores results after disposal', async () => {
    const signIns: AgentCliKind[] = [];
    let resolveList!: (rows: AgentCliStatus[]) => void;
    setCliPanelDepsForTests({
      list: async () => [cli('cursor', { authStatus: 'signed-out' })],
      launchSignIn: async (status) => { signIns.push(status.kind); },
    });
    await mountCliPanel();
    const signIn = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Sign in');
    assert.ok(signIn);
    signIn.click();
    await tick();
    assert.deepEqual(signIns, ['cursor']);
    assert.match(document.body.textContent ?? '', /cursor-agent login opened in Terminal/);

    teardownCliPanel();
    setCliPanelDepsForTests({
      list: () => new Promise((resolve) => { resolveList = resolve; }),
    });
    const mounting = mountCliPanel();
    teardownCliPanel();
    resolveList([cli('claude')]);
    await mounting;
    assert.equal(document.querySelector('.models-cli-row'), null);
  });

  test('launches install through the terminal dependency', async () => {
    const installs: AgentCliKind[] = [];
    setCliPanelDepsForTests({
      list: async () => [cli('cursor', { installed: false, authStatus: 'signed-out' })],
      launchInstall: async (status) => { installs.push(status.kind); },
    });
    await mountCliPanel();
    const install = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Install');
    assert.ok(install);
    install.click();
    await tick();
    assert.deepEqual(installs, ['cursor']);
    assert.match(document.body.textContent ?? '', /Cursor Agent install started in Terminal/);
  });
});
