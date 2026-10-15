import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createAgentCliSignIn } from '../../src/ui/agent-cli-sign-in.ts';
import type { AgentCliLogin } from '../../src/models/agent-clis.ts';

let win: Window;
let view: ReturnType<typeof createAgentCliSignIn>;
const flow = (patch: Partial<AgentCliLogin> = {}): AgentCliLogin => ({ id: 'attempt', state: 'waiting',
  verificationUrl: 'https://claude.ai/oauth/authorize?state=test', code: null, acceptsCode: true, error: null, ...patch });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  win = new Window({ url: 'http://localhost/#/app/models/clis' });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
});
afterEach(() => {
  view?.dispose();
  win.close();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

test('browser sign-in stays inline, supports fallback code and verifies completion', async () => {
  let complete!: (value: AgentCliLogin) => void;
  const calls: string[] = [];
  view = createAgentCliSignIn('claude', 'Claude Code', { retry() {}, request: async (_kind, action, options) => {
    calls.push(action);
    if (action === 'start') return flow();
    if (action === 'code') { assert.equal(options?.code, 'browser-code'); complete(flow({ state: 'signed-in', verificationUrl: null, acceptsCode: false })); return flow(); }
    return new Promise(resolve => { complete = resolve; });
  } });
  document.body.append(view.root);
  const result = view.start();
  await tick();
  assert.equal(view.root.hidden, false);
  assert.equal(document.activeElement, view.root.querySelector('h3'));
  assert.match(view.root.textContent!, /Continue in your browser/);
  assert.equal(view.root.querySelector('a')?.href, flow().verificationUrl);
  assert.equal(window.location.hash, '#/app/models/clis');
  const input = view.root.querySelector('input')!;
  input.value = 'browser-code';
  view.root.querySelector('form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
  assert.equal(await result, true);
  assert.equal(input.value, '');
  assert.equal(view.root.querySelector('a')!.hasAttribute('href'), false);
  assert.deepEqual(calls, ['start', 'poll', 'code']);
});

test('cancelling before start returns cancels the late process and allows retry', async () => {
  let started!: (value: AgentCliLogin) => void;
  const cancelled: string[] = [];
  view = createAgentCliSignIn('claude', 'Claude Code', { retry() {}, request: async (_kind, action, options) => {
    if (action === 'start') return new Promise(resolve => { started = resolve; });
    if (action === 'cancel') { cancelled.push(options!.id!); return flow({ state: 'cancelled' }); }
    return flow();
  } });
  document.body.append(view.root);
  const result = view.start();
  await tick();
  [...view.root.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click();
  assert.equal(await result, false);
  assert.equal(view.root.dataset.state, 'cancelled');
  started(flow());
  await tick();
  assert.deepEqual(cancelled, ['attempt']);
  assert.equal(view.root.dataset.state, 'cancelled');
});

test('leaving a surface cancels a late login without painting into a disposed view', async () => {
  let started!: (value: AgentCliLogin) => void;
  let cancels = 0;
  view = createAgentCliSignIn('cursor', 'Cursor Agent', { retry() {}, request: async (_kind, action) => {
    if (action === 'start') return new Promise(resolve => { started = resolve; });
    cancels++;
    return flow({ state: 'cancelled' });
  } });
  document.body.append(view.root);
  const result = view.start();
  await tick();
  view.dispose();
  started(flow());
  assert.equal(await result, false);
  await tick();
  assert.equal(cancels, 1);
  assert.equal(view.root.querySelector('a')!.hasAttribute('href'), false);
});

test('failed polling shows a retry and cancels the background attempt', async () => {
  let cancels = 0;
  let retries = 0;
  view = createAgentCliSignIn('codex', 'Codex CLI', { retry() { retries++; }, request: async (_kind, action) => {
    if (action === 'start') return flow({ acceptsCode: false });
    if (action === 'cancel') { cancels++; return flow({ state: 'cancelled' }); }
    throw new Error('private-diagnostic');
  } });
  document.body.append(view.root);
  assert.equal(await view.start(), false);
  assert.equal(cancels, 1);
  assert.equal(view.root.dataset.state, 'failed');
  assert.doesNotMatch(view.root.textContent!, /private-diagnostic/);
  [...view.root.querySelectorAll('button')].find(button => button.textContent === 'Try again')!.click();
  assert.equal(retries, 1);
});
