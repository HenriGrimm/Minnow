import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { githubStep } from '../../src/onboarding/steps/github';
import { buildOnboardingContext, createDefaultOnboardingState } from '../../src/onboarding/state-core';
import { mountGitHubAccount } from '../../src/ui/github-account';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function setup(t: any, response: (op: string) => unknown) {
  const win = new Window();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => new Response(JSON.stringify(await response(JSON.parse(String(options.body)).op))));
  Object.assign(globalThis, { window: win, document: win.document });
  const container = document.createElement('div');
  document.body.append(container);
  t.after(() => win.close());
  return container;
}

test('onboarding reuses an existing login and remains skippable without the CLI', async t => {
  let installed = true;
  const container = setup(t, () => ({ ok: true, installed, authenticated: installed, login: 'octocat', flow: null }));
  const ctx = buildOnboardingContext(createDefaultOnboardingState(), { serverAvailable: true, configServerAvailable: true });
  let enabled = false;
  const actions = { next() {}, back() {}, skip() {}, patchContext() {}, setPrimaryEnabled(v: boolean) { enabled = v; }, setPrimaryLabel() {}, stepIndex: 1, totalSteps: 10 };
  let cleanup = githubStep.render(container, ctx, actions);
  await flush();
  assert.equal(enabled, true);
  assert.equal(ctx.state.steps.github?.done, true);
  assert.match(container.textContent || '', /Connected as @octocat/);
  if (cleanup) cleanup();
  installed = false;
  cleanup = githubStep.render(container, ctx, actions);
  await flush();
  assert.equal(enabled, false);
  assert.equal(githubStep.canSkip, true);
  assert.equal(container.querySelector('a')?.href, 'https://cli.github.com/');
  if (cleanup) cleanup();
});

test('device flow renders a code, verifies completion and clears polling on cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completed = false;
  const calls: string[] = [];
  const container = setup(t, op => {
    calls.push(op);
    if (op === 'githubAuthStatus') return { ok: true, installed: true, authenticated: completed, login: completed ? 'octocat' : '', flow: null };
    if (op === 'githubAuthStart') return { ok: true, flow: { state: 'pending', code: 'ABCD-1234' } };
    completed = true;
    return { ok: true, flow: { state: 'complete', code: '' } };
  });
  const cleanup = mountGitHubAccount(container);
  await flush();
  container.querySelector<HTMLButtonElement>('.github-account__primary')!.click();
  await flush();
  assert.equal(container.querySelector('code')?.textContent, 'ABCD-1234');
  assert.equal(container.querySelector('a')?.href, 'https://github.com/login/device');
  t.mock.timers.tick(1500);
  await flush();
  assert.match(container.textContent || '', /Connected as @octocat/);
  assert.equal(container.querySelector('code'), null);
  cleanup();
  const count = calls.length;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls.length, count);
});

test('late status results cannot enable a step after navigation', async t => {
  let resolve!: (value: unknown) => void;
  const container = setup(t, () => new Promise(r => { resolve = r; }));
  const values: boolean[] = [];
  const cleanup = mountGitHubAccount(container, value => values.push(value));
  cleanup();
  resolve({ ok: true, installed: true, authenticated: true, login: 'octocat', flow: null });
  await flush();
  assert.equal(values.includes(true), false);
});
