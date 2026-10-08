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

  test('verifies an installed CLI automatically when the panel opens', async () => {
    const verified: AgentCliKind[] = [];
    setCliPanelDepsForTests({
      list: async () => [cli('claude', { authStatus: 'unknown' })],
      verify: async (kind) => {
        verified.push(kind);
        return cli(kind, { authStatus: 'signed-in' });
      },
    });

    await mountCliPanel();
    await tick();
    assert.deepEqual(verified, ['claude']);
    assert.match(document.querySelector('.models-cli-row')?.textContent ?? '', /Signed in/);
  });

  test('loads quota for Codex and Claude in summaries and details without querying Cursor', async () => {
    const reads: AgentCliKind[] = [];
    setCliPanelDepsForTests({
      list: async () => [cli('claude'), cli('codex'), cli('cursor')],
      usage: async (kind) => {
        reads.push(kind);
        return { kind, status: 'ready', plan: 'pro', message: null, retryAt: null,
          fetchedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
          windows: [{ id: 'week', label: 'Weekly', usedPercent: 34, windowMinutes: 10080, resetsAt: null }] };
      },
    });
    await mountCliPanel();
    await tick();
    assert.deepEqual(reads.sort(), ['claude', 'codex']);
    for (const kind of [...reads]) {
      const row = document.querySelector(`[data-kind="${kind}"]`)!;
      assert.equal(row.querySelector('.models-cli-row__usage')?.textContent, '66% left');
      assert.match(row.querySelector('.cli-account-usage')?.textContent ?? '', /Reset time unavailable/);
      row.querySelector<HTMLButtonElement>('.cli-account-usage__refresh')!.click();
    }
    await tick();
    assert.equal(reads.length, 4);
    assert.equal(document.querySelector('[data-kind="cursor"] .cli-account-usage'), null);
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
          contextWindowTokens: patch.contextWindowTokens ?? undefined,
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
    form.querySelector<HTMLInputElement>('input[name="maxBudgetUsd"]')!.step = 'any';
    form.querySelector<HTMLInputElement>('input[name="contextWindowTokens"]')!.value = '1000000';
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
        contextWindowTokens: 1000000,
      },
    }]);
    const savedForm = document.querySelector<HTMLFormElement>('.models-cli-settings__form')!;
    const context = savedForm.querySelector<HTMLInputElement>('input[name="contextWindowTokens"]')!;
    assert.equal(context.value, '1000000');
    context.value = '';
    savedForm.reportValidity = () => true;
    savedForm.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(settingsCalls.at(-1)!.patch.contextWindowTokens, null);
    assert.equal(document.querySelector<HTMLInputElement>('input[name="contextWindowTokens"]')!.value, '');
  });

  test('auto-saves inline settings when a field changes (MIN-109)', async () => {
    const settingsCalls: Array<{ kind: AgentCliKind; patch: Record<string, unknown> }> = [];
    setCliPanelDepsForTests({
      list: async () => [cli('claude')],
      updateSettings: async (kind, patch) => {
        settingsCalls.push({ kind, patch });
        return cli(kind, { maxConcurrent: patch.maxConcurrent });
      },
    });
    await mountCliPanel();

    const form = document.querySelector<HTMLFormElement>('.models-cli-settings__form');
    assert.ok(form);
    form.reportValidity = () => true;
    const maxConcurrent = form.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!;
    maxConcurrent.value = '3';
    maxConcurrent.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();

    assert.equal(settingsCalls.length, 1);
    assert.equal(settingsCalls[0]!.patch.maxConcurrent, 3);
    assert.match(form.textContent ?? '', /Saved/);
    assert.equal(form.isConnected, true, 'the settings form stays open after saving');
  });

  test('uses expandable connection rows with no save button', async () => {
    setCliPanelDepsForTests({ list: async () => [cli('claude')] });
    await mountCliPanel();
    const details = document.querySelector<HTMLDetailsElement>('.models-cli-settings')!;
    assert.equal(details.open, false);
    assert.ok(details.querySelector('summary .models-cli-logo svg'));
    assert.match(details.querySelector('summary')!.textContent!, /Claude Code.*Signed in.*Disabled/);
    assert.equal(details.querySelector('button[type="submit"]'), null);
    assert.ok(details.querySelector('.models-cli-advanced input[name="binPath"]'));
    assert.equal(details.querySelector('input[role="switch"]')?.getAttribute('aria-label'), 'Enable Claude Code provider');
  });

  test('preserves native session fallback messages and updates them after verification', async () => {
    setCliPanelDepsForTests({
      list: async () => [cli('cursor', { fallbackReason: 'This Cursor version uses isolated replay.' })],
      verify: async (kind) => cli(kind, { transport: 'acp', restartResumeSupported: true }),
    });
    await mountCliPanel();
    const row = document.querySelector<HTMLElement>('[data-kind="cursor"]')!;
    assert.match(row.textContent!, /This Cursor version uses isolated replay/);
    row.querySelector<HTMLButtonElement>('.models-cli-row__actions button')!.click();
    await tick();
    assert.doesNotMatch(row.textContent!, /This Cursor version uses isolated replay/);
    assert.match(row.textContent!, /Matching saved conversations resume after eviction or restart/);
  });

  test('debounces typing and keeps focus and drafts when another CLI updates', async () => {
    const patches: Record<string, unknown>[] = [];
    setCliPanelDepsForTests({
      list: async () => [cli('claude'), cli('codex')],
      verify: async (kind) => cli(kind),
      updateSettings: async (kind, patch) => {
        patches.push(patch);
        return cli(kind, { maxConcurrent: patch.maxConcurrent });
      },
    });
    await mountCliPanel();
    const input = document.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!;
    input.focus();
    input.value = '2';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    input.value = '3';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(patches.length, 0);
    document.querySelector<HTMLButtonElement>('[data-kind="codex"] .models-cli-row__actions button')!.click();
    await tick();
    assert.equal(document.activeElement, input);
    assert.equal(input.value, '3');
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(patches.length, 1);
    assert.equal(patches[0].maxConcurrent, 3);
    assert.equal(document.activeElement, input);
    assert.equal(document.querySelector('input[name="maxConcurrent"]'), input);
    assert.match(document.querySelector('.models-cli-save-status')!.textContent!, /Saved/);
  });

  test('serializes rapid edits and drains queued changes after leaving the page', async () => {
    const calls: number[] = [];
    let finishFirst!: (status: AgentCliStatus) => void;
    let stored = cli('claude');
    setCliPanelDepsForTests({
      list: async () => [stored],
      updateSettings: async (kind, patch) => {
        calls.push(patch.maxConcurrent!);
        if (calls.length === 1) return new Promise((resolve) => { finishFirst = resolve; });
        stored = cli(kind, { maxConcurrent: patch.maxConcurrent });
        return stored;
      },
    });
    await mountCliPanel();
    const input = document.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!;
    input.value = '2';
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    input.value = '4';
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.deepEqual(calls, [2]);
    assert.equal(input.disabled, false);
    teardownCliPanel();
    finishFirst(cli('claude', { maxConcurrent: 2 }));
    await tick();
    assert.deepEqual(calls, [2, 4]);
    await mountCliPanel();
    assert.equal(document.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!.value, '4');
  });

  test('keeps invalid drafts and validation feedback when an earlier save completes', async () => {
    let finish!: (status: AgentCliStatus) => void;
    const calls: number[] = [];
    setCliPanelDepsForTests({
      list: async () => [cli('claude')],
      updateSettings: (kind, patch) => {
        calls.push(patch.maxConcurrent!);
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    await mountCliPanel();
    const input = document.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!;
    input.value = '3';
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    input.value = '17';
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    finish(cli('claude', { maxConcurrent: 3 }));
    await tick();
    assert.deepEqual(calls, [3]);
    assert.equal(input.value, '17');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(document.querySelector<HTMLElement>('.models-cli-save-status')!.dataset.tone, 'error');
    assert.doesNotMatch(document.querySelector('.models-cli-save-status')!.textContent!, /Saved/);
  });

  test('retains failed settings and retries the current draft without replacing the form', async () => {
    const patches: Record<string, unknown>[] = [];
    setCliPanelDepsForTests({
      list: async () => [cli('cursor')],
      updateSettings: async (kind, patch) => {
        patches.push(patch);
        if (patches.length === 1) throw new Error('Connection lost');
        return cli(kind, { maxConcurrent: patch.maxConcurrent });
      },
    });
    await mountCliPanel();
    const form = document.querySelector<HTMLFormElement>('.models-cli-settings__form')!;
    const input = form.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!;
    input.value = '5';
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();
    assert.match(form.textContent!, /Could not save: Connection lost/);
    const retry = [...form.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!;
    assert.equal(retry.hidden, false);
    assert.equal(input.value, '5');
    retry.click();
    await tick();
    assert.equal(patches.length, 2);
    assert.deepEqual(patches[1], patches[0]);
    assert.equal(retry.hidden, true);
    assert.match(form.textContent!, /Saved/);
    assert.equal(document.querySelector('.models-cli-settings__form'), form);
  });

  test('flushes a debounced edit on navigation and ignores its stale UI result', async () => {
    let finish!: (status: AgentCliStatus) => void;
    const calls: number[] = [];
    setCliPanelDepsForTests({
      list: async () => [cli('claude')],
      updateSettings: (kind, patch) => {
        calls.push(patch.maxConcurrent!);
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    await mountCliPanel();
    const input = document.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!;
    input.value = '6';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.deepEqual(calls, []);
    teardownCliPanel();
    assert.deepEqual(calls, [6]);
    setCliPanelDepsForTests({ list: async () => [cli('claude', { maxConcurrent: 8 })] });
    const mounting = mountCliPanel();
    finish(cli('claude', { maxConcurrent: 6 }));
    await mounting;
    await tick();
    assert.equal(document.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!.value, '8');
    assert.equal(document.querySelector('.models-cli-save-status')!.textContent, 'Changes save automatically.');
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

  test('embedded onboarding shows commands without opening the hidden application terminal', async () => {
    let terminalLaunches = 0;
    const states: string[][] = [];
    const container = document.createElement('div');
    document.body.append(container);
    setCliPanelDepsForTests({
      list: async () => [cli('cursor', { installed: false, authStatus: 'signed-out' })],
      launchInstall: async () => { terminalLaunches += 1; },
    });
    await mountCliPanel({ container, showCommandInstructions: true,
      onStatusChange: (rows) => states.push(rows.map((row) => row.providerId)) });
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Install')!.click();
    await tick();
    assert.equal(terminalLaunches, 0);
    assert.match(container.textContent ?? '', /Run .* in your terminal/);
    assert.deepEqual(states.at(-1), ['cursor-cli']);
    teardownCliPanel();
    assert.equal(container.childElementCount, 0);
  });
});
