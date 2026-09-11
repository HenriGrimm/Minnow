import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  createAgentBrowserMiddleware,
  registerAgentBrowserRuntime,
  resetAgentBrowserRuntimeForTests,
  setAgentBrowserServiceForTests,
} from '../../server/browser-agent-api.js';
import { AgentBrowserError } from '../../server/agent-browser/index.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createInProcessToolDispatch } from '../../server/runner/tool-dispatch.js';
import { initWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';
import { rmTestHome, setTestHome } from '../config/test-helpers.js';

function sameOwner(a, b) {
  return a?.chatId === b?.chatId && a?.runId === b?.runId && a?.agentId === b?.agentId;
}

class FakeAgentBrowserService extends EventEmitter {
  constructor(screenshotPath) {
    super();
    this.screenshotPath = screenshotPath;
    this.tabs = new Map();
    this.next = 0;
  }

  async reserveTab(owner) {
    const tabId = `tab-${++this.next}`;
    const lease = `lease-${tabId}-${owner.runId}`;
    const tab = {
      tabId, owner: { ...owner }, title: '', url: 'about:blank', status: 'ready',
      viewport: { width: 1440, height: 900 }, controlMode: 'guide', activity: 'idle',
      frameRevision: 1, documentRevision: 1, lease,
    };
    this.tabs.set(tabId, tab);
    return { tab: this.public(tab), lease };
  }

  public(tab) {
    const { lease: _lease, ...out } = tab;
    return structuredClone(out);
  }

  listTabs() { return [...this.tabs.values()].map((tab) => this.public(tab)); }
  listOwnedTabs(owner) { return this.listTabs().filter((tab) => sameOwner(tab.owner, owner)); }
  updateTabPolicy() {}
  owned(call) {
    const tab = this.tabs.get(call.tabId);
    if (!tab || !sameOwner(tab.owner, call.owner) || tab.lease !== call.lease) throw new Error('not owner');
    return tab;
  }
  inspectOwnedTab(call) { return this.public(this.owned(call)); }
  async screenshot(call) {
    this.owned(call);
    const stat = await fs.stat(this.screenshotPath);
    return { ok: true, id: 'shot-fixture', filePath: this.screenshotPath, sizeBytes: stat.size };
  }
  async releaseOwnedTab(call) {
    const tab = this.owned(call);
    tab.owner = null;
    tab.lease = null;
    return { tab: this.public(tab), lease: null };
  }
  async closeOwnedTab(call) { this.tabs.delete(this.owned(call).tabId); }
  async reassignTab(tabId, owner) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error('unknown tab');
    tab.owner = { ...owner };
    tab.lease = `lease-${tabId}-${owner.runId}`;
    tab.documentRevision += 1;
    return { tab: this.public(tab), lease: tab.lease };
  }
  async unassignTab(tabId) {
    const tab = this.tabs.get(tabId);
    tab.owner = null;
    tab.lease = null;
    return { tab: this.public(tab), lease: null };
  }
  async closeTab(tabId) { this.tabs.delete(tabId); }
  async clearTabs() { this.tabs.clear(); }
  async close() { this.tabs.clear(); }
  async guideElementAtPoint(tabId, input) {
    const tab = this.tabs.get(tabId);
    tab.selection = 'service-selection';
    return {
      selectionToken: tab.selection, owner: { ...tab.owner }, point: input,
      element: { tag: 'button', role: 'button', text: 'Submit form' },
      documentRevision: tab.documentRevision, frameRevision: tab.frameRevision,
    };
  }
  async selectGuideElement(tabId, input) {
    return this.guideElementAtPoint(tabId, input.point);
  }
  async deliverGuide(tabId, input) {
    const tab = this.tabs.get(tabId);
    if (input.selectionToken !== tab.selection) throw new Error('stale selection');
    return {
      owner: { ...tab.owner }, point: { x: 10, y: 20 }, message: input.message,
      element: { tag: 'button', role: 'button', text: 'Submit form' }, url: tab.url,
    };
  }
}

function listen(middleware) {
  const server = http.createServer((req, res) => void middleware(req, res, () => {
    res.statusCode = 404;
    res.end();
  }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
  }));
}

