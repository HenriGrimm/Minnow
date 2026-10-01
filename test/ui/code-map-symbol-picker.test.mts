import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window();
globalThis.document = win.document as unknown as Document;
globalThis.window = win as unknown as Window & typeof globalThis.window;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Node = win.Node;
globalThis.Event = win.Event as typeof Event;
globalThis.localStorage = win.localStorage;
globalThis.ResizeObserver = win.ResizeObserver;
globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);

const { renderSymbolPicker } = await import('../../src/ui/code-map/symbol-picker.ts');
const { setLocalServerAvailableForTests } = await import('../../src/tools/config.ts');
setLocalServerAvailableForTests(true);
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; setLocalServerAvailableForTests(false); win.happyDOM.abort(); });

const symbol = { id: 'src/main.ts:run', name: 'run', kind: 'function', file: 'src/main.ts', line_start: 12 };
const context = { workspaceRoot: 'C:/repo/worktree' };
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function host() {
  document.body.innerHTML = '<div id="picker"></div>';
  return document.getElementById('picker')!;
}
function search(query: string) {
  const input = document.querySelector('input')!;
  input.value = query;
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return input;
}

test('selected file offers indexed symbols and opens the chosen id', async () => {
  let picked = '';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://localhost');
    assert.equal(parsed.pathname, '/api/brain/code/map/file');
    assert.equal(parsed.searchParams.get('workspaceRoot'), context.workspaceRoot);
    assert.equal(parsed.searchParams.get('path'), 'src/main.ts');
    return response({ symbols: [{ ...symbol, line: 12, depth: 0 }] });
  };
  await renderSymbolPicker(host(), { file: 'src/main.ts', context, isCurrent: () => true, onPick: (id) => { picked = id; } });
  assert.match(document.body.textContent!, /src\/main.ts:12/);
  document.querySelector('button')!.click();
  assert.equal(picked, symbol.id);
});

test('workspace search yields keyboard-accessible symbol choices', async () => {
  let picked = '';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://localhost');
    assert.equal(parsed.searchParams.get('query'), 'run');
    assert.equal(parsed.searchParams.get('workspaceRoot'), context.workspaceRoot);
    return response({ matches: [symbol] });
  };
  await renderSymbolPicker(host(), { file: null, context, isCurrent: () => true, onPick: (id) => { picked = id; } });
  const input = search('run');
  await tick();
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  const button = document.querySelector('button')!;
  assert.equal(document.activeElement, button);
  button.click();
  assert.equal(picked, symbol.id);
});

test('search reports empty results and unavailable service', async () => {
  await renderSymbolPicker(host(), { file: null, context, isCurrent: () => true, onPick: () => {} });
  globalThis.fetch = async () => response({ matches: [] });
  search('missing');
  await tick();
  assert.match(document.querySelector('[role=status]')!.textContent!, /No matching symbols/);
  globalThis.fetch = async () => ({ ok: false }) as Response;
  search('missing');
  await tick();
  assert.match(document.querySelector('[role=status]')!.textContent!, /unavailable/);
});

test('superseded search responses cannot replace the current choices', async () => {
  let resolveOld!: (value: Response) => void;
  globalThis.fetch = async (url) => String(url).includes('query=old')
    ? new Promise<Response>((resolve) => { resolveOld = resolve; })
    : response({ matches: [symbol] });
  await renderSymbolPicker(host(), { file: null, context, isCurrent: () => true, onPick: () => {} });
  search('old');
  search('run');
  await tick();
  resolveOld(response({ matches: [{ ...symbol, name: 'old' }] }));
  await tick();
  assert.match(document.querySelector('button')!.textContent!, /run/);
  assert.doesNotMatch(document.querySelector('button')!.textContent!, /old/);
});

test('navigating away while file symbols load leaves the new view untouched', async () => {
  let resolveFile!: (value: Response) => void;
  let current = true;
  globalThis.fetch = async () => new Promise<Response>((resolve) => { resolveFile = resolve; });
  const root = host();
  const pending = renderSymbolPicker(root, { file: 'src/main.ts', context, isCurrent: () => current, onPick: () => {} });
  current = false;
  root.textContent = 'Architecture';
  resolveFile(response({ symbols: [{ ...symbol, line: 12 }] }));
  await pending;
  assert.equal(root.textContent, 'Architecture');
});

test('Call graph tab opens a picker and its result loads incoming and outgoing calls', async () => {
  const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
  setWorkspaceFromServer(context.workspaceRoot);
  document.body.innerHTML = `
    <div id="codeMapTabs"><button data-view="architecture"></button><button data-view="files"></button><button data-view="calls"></button></div>
    <div id="codeMapViewport"><div id="codeMapScene"><svg id="codeMapEdges"></svg><div id="codeMapNodes"></div></div></div>
    <div id="codeMapEmpty"></div><div id="codeMapViewTools"></div>`;
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://localhost');
    requests.push(parsed.pathname);
    if (parsed.pathname.endsWith('/status')) return response({ enabled: true });
    if (parsed.pathname.endsWith('/architecture')) return response({ fileCount: 0 });
    if (parsed.pathname.endsWith('/find-symbol')) return response({ matches: [symbol] });
    if (parsed.pathname.endsWith('/read-symbol')) return response({ symbol });
    if (parsed.pathname.endsWith('/who-calls')) return response({ symbol, callers: [] });
    if (parsed.pathname.endsWith('/calls-of')) return response({ symbol, callees: [] });
    return response({});
  };
  const { renderCodeMapPage } = await import('../../src/ui/code-map/page.ts');
  await renderCodeMapPage();
  document.querySelector<HTMLButtonElement>('[data-view=calls]')!.click();
  assert.ok(document.querySelector('input[aria-label="Search symbols for the call graph"]'));
  search('run');
  await tick();
  document.querySelector<HTMLButtonElement>('.code-map-symbol-picker__result')!.click();
  await tick();
  for (const endpoint of ['read-symbol', 'who-calls', 'calls-of']) {
    assert.ok(requests.includes(`/api/brain/code/${endpoint}`), endpoint);
  }
  const choose = [...document.querySelectorAll<HTMLButtonElement>('#codeMapViewTools button')]
    .find((button) => button.textContent === 'Choose symbol')!;
  assert.ok(choose);
  globalThis.fetch = async () => response({ symbols: [{ ...symbol, line: 12 }] });
  choose.click();
  await tick();
  assert.match(document.querySelector('.code-map-symbol-picker__result')!.textContent!, /run/);
  // A selected file takes precedence over a previously opened symbol graph.
  globalThis.fetch = async (url) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    if (path.endsWith('/folder')) return response({ path: '', edges: [], nodes: [
      { id: 'src/other.ts', kind: 'file', path: 'src/other.ts', name: 'other.ts', symbols: 1, lines: 30, files: 1, outside: 0, callsIn: 0, callsOut: 0 },
    ] });
    if (path.endsWith('/file')) return response({ symbols: [{ id: 'other', name: 'other', kind: 'function', line: 3 }] });
    return response({});
  };
  document.querySelector<HTMLButtonElement>('[data-view=files]')!.click();
  await tick();
  document.querySelector<HTMLButtonElement>('.code-map-card')!.click();
  document.querySelector<HTMLButtonElement>('[data-view=calls]')!.click();
  await tick();
  assert.match(document.querySelector('.code-map-symbol-picker')!.textContent!, /src\/other.ts/);
  assert.match(document.querySelector('.code-map-symbol-picker__result')!.textContent!, /other/);
});
