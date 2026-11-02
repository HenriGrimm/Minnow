import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost/#/app/code/chat' });
Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
const noop = () => {};
mock.module('../../src/ui/app-dialog.ts', { namedExports: { appAlert: noop, appConfirm: async () => false } });
mock.module('../../src/chat/ask-question-display.ts', { namedExports: { notifyAskQuestionDisplayContextChanged: noop } });
mock.module('../../src/os/router.ts', { namedExports: { navigateToCodeChat: noop, navigateToCodeDevServers: noop } });
mock.module('../../src/state/sessions.ts', { namedExports: { sessionState: null } });
mock.module('../../src/tools/config.ts', { namedExports: { isLocalServerAvailable: () => true } });
mock.module('../../src/state/workspace.ts', { namedExports: { getWorkspacePath: () => '/project' } });
mock.module('../../src/state/worktree-service.ts', { namedExports: { listWorktrees: async () => ({ ok: false }) } });
mock.module('../../src/ui/main-column-overlay.ts', { namedExports: {
  notifyCodeStageViewChanged: noop, stripMainColumnOverlayClasses: noop, closeOtherCodeStageViews: async () => {},
} });
mock.module('../../src/ui/dev-server-form-popover.ts', { namedExports: { openDevServerFormPopover: noop } });
mock.module('../../src/ui/preview-electron-visibility.ts', { namedExports: { scheduleElectronPreviewHostVisibilitySync: noop } });
let logSyncs = 0;
mock.module('../../src/ui/dev-server-log-view.ts', { namedExports: {
  clearActiveLog: noop, initDevServerLogView: noop, setActiveLogServer: noop, setLogFilter: noop,
  setLogWrap: noop, syncDevServerLogs: async () => { logSyncs++; }, teardownDevServerLogView: noop,
} });

const hub = await import('../../src/ui/hub-dev-server.ts');
const screen = await import('../../src/ui/dev-server-screen.ts');
type Pending = { path: string; signal?: AbortSignal; resolve: (response: Response) => void };
let pending: Pending[] = [];
const intervals = new Map<number, () => void>();
let nextTimer = 0;
const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalWindowInterval = win.setInterval;
const originalWindowClearInterval = win.clearInterval;
const setIntervalStub = ((callback: () => void) => {
  const id = ++nextTimer;
  intervals.set(id, callback);
  return id;
}) as any;
const clearIntervalStub = ((id: number) => { intervals.delete(id); }) as any;
globalThis.setInterval = setIntervalStub;
globalThis.clearInterval = clearIntervalStub;
win.setInterval = setIntervalStub;
win.clearInterval = clearIntervalStub;
globalThis.fetch = ((path: string, init?: RequestInit) => new Promise<Response>(resolve => {
  // Deliberately allow late completion after abort to test stale response guards too.
  pending.push({ path: String(path), signal: init?.signal ?? undefined, resolve });
})) as typeof fetch;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const running = { id: 'web', name: 'Web', status: 'running', def: null, runId: null,
  pid: 1, healthOk: true, portInUse: true, port: 3000, network: 'local', command: 'npm start' };
const complete = (request: Pending, body: object) => request.resolve(new Response(JSON.stringify(body)));
function mountHub() {
  document.body.innerHTML = '<div id="hubDevServerCell"><span id="hubDevServerLabel"></span><span id="hubDevServerMeta"></span><span id="hubDevServerDot"></span></div>';
  hub.initHubDevServer(document.getElementById('hubDevServerCell')!, {} as any);
}
beforeEach(() => {
  hub.teardownHubDevServer();
  screen.closeDevServerScreen({ skipNavigate: true, restoreChat: false });
  intervals.clear(); pending = []; logSyncs = 0;
  document.body.innerHTML = '<main id="mainColumn"><div id="chatArea"></div></main>';
});
after(async () => {
  hub.teardownHubDevServer();
  screen.closeDevServerScreen({ skipNavigate: true, restoreChat: false });
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  win.setInterval = originalWindowInterval;
  win.clearInterval = originalWindowClearInterval;
  await win.happyDOM.abort();
});

test('hub updates share the pending refresh and teardown prevents late polling', async () => {
  mountHub();
  for (let i = 0; i < 20; i++) hub.updateHubDevServer();
  assert.equal(pending.length, 1);
  hub.teardownHubDevServer();
  assert.equal(pending[0].signal?.aborted, true);
  complete(pending[0], { servers: [running] });
  await settle();
  assert.equal(intervals.size, 0);
  hub.updateHubDevServer();
  assert.equal(pending.length, 1);
});

test('an old hub response cannot overwrite or unlock a newly mounted hub refresh', async () => {
  mountHub();
  const old = pending[0];
  mountHub();
  complete(old, { servers: [running] });
  await settle();
  hub.updateHubDevServer();
  assert.equal(pending.length, 2);
  complete(pending[1], { servers: [] });
  await settle();
  assert.equal(intervals.size, 0);
});

test('closing Dev Servers during a slow status request releases it and cannot restart polling', async () => {
  const opened = screen.openDevServerScreen();
  await settle();
  assert.equal(pending.length, 1);
  await screen.openDevServerScreen();
  for (const tick of intervals.values()) tick();
  assert.equal(pending.length, 1, 'poll and manual refresh cannot overlap');
  screen.closeDevServerScreen({ skipNavigate: true, restoreChat: false });
  assert.equal(pending[0].signal?.aborted, true);
  complete(pending[0], { servers: [running] });
  await opened;
  assert.equal(pending.length, 1, 'closed screen must not start a ports request');
  assert.equal(intervals.size, 0);
  assert.equal(logSyncs, 0);
});

test('closing Dev Servers during a ports request also discards late results', async () => {
  const opened = screen.openDevServerScreen();
  await settle();
  complete(pending[0], { servers: [running] });
  await settle();
  assert.equal(pending[1].path, '/api/workspace/ports');
  screen.closeDevServerScreen({ skipNavigate: true, restoreChat: false });
  assert.equal(pending[1].signal?.aborted, true);
  complete(pending[1], { ports: [] });
  await opened;
  assert.equal(logSyncs, 0);
  assert.equal(intervals.size, 0);
});
