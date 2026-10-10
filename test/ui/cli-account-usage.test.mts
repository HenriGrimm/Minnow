import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { accountUsageSummary, createAccountUsageView, type AccountUsageView } from '../../src/ui/cli-account-usage.ts';
import { createAccountUsageTrigger } from '../../src/ui/cli-account-usage-trigger.ts';
import type { AgentCliAccountUsage } from '../../src/models/agent-clis.ts';

let win: Window;
const views: AccountUsageView[] = [];
const triggers: ReturnType<typeof createAccountUsageTrigger>[] = [];
const originalFetch = globalThis.fetch;
const snapshot: AgentCliAccountUsage = { kind: 'codex', status: 'ready', plan: 'pro',
  windows: [{ id: 'week', label: 'Weekly', usedPercent: 29, windowMinutes: 10080, resetsAt: '2027-01-01T00:00:00Z' }],
  checkedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), retryAt: null, message: null };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  // happy-dom does not yet implement the browser's native Popover API.
  Object.defineProperty(win.HTMLElement.prototype, 'hidePopover', { configurable: true, value() {} });
  Object.defineProperty(win.HTMLElement.prototype, 'showPopover', { configurable: true, value() {} });
});
afterEach(() => {
  for (const trigger of triggers.splice(0)) trigger.dispose();
  for (const view of views.splice(0)) view.stop();
  globalThis.fetch = originalFetch;
  win.close();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

test('displays dynamic remaining allowance, accessible meters, reset times and last-known state', async () => {
  const view = createAccountUsageView('codex', { request: async () => ({ ...snapshot, status: 'stale', message: 'Temporarily limited' }) });
  views.push(view);
  document.body.append(view.root);
  view.start();
  await tick();
  assert.match(view.root.textContent ?? '', /71% left/);
  assert.match(view.root.textContent ?? '', /Showing last-known usage/);
  assert.match(view.root.textContent ?? '', /Resets/);
  assert.match(view.root.textContent ?? '', /Updated/);
  assert.equal(view.root.querySelector('progress')?.value, 71);
  assert.equal(view.root.querySelector('progress')?.getAttribute('aria-label'), 'Weekly allowance remaining');
  assert.equal(accountUsageSummary({ ...snapshot, windows: [] }), 'Usage unavailable');
  assert.equal(accountUsageSummary({ ...snapshot, windows: [{ ...snapshot.windows[0], usedPercent: 105 }] }), '0% left');
});

test('manual refresh forwards its intent and backoff disables refresh without inventing zero usage', async () => {
  const requests: boolean[] = [];
  const view = createAccountUsageView('claude', { request: async (_kind, options) => {
    requests.push(options?.refresh === true);
    return requests.length === 1 ? snapshot : { ...snapshot, status: 'error', windows: [], fetchedAt: null,
      message: 'Try later', retryAt: new Date(Date.now() + 120000).toISOString() };
  } });
  views.push(view);
  document.body.append(view.root);
  view.start();
  await tick();
  view.root.querySelector<HTMLButtonElement>('button')!.click();
  await tick();
  assert.deepEqual(requests, [false, true]);
  assert.equal(view.root.querySelector('progress'), null);
  assert.equal(view.root.querySelector<HTMLButtonElement>('button')!.disabled, true);
  assert.match(view.root.textContent ?? '', /Retry after/);
});

test('hidden views skip requests and teardown aborts in-flight work so late replies cannot paint', async () => {
  let visible = false;
  let signal: AbortSignal | undefined;
  let resolve!: (value: AgentCliAccountUsage) => void;
  let changes = 0;
  const view = createAccountUsageView('codex', { visible: () => visible, onChange: () => { changes++; }, request: async (_kind, options) => {
    signal = options?.signal;
    return new Promise(done => { resolve = done; });
  } });
  views.push(view);
  document.body.append(view.root);
  view.start();
  assert.equal(signal, undefined);
  visible = true;
  const pending = view.refresh();
  assert.ok(signal);
  view.stop();
  assert.equal(signal.aborted, true);
  resolve(snapshot);
  await pending;
  assert.equal(changes, 0);
  assert.equal(view.root.querySelector('progress'), null);
});

test('composer quota switches providers without retaining the previous account result', async () => {
  globalThis.fetch = (async input => new Response(JSON.stringify({ usage: { ...snapshot,
    kind: String(input).includes('/claude/') ? 'claude' : 'codex' } }))) as typeof fetch;
  const trigger = createAccountUsageTrigger();
  triggers.push(trigger);
  document.body.append(trigger.button);
  // happy-dom has no layout; provide the visible button measurements.
  trigger.button.getClientRects = () => [{ width: 70, height: 32 }] as unknown as DOMRectList;
  const wrap = document.createElement('div');
  wrap.className = 'composer-model-trigger-wrap';
  wrap.getClientRects = trigger.button.getClientRects;
  document.body.append(wrap);
  wrap.append(trigger.button);
  trigger.setProvider('codex-cli');
  await tick();
  assert.equal(trigger.button.textContent, '71% left');
  trigger.setProvider('claude-code-cli');
  assert.equal(trigger.button.textContent, 'Usage');
  await tick();
  assert.equal(trigger.button.getAttribute('aria-label'), 'Claude account usage');
  trigger.setProvider('cursor-agent-cli');
  assert.equal(trigger.button.hidden, false);
  await tick();
  assert.equal(trigger.button.getAttribute('aria-label'), 'Cursor account usage');
  trigger.setProvider('local-provider');
  assert.equal(trigger.button.hidden, true);
  assert.equal(document.querySelector('.cli-account-usage__window'), null);
});
