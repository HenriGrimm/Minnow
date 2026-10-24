// Run from repository root:
// node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/workspace-terminal-attach-race.mts
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Window } from 'happy-dom';
class TerminalStub {
  options = {}; cols = 80; rows = 24;
  open() {} loadAddon() {} writeln() {} write() {} dispose() {}
  onData() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {} focus() {} reset() {}
}
mock.module('@xterm/xterm', { namedExports: { Terminal: TerminalStub } });
const dom = new Window({ url: 'http://localhost:9473' });
Object.assign(globalThis, { window: dom, document: dom.document,
  HTMLElement: dom.HTMLElement, Node: dom.Node, getComputedStyle: dom.getComputedStyle.bind(dom),
  ResizeObserver: class { observe() {} disconnect() {} } });
document.body.innerHTML = '<div id="terminalXtermHost"></div>';
const sockets: WebSocketStub[] = [];
class WebSocketStub {
  static OPEN = 1; readyState = 1;
  constructor(public url: string) { sockets.push(this); }
  close() { this.readyState = 3; } send() {}
}
Object.assign(globalThis, { WebSocket: WebSocketStub });
const pending: Array<{ resolve: (response: Response) => void }> = [];
globalThis.fetch = (async () => new Promise((resolve) => pending.push({ resolve }))) as typeof fetch;
const { setLocalServerAvailableForTests } = await import('../../../../src/tools/config.ts');
setLocalServerAvailableForTests(true);
const { initTerminalXterm, attachTerminalTab, disposeTerminalXterm } =
  await import('../../../../src/ui/terminal-xterm.ts');
initTerminalXterm(document.getElementById('terminalXtermHost')!);
const a = { tabId: 'A', shellProfileId: 'powershell', sessionId: null, title: 'A', boundCwd: 'C:/review/a' };
const b = { tabId: 'B', shellProfileId: 'powershell', sessionId: null, title: 'B', boundCwd: 'C:/review/b' };
const requestA = attachTerminalTab(a);
const requestB = attachTerminalTab(b);
assert.equal(pending.length, 2);
pending[1].resolve(Response.json({ sessionId: 'session-B', cwd: b.boundCwd }));
await requestB;
pending[0].resolve(Response.json({ sessionId: 'session-A', cwd: a.boundCwd }));
await requestA;
const connected = new URL(sockets.at(-1)!.url).searchParams.get('sessionId');
assert.equal(connected, 'session-A', 'Current bug: stale A steals the socket after B was requested');
console.log(JSON.stringify({ latestRequestedTab: 'B', lastConnectedSession: connected,
  connectionOrder: sockets.map((socket) => new URL(socket.url).searchParams.get('sessionId')) }));
disposeTerminalXterm();
dom.close();
process.exit(0);
