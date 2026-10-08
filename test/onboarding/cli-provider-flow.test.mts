import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { providerCliStep, isOnboardingCliReady } from '../../src/onboarding/steps/cli.ts';
import { modelPickStep } from '../../src/onboarding/steps/model.ts';
import { buildOnboardingContext, createDefaultOnboardingState } from '../../src/onboarding/state-core.ts';
import { setCliPanelDepsForTests } from '../../src/ui/models/cli-panel.ts';
import type { AgentCliStatus } from '../../src/models/agent-clis.ts';

function cli(patch: Partial<AgentCliStatus> = {}): AgentCliStatus {
  return { kind: 'codex', providerId: 'codex-cli', label: 'Codex CLI', installed: true,
    authStatus: 'signed-in', enabled: false, hasCliToken: false, allowUtilityRoles: false,
    maxConcurrent: 1, sessionMode: 'auto', installCommand: 'install', loginCommand: 'login',
    checkedAt: '', ...patch };
}

test('only installed, enabled and authenticated CLIs are ready', () => {
  assert.equal(isOnboardingCliReady(cli({ enabled: true })), true);
  assert.equal(isOnboardingCliReady(cli({ enabled: true, authStatus: 'token' })), true);
  for (const patch of [{ installed: false }, { enabled: false }, { authStatus: 'unknown' }, { authStatus: 'signed-out' }]) {
    assert.equal(isOnboardingCliReady(cli({ enabled: true, ...patch } as Partial<AgentCliStatus>)), false);
  }
});

test('CLI detection failure can retry and authentication updates remove a provider from progression', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  globalThis.FormData = win.FormData as unknown as typeof FormData;
  const container = document.createElement('div');
  document.body.append(container);
  const ctx = buildOnboardingContext(createDefaultOnboardingState(), { serverAvailable: true, configServerAvailable: true });
  ctx.providerPath = 'cli';
  let enabled = false;
  let attempts = 0;
  const actions = { next() {}, back() {}, skip() {}, patchContext(patch: any) { Object.assign(ctx, patch); },
    setPrimaryEnabled(value: boolean) { enabled = value; }, setPrimaryLabel() {}, stepIndex: 4, totalSteps: 12 };
  setCliPanelDepsForTests({ list: async () => {
    if (++attempts === 1) throw new Error('server unavailable');
    return [cli({ enabled: true })];
  }, verify: async () => cli({ enabled: true, authStatus: 'signed-out' }),
  usage: async () => ({ kind: 'codex', status: 'unavailable', windows: [], plan: null, fetchedAt: null,
    checkedAt: '', retryAt: null, message: null }) });
  const cleanup = providerCliStep.render(container, ctx, actions);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(enabled, false);
    assert.match(container.textContent!, /Scan again to retry/);
    container.querySelector<HTMLButtonElement>('.models-cli-header > button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(enabled, true);
    container.querySelector<HTMLButtonElement>('.models-cli-header > button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(enabled, false);
    assert.equal(ctx.providerId, null);
  } finally {
    if (typeof cleanup === 'function') cleanup();
    setCliPanelDepsForTests(null);
    win.close();
  }
});

test('CLI onboarding waits for an enabled verified agent and restores its provider for model picking', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  globalThis.FormData = win.FormData as unknown as typeof FormData;
  const container = document.createElement('div');
  document.body.append(container);
  const ctx = buildOnboardingContext(createDefaultOnboardingState(), { serverAvailable: true, configServerAvailable: true });
  ctx.providerPath = 'cli';
  let enabled = false;
  const actions = { next() {}, back() {}, skip() {}, patchContext(patch: any) { Object.assign(ctx, patch); },
    setPrimaryEnabled(value: boolean) { enabled = value; }, setPrimaryLabel() {}, stepIndex: 4, totalSteps: 12 };
  setCliPanelDepsForTests({ list: async () => [cli()], setEnabled: async () => cli({ enabled: true }),
    usage: async () => ({ kind: 'codex', status: 'unavailable', windows: [], plan: null, fetchedAt: null,
      checkedAt: '', retryAt: null, message: null }) });
  const cleanup = providerCliStep.render(container, ctx, actions);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(enabled, false);
    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Enable Codex CLI provider"]')!;
    assert.ok(toggle);
    toggle.checked = true;
    toggle.dispatchEvent(new win.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(enabled, true);
    assert.equal(ctx.providerId, 'codex-cli');
    await providerCliStep.commit(ctx);
    ctx.state.steps['provider-choice'] = { done: true, data: { path: 'cli' } };
    const restored = buildOnboardingContext(ctx.state, { serverAvailable: true, configServerAvailable: true });
    assert.equal(restored.providerPath, 'cli');
    assert.equal(restored.providerId, 'codex-cli');
    assert.equal(modelPickStep.isApplicable(restored), true);
    if (typeof cleanup === 'function') cleanup();
    ctx.modelId = 'saved-model';
    setCliPanelDepsForTests({ list: async () => [
      cli({ kind: 'claude', providerId: 'claude-code-cli', label: 'Claude Code', enabled: true }),
      cli({ enabled: true }),
    ], usage: async () => ({ kind: 'codex', status: 'unavailable', windows: [], plan: null, fetchedAt: null,
      checkedAt: '', retryAt: null, message: null }) });
    const restoredCleanup = providerCliStep.render(container, ctx, actions);
    try {
      assert.equal(ctx.providerId, 'codex-cli', 'initial loading must retain the saved binding');
      assert.equal(ctx.modelId, 'saved-model');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(container.querySelector<HTMLSelectElement>('select[aria-label="Default CLI agent"]')!.value, 'codex-cli');
      assert.equal(ctx.modelId, 'saved-model', 'status refresh must not clear the existing model');
    } finally {
      if (typeof restoredCleanup === 'function') restoredCleanup();
    }
  } finally {
    if (typeof cleanup === 'function') cleanup();
    setCliPanelDepsForTests(null);
    win.close();
  }
});
