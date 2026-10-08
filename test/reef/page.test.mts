import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { openReef, suspendReef } from '../../src/ui/reef-page.ts';
import { parseOsHash } from '../../src/os/router.ts';
import { DEFAULT_MODEL_STORAGE_KEY } from '../../src/ui/default-model.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import type { ReefApp } from '../../src/reef/types.ts';

test('Reef separates store and creation, preserves drafts, and presents build recovery and verified previews', async () => {
  const dom = new Window();
  globalThis.window = dom as unknown as Window & typeof globalThis;
  globalThis.document = dom.document as unknown as Document;
  globalThis.HTMLElement = dom.HTMLElement as unknown as typeof HTMLElement;
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = dom.localStorage;
  const previousEvent = globalThis.Event;
  globalThis.Event = dom.Event as unknown as typeof Event;
  const catalog = document.createElement('select'); catalog.id = 'modelSelect';
  for (const provider of ['local', 'cloud', 'codex-cli']) {
    const option = document.createElement('option'); option.value = encodeModelSelectKey(provider, 'local-model'); option.textContent = `${provider} model`; catalog.append(option);
  }
  catalog.value = encodeModelSelectKey('local', 'local-model'); document.body.append(catalog);
  const previousFetch = globalThis.fetch;
  const code = createEmptyChatObject('11111111-1111-1111-1111-111111111111');
  code.modelId = 'local-model'; code.providerId = 'local'; code.composerDraft = 'Code draft';
  setSessionStateForTests({ version: 3, activeId: code.id, chats: [code], sidebarCollapsed: false });
  const app: ReefApp = {
    version: 1, templateVersion: 1, id: '22222222-2222-2222-2222-222222222222',
    name: 'Bill splitter', description: 'Split a dinner bill', providerId: 'local', modelId: 'local-model',
    createdAt: 1, updatedAt: 2, status: 'failed', release: null, exports: [], chatIds: [], messages: [],
    runs: [{ id: 'run-1', prompt: 'Split a bill', state: 'failed', progress: 70, createdAt: 1,
      failedStage: 'checking', error: 'Expected a total of 24', log: 'Test failed: tip total', attempt: 0, chatIds: [] }],
  };
  const requests: string[] = [];
  const creations: unknown[] = [];
  const modelChanges: unknown[] = [];
  let rejectModel = false;
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); requests.push(url);
    if (url.endsWith(`/api/reef/apps/${app.id}/model`) && options?.method === 'PUT') {
      const selected = JSON.parse(String(options.body)); modelChanges.push(selected);
      if (rejectModel) return Response.json({ error: 'The model provider is unreachable' }, { status: 400 });
      Object.assign(app, selected); return Response.json(app);
    }
    if (url.endsWith('/api/reef/apps') && options?.method === 'POST') {
      creations.push(JSON.parse(String(options.body))); return Response.json(app);
    }
    if (url.endsWith('/api/reef/apps')) return Response.json([app]);
    if (url.endsWith(`/api/reef/apps/${app.id}`)) return Response.json({ ...app, workspacePath: '/apps/bill' });
    if (url.includes('/api/providers')) return Response.json({ providers: [], activeId: null });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const findButton = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('#reefView button')).find(button => button.textContent === name)!;
  try {
    await openReef();
    assert.ok(document.querySelector('.reef-store-screen'));
    assert.equal(document.querySelector('.reef-create'), null);
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'missing app'; search.dispatchEvent(new dom.Event('input'));
    assert.match(document.querySelector('.reef-library')!.textContent!, /No apps found/);
    findButton('Clear search').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(document.querySelector('.reef-library')!.textContent!, /Bill splitter/);
    findButton('New app').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(window.location.hash, '#/app/reef/new');
    assert.equal(parseOsHash(window.location.hash).reefAppId, 'new');
    await openReef('new');
    assert.ok(document.querySelector('.reef-create'));
    assert.equal(document.querySelector('.reef-library'), null);
    assert.ok(!requests.some(url => url.endsWith('/apps/new')));
    const prompt = document.querySelector<HTMLTextAreaElement>('.reef-prompt')!;
    prompt.value = 'My unfinished idea'; prompt.dispatchEvent(new dom.Event('input'));
    await openReef(); await openReef('new');
    assert.equal(document.querySelector<HTMLTextAreaElement>('.reef-prompt')!.value, 'My unfinished idea');
    findButton('Focus timer').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(document.querySelector<HTMLTextAreaElement>('.reef-prompt')!.value, /focus timer/);
    await openReef(app.id);
    assert.equal(document.querySelector<HTMLElement>('.reef-preview')!.hidden, true);
    assert.equal(document.querySelector<HTMLElement>('.reef-build')!.hidden, false);
    assert.equal(findButton('Preview').disabled, true);
    assert.equal(findButton('Export').disabled, true);
    assert.equal(findButton('Run app').disabled, true);
    assert.equal(document.querySelector('[aria-current="step"] .reef-step-label')!.textContent, 'Check');
    assert.match(document.querySelector('.reef-build-error')!.textContent!, /Expected a total of 24/);
    assert.equal(findButton('Retry build').hidden, false);
    assert.match(document.querySelector('.reef-build-log')!.textContent!, /Test failed/);
    app.status = 'building'; app.runs[0].state = 'building'; delete app.runs[0].failedStage; delete app.runs[0].error;
    await openReef(app.id);
    assert.equal(findButton('Retry build').hidden, true);
    assert.equal(findButton('Cancel build').hidden, false);
    assert.equal(document.querySelector<HTMLTextAreaElement>('.reef-chat textarea')!.disabled, true);
    assert.equal(document.querySelector('[aria-current="step"] .reef-step-label')!.textContent, 'Build');
    const modelTrigger = document.querySelector<HTMLButtonElement>('.reef-workspace-model button')!;
    assert.equal(modelTrigger.disabled, false);
    modelTrigger.click();
    assert.equal(modelTrigger.getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelector<HTMLSelectElement>('.reef-workspace-model select')!.options.length, 2);
    assert.equal(document.querySelector('.reef-workspace-model [aria-selected="true"]')!.getAttribute('data-value'), encodeModelSelectKey('local', 'local-model'));
    document.querySelector(`[data-value="${encodeModelSelectKey('cloud', 'local-model')}"]`)!.dispatchEvent(new dom.MouseEvent('mousedown', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(modelChanges, [{ providerId: 'cloud', modelId: 'local-model' }]);
    assert.equal(modelTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector<HTMLSelectElement>('.reef-workspace-model select')!.value, encodeModelSelectKey('cloud', 'local-model'));
    assert.equal(catalog.value, encodeModelSelectKey('local', 'local-model'));
    assert.equal(code.providerId, 'local'); assert.equal(code.modelId, 'local-model');
    assert.equal(app.runs[0].state, 'building');
    rejectModel = true;
    modelTrigger.click();
    document.querySelector(`[data-value="${encodeModelSelectKey('local', 'local-model')}"]`)!.dispatchEvent(new dom.MouseEvent('mousedown', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(document.querySelector('.reef-error')!.textContent!, /provider is unreachable/);
    assert.equal(modelTrigger.disabled, false);
    assert.equal(document.querySelector<HTMLSelectElement>('.reef-workspace-model select')!.value, encodeModelSelectKey('cloud', 'local-model'));
    modelTrigger.click();
    document.querySelector('.reef-workspace-model')!.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(modelTrigger.getAttribute('aria-expanded'), 'false');
    app.status = 'ready'; app.runs[0].state = 'ready'; app.release = { id: 'release-1', commit: 'abc', createdAt: 3 };
    await openReef(app.id);
    assert.equal(document.querySelector<HTMLElement>('.reef-build')!.hidden, true);
    assert.equal(document.querySelector<HTMLElement>('.reef-preview')!.hidden, false);
    assert.equal(findButton('Export').disabled, false);
    assert.equal(findButton('Run app').disabled, false);
    findButton('Build').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector<HTMLElement>('.reef-build')!.hidden, false);
    assert.equal(document.querySelectorAll('.reef-step[data-state="done"]').length, 6);
    findButton('How does this app work?').click();
    assert.equal(document.querySelector<HTMLTextAreaElement>('.reef-chat textarea')!.value, 'How does this app work?');
    app.status = 'failed'; app.runs[0].state = 'failed'; app.runs[0].failedStage = 'building'; app.runs[0].error = 'Revision failed';
    await openReef(app.id);
    assert.equal(document.querySelector<HTMLElement>('.reef-build')!.hidden, false);
    assert.equal(findButton('Run app').disabled, false);
    assert.equal(findButton('Preview').disabled, false);
    findButton('Preview').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector<HTMLElement>('.reef-preview')!.hidden, false);
    dom.localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, encodeModelSelectKey('previous-default', 'previous-model'));
    await openReef('new');
    assert.equal(document.querySelector('#reefView select'), null);
    dom.localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, encodeModelSelectKey('top-bar-provider', 'latest-default'));
    document.querySelector<HTMLTextAreaElement>('.reef-prompt')!.value = 'Use the top bar default';
    document.querySelector('form')!.dispatchEvent(new dom.Event('submit', { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(creations, [{ prompt: 'Use the top bar default', providerId: 'top-bar-provider', modelId: 'latest-default' }]);
    assert.equal(code.composerDraft, 'Code draft');
  } finally {
    suspendReef(); globalThis.fetch = previousFetch; globalThis.localStorage = previousStorage; globalThis.Event = previousEvent; setSessionStateForTests(null); await dom.happyDOM.abort();
  }
});

test('Reef retries failed and stopped builds from the store and detail, and recovers from request errors', async () => {
  const dom = new Window();
  globalThis.window = dom as unknown as Window & typeof globalThis;
  globalThis.document = dom.document as unknown as Document;
  globalThis.HTMLElement = dom.HTMLElement as unknown as typeof HTMLElement;
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = dom.localStorage;
  const app: ReefApp = {
    version: 1, templateVersion: 1, id: '33333333-3333-3333-3333-333333333333',
    name: 'Timer', description: 'A timer', modelId: 'local-model', createdAt: 1, updatedAt: 2,
    status: 'failed', release: { id: 'release-1', commit: 'abc', createdAt: 1 },
    exports: [], chatIds: [], messages: [],
    runs: [{ id: 'run-1', prompt: 'Add a pause button', state: 'failed', progress: 70,
      createdAt: 1, log: 'Tests failed', error: 'Broken pause button', failedStage: 'checking', attempt: 2, chatIds: [] }],
  };
  const requests: unknown[] = [];
  let fail = false;
  let finish: (() => void) | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/apps/${app.id}/runs`) && options?.method === 'POST') {
      requests.push(JSON.parse(String(options.body)));
      await new Promise<void>(resolve => { finish = resolve; });
      if (fail) return Response.json({ error: 'Model provider is unavailable' }, { status: 503 });
      const body = JSON.parse(String(options.body));
      const previous = app.runs.at(-1)!;
      const run = { ...previous, id: body.action === 'reset-build' ? `run-${requests.length + 1}` : previous.id, state: 'queued' as const };
      delete run.error;
      if (run.id === previous.id) app.runs[app.runs.length - 1] = run; else app.runs.push(run);
      app.status = 'queued';
      return Response.json(run);
    }
    if (url.endsWith('/api/reef/apps')) return Response.json([app]);
    if (url.endsWith(`/apps/${app.id}`)) return Response.json({ ...app, workspacePath: '/apps/timer' });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const findButton = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('#reefView button')).find(button => button.textContent === name)!;
  try {
    for (const state of ['failed', 'cancelled', 'interrupted'] as const) {
      app.status = state; app.runs.at(-1)!.state = state;
      await openReef();
      const label = state === 'failed' ? 'Retry build' : 'Resume build';
      const retry = findButton(label);
      assert.equal(retry.getAttribute('aria-label'), `${label} for Timer`);
      retry.click(); await tick();
      assert.equal(findButton(label).disabled, true);
      findButton(label).click(); await tick();
      const count = requests.length;
      finish!(); await tick(); await tick();
      assert.equal(requests.length, count);
      assert.equal(window.location.hash, `#/app/reef/${app.id}`);
      assert.equal(app.runs.at(-1)!.prompt, 'Add a pause button');
      assert.equal(app.release!.id, 'release-1');
      app.status = state; app.runs.at(-1)!.state = state;
      await openReef(app.id);
      assert.equal(document.querySelector('[aria-current="step"] .reef-step-label')!.textContent, 'Check');
      assert.equal(findButton(label).hidden, false);
      assert.equal(findButton('Run app').disabled, false);
      findButton(label).click(); await tick();
      assert.equal(findButton('Starting build…').disabled, true);
      assert.equal(document.querySelector<HTMLTextAreaElement>('.reef-chat textarea')!.disabled, true);
      finish!(); await tick();
      assert.equal(document.querySelector<HTMLElement>('.reef-recovery')!.hidden, true);
      assert.equal(findButton('Cancel build').hidden, false);
    }
    assert.ok(requests.every(body => (body as { action: string; runId: string }).action === 'resume' && (body as { runId: string }).runId === 'run-1'));
    for (const [label, action] of [['Reset current phase', 'reset-phase'], ['Reset whole build', 'reset-build']]) {
      app.status = 'failed'; app.runs.at(-1)!.state = 'failed';
      await openReef(app.id);
      const options = document.querySelector<HTMLDetailsElement>('.reef-reset')!;
      assert.equal(options.hidden, false); options.open = true;
      const priorRun = app.runs.at(-1)!.id;
      findButton(label).click(); await tick();
      assert.equal(options.open, false);
      assert.equal(findButton('Reset current phase').disabled, true);
      assert.equal(findButton('Reset whole build').disabled, true);
      assert.deepEqual(requests.at(-1), { action, runId: priorRun });
      finish!(); await tick();
      assert.equal(document.querySelector<HTMLElement>('.reef-recovery')!.hidden, true);
    }
    app.status = 'failed'; app.runs.at(-1)!.state = 'failed'; fail = true;
    await openReef(app.id);
    findButton('Retry build').click(); await tick(); finish!(); await tick();
    assert.match(document.querySelector('.reef-error')!.textContent!, /Model provider is unavailable/);
    assert.equal(findButton('Retry build').disabled, false);
    assert.equal(document.querySelector<HTMLTextAreaElement>('.reef-chat textarea')!.disabled, false);
    app.status = 'ready'; app.runs.at(-1)!.state = 'ready';
    await openReef(); assert.equal(findButton('Retry build'), undefined); assert.equal(findButton('Resume build'), undefined);
  } finally {
    suspendReef(); globalThis.fetch = previousFetch; globalThis.localStorage = previousStorage; await dom.happyDOM.abort();
  }
});
