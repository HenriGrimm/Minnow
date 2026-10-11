import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import type { MinnowPreviewApi, MinnowPreviewGuestCrashedDetail, MinnowPreviewLoadFailedDetail } from '../../src/electron';
import { mountReefPreview } from '../../src/ui/reef-preview.ts';
import { resetPreviewInstanceHostsForTests } from '../../src/ui/preview-instance-host.ts';

const originalWindow = globalThis.window, originalDocument = globalThis.document, originalObserver = globalThis.ResizeObserver;
let dom: Window, host: HTMLElement;
let view: ReturnType<typeof mountReefPreview> | undefined;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const url = 'http://127.0.0.1:12345/a/capability/';

beforeEach(() => {
  dom = new Window({ settings: { enableFileSystemHttpRequests: false, disableIframePageLoading: true } });
  globalThis.window = dom as unknown as Window & typeof globalThis;
  globalThis.document = dom.document as unknown as Document;
  globalThis.ResizeObserver = dom.ResizeObserver as unknown as typeof ResizeObserver;
  host = document.createElement('div'); document.body.append(host);
  host.getBoundingClientRect = () => ({ left: 10, top: 20, width: 600, height: 420 }) as DOMRect;
});
afterEach(async () => {
  view?.dispose(); view = undefined; resetPreviewInstanceHostsForTests(); await dom.happyDOM.abort();
  globalThis.window = originalWindow; globalThis.document = originalDocument; globalThis.ResizeObserver = originalObserver;
});

function nativePreview() {
  const calls: string[] = [], tabs = new Set<string>();
  const failures = new Set<(detail: MinnowPreviewLoadFailedDetail, tab?: string, instance?: string) => void>();
  const crashes = new Set<(detail: MinnowPreviewGuestCrashedDetail, tab?: string, instance?: string) => void>();
  let rejectLoad = false;
  const api = {
    instances: {
      create: async (id: string) => { calls.push(`create:${id}`); return id; },
      destroy: async (id: string) => { calls.push(`destroy:${id}`); tabs.clear(); },
    },
    tabs: { create: async (tab: string, id: string) => { calls.push(`tab:${tab}:${id}`); tabs.add(`${id}/${tab}`); return tab; } },
    loadURL: async (target: string, tab: string, id: string) => {
      assert.ok(tabs.has(`${id}/${tab}`), 'loadURL must target a created guest tab');
      calls.push(`load:${target}:${tab}:${id}`);
      // The shell resolves loadURL even on a failure, reporting it through an event.
      if (rejectLoad) failures.forEach(callback => callback({ errorCode: -102, errorDescription: 'Connection refused' }, tab, id));
    },
    show: async (_bounds: unknown, _tab: string, id: string) => { calls.push(`show:${id}`); },
    hide: async (_tab: string, id: string) => { calls.push(`hide:${id}`); },
    onLoadFailed: (callback: typeof failures extends Set<infer T> ? T : never) => { failures.add(callback); return () => failures.delete(callback); },
    onGuestCrashed: (callback: typeof crashes extends Set<infer T> ? T : never) => { crashes.add(callback); return () => crashes.delete(callback); },
  };
  Object.assign(window, { minnow: { preview: api as unknown as MinnowPreviewApi } });
  return { calls, failures, crashes, rejectLoad: (value: boolean) => { rejectLoad = value; } };
}

test('opening a verified preview creates a guest tab and keeps its interaction state across view switches', async () => {
  const native = nativePreview(); let launches = 0;
  view = mountReefPreview(host, { instanceId: 'reef-test', name: () => 'Timer', launch: async () => { launches++; return { url }; } });
  view.setVisible(true); view.open('release-1');
  await view.start('release-1');
  assert.equal(launches, 1);
  assert.ok(native.calls.indexOf('tab:app:reef-test') < native.calls.indexOf(`load:${url}:app:reef-test`));
  assert.ok(native.calls.includes('show:reef-test'));
  assert.equal(host.getAttribute('aria-busy'), 'false');
  assert.equal(host.querySelector('img'), null);
  view.setVisible(false); assert.equal(native.calls.at(-1), 'hide:reef-test');
  view.setVisible(true); assert.equal(native.calls.at(-1), 'show:reef-test');
  view.open('release-1'); await view.start('release-1');
  assert.equal(launches, 1, 'switching back must preserve typed input and app state');
  await view.start('release-2'); assert.equal(launches, 2);
  view.dispose(); assert.equal(native.failures.size, 0); assert.equal(native.crashes.size, 0);
  assert.equal(native.calls.at(-1), 'destroy:reef-test');
});