async function post(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('agent browser trusted runtime integration', { concurrency: false }, () => {
  let homeDir;
  let workspace;
  let screenshotPath;
  let fake;

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-agent-browser-integration');
    await ensureMinnowLayout();
    workspace = path.join(homeDir, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    screenshotPath = path.join(homeDir, 'fixture.png');
    await fs.writeFile(screenshotPath, Buffer.from('89504e470d0a1a0a', 'hex'));
    await initWorkspaceRoot();
    await setWorkspaceRoot(workspace);
  });

  beforeEach(() => {
    resetAgentBrowserRuntimeForTests();
    fake = new FakeAgentBrowserService(screenshotPath);
    setAgentBrowserServiceForTests(fake);
  });

  after(async () => {
    resetAgentBrowserRuntimeForTests();
    await rmTestHome(homeDir);
  });

  test('board and subagent dispatches cannot observe each other and screenshots carry image data', async () => {
    const boardOwner = { chatId: 'board-1', runId: 'task-1', agentId: 'attempt-board' };
    const subagentOwner = { chatId: 'chat-1', runId: 'sub-run-1', agentId: 'attempt-sub' };
    const board = createInProcessToolDispatch({ cwd: workspace, runtimeOwner: boardOwner });
    const subagent = createInProcessToolDispatch({ cwd: workspace, runtimeOwner: subagentOwner });

    const badSurface = await board.execute('browser_list', { surface: 'shared' });
    assert.equal(badSurface.content, 'Error: surface must be "agent" or "user"');
    const userSurface = await board.execute('browser_list', { surface: 'user' });
    assert.match(userSurface.content, /only available in the renderer/);

    const boardReserved = await board.execute('browser_reserve_tab', { surface: 'agent' });
    const subReserved = await subagent.execute('browser_reserve_tab', { surface: 'agent' });
    const boardTab = boardReserved.content.match(/tab-\d+/)?.[0];
    const subTab = subReserved.content.match(/tab-\d+/)?.[0];
    assert.ok(boardTab && subTab && boardTab !== subTab);

    const denied = await subagent.execute('browser_switch_tab', { surface: 'agent', tab_id: boardTab });
    assert.match(denied.content, /not leased to this runtime/);
    const boardList = await board.execute('browser_list', { surface: 'agent' });
    assert.match(boardList.content, new RegExp(boardTab));
    assert.doesNotMatch(boardList.content, new RegExp(subTab));

    const screenshot = await board.execute('browser_screenshot', { surface: 'agent', tab_id: boardTab });
    assert.equal(screenshot.attachments.length, 1);
    assert.equal(screenshot.attachments[0].mime, 'image/png');
    assert.match(screenshot.attachments[0].dataUrl, /^data:image\/png;base64,/);
  });

  test('a browser that cannot launch tells the agent not to fall back to the user surface', async () => {
    fake.reserveTab = async () => {
      throw new AgentBrowserError('no-chromium-browser: No Chrome, Edge, Brave, or Chromium executable was found.', 'launch-failed');
    };
    const dispatch = createInProcessToolDispatch({
      cwd: workspace,
      runtimeOwner: { chatId: 'board-2', runId: 'task-2', agentId: 'attempt-2' },
    });
    const reserved = await dispatch.execute('browser_reserve_tab', { surface: 'agent' });
    assert.match(reserved.content, /^Error: no-chromium-browser/);
    assert.match(reserved.content, /Do NOT retry with surface="user"/);
  });

  test('an idle foreground Guide is queued once and delivered to the next exact chat turn', async () => {
    const idleOwner = { chatId: 'chat-across-turns', runId: 'idle', agentId: 'main' };
    const { tab } = await fake.reserveTab(idleOwner);
    const { server, baseUrl } = await listen(createAgentBrowserMiddleware());
    try {
      const selected = await post(baseUrl, `/api/browser-agent/tabs/${tab.tabId}/guide/select`, {
        point: { x: 10, y: 20 }, frameRevision: 1, viewport: { width: 1440, height: 900 },
      });
      assert.equal(selected.status, 200);
      const delivered = await post(baseUrl, `/api/browser-agent/tabs/${tab.tabId}/guide`, {
        selectionToken: selected.body.selectionToken,
        owner: selected.body.owner,
        documentRevision: selected.body.documentRevision,
        message: 'Use the Submit form button after checking the values.',
      });
      assert.equal(delivered.body.outcome, 'queued');

      const nextOwner = { chatId: idleOwner.chatId, runId: 'turn-2', agentId: 'different-work-agent' };
      const runtime = await registerAgentBrowserRuntime(nextOwner, { kind: 'chat' });
      const messages = runtime.drainGuides();
      assert.equal(messages.length, 1);
      assert.match(messages[0].message, /checking the values/);
      assert.ok(sameOwner(fake.tabs.get(tab.tabId).owner, nextOwner));
      assert.deepEqual(runtime.drainGuides(), []);
      runtime.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