test('launch failures show an actionable error and can be retried without automatic request loops', async () => {
  let launches = 0;
  view = mountReefPreview(host, { instanceId: 'reef-test', name: () => 'Timer', launch: async () => { launches++; throw new Error('Runtime could not start'); } });
  view.open('release-1'); await view.start('release-1');
  assert.match(host.textContent!, /Runtime could not start.*Run app/);
  assert.equal(host.getAttribute('aria-busy'), 'false');
  view.open('release-1'); await tick(); assert.equal(launches, 1);
  await view.start('release-1'); assert.equal(launches, 2);
});

test('native navigation failures and crashes stay visible and hide the failed guest', async () => {
  const native = nativePreview(); native.rejectLoad(true);
  view = mountReefPreview(host, { instanceId: 'reef-test', name: () => 'Timer', launch: async () => ({ url }) });
  view.setVisible(true); await view.start('release-1');
  assert.match(host.textContent!, /Connection refused.*Run app/);
  assert.ok(!native.calls.includes('show:reef-test'));
  native.rejectLoad(false); await view.start('release-1');
  assert.equal(host.textContent, '');
  native.crashes.forEach(callback => callback({ reason: 'crashed', exitCode: 1 }, 'app', 'another-preview'));
  assert.equal(host.textContent, '', 'unrelated instances must not change this preview');
  native.crashes.forEach(callback => callback({ reason: 'crashed', exitCode: 1 }, 'app', 'reef-test'));
  assert.match(host.textContent!, /preview stopped.*Run app/);
  assert.equal(native.calls.at(-1), 'hide:reef-test');
  await view.start('release-1'); assert.equal(host.textContent, '');
});

test('the browser preview mounts an interactive iframe and retains loading feedback until it loads', async () => {
  host.remove(); // Frame events are controlled below, rather than fetched by happy-dom.
  view = mountReefPreview(host, { instanceId: 'reef-browser', name: () => 'Bill splitter', launch: async () => ({ url }) });
  view.setVisible(true); const started = view.start('release-1'); await tick();
  const frame = host.querySelector('iframe')!;
  assert.ok(frame, host.textContent!);
  assert.equal(frame.title, 'Bill splitter'); assert.equal(frame.src, url);
  assert.ok(frame.sandbox.contains('allow-scripts')); assert.ok(frame.sandbox.contains('allow-forms'));
  assert.match(host.textContent!, /Starting app/);
  frame.dispatchEvent(new dom.Event('load')); await started;
  assert.equal(host.children.length, 1); assert.equal(frame.hidden, false);
  assert.equal(host.getAttribute('aria-busy'), 'false');
  const same = view.start('release-1'); await same; assert.equal(host.querySelector('iframe'), frame);
});

test('iframe failures can be retried and disposal cancels a pending frame load', async () => {
  host.remove();
  view = mountReefPreview(host, { instanceId: 'reef-browser', name: () => 'Timer', launch: async () => ({ url }) });
  let started = view.start('release-1'); await tick();
  assert.ok(host.querySelector('iframe'), host.textContent!);
  host.querySelector('iframe')!.dispatchEvent(new dom.Event('error')); await started;
  assert.match(host.textContent!, /could not load.*Run app/);
  started = view.start('release-1'); await tick(); view.dispose(); await started;
  assert.equal(host.querySelector('iframe'), null, 'a disposed page must not reveal a late frame');
});

test('leaving while a native instance is being created destroys the late instance without loading it', async () => {
  const native = nativePreview(); let finish: (() => void) | undefined;
  window.minnow!.preview.instances.create = async id => { await new Promise<void>(resolve => { finish = resolve; }); return id!; };
  view = mountReefPreview(host, { instanceId: 'reef-old-page', name: () => 'Timer', launch: async () => ({ url }) });
  view.setVisible(true); const started = view.start('release-1'); await tick();
  view.dispose(); finish!(); await started;
  assert.ok(!native.calls.some(call => call.startsWith('load:') || call.startsWith('show:')));
  assert.equal(native.calls.at(-1), 'destroy:reef-old-page');
});
