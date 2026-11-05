// Run with Electron against an isolated profile. Never submits a real login.
import electron from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { startDesktopBrowserHost } from '../../server/agent-browser/desktop-host.js';
import { attachNativeBrowserHost, launchAgentPage } from '../../server/agent-browser/native-transport.js';
import { getSessionToken } from '../../server/runtime/session-token.js';
import { createAgentBrowserService } from '../../server/agent-browser/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-browser-'));
process.env.MINNOW_HOME = root;
process.env.MINNOW_NATIVE_AGENT_BROWSER = '1';
electron.app.setPath('userData', root);
const service = createAgentBrowserService({ launcher: launchAgentPage });
const bridge = http.createServer();
const site = http.createServer((req, res) => {
  if (req.url === '/session') {
    res.writeHead(303, { 'Set-Cookie': 'fixture=signed-in; HttpOnly; SameSite=Lax', Location: '/' });
    return res.end();
  }
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  res.end('<title>Local sign-in fixture</title><form method="post" action="/session"><input autofocus aria-label="Email"><button>Sign in</button></form>' +
    '<button id="popup" onclick="window.open(\'/identity\')">Open login popup</button>' +
    (req.headers.cookie?.includes('fixture=signed-in') ? '<p>Authenticated fixture</p>' : ''));
});
const deadline = setTimeout(() => electron.app.exit(2), 60000);
let viewer;
async function run() {
  try {
    await electron.app.whenReady(); console.log("Electron ready");
    attachNativeBrowserHost(bridge);
    for (const server of [bridge, site]) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
    viewer = new electron.BrowserWindow({ show: false, width: 1100, height: 820 });
    await viewer.loadURL('about:blank');
    const approved = new Set();
    const host = startDesktopBrowserHost({ electron: { ...electron, dialog: {
      async showMessageBox(_win, options) {
        if (options.detail !== process.env.MINNOW_SMOKE_IDENTITY_ORIGIN) return { response: 0 };
        approved.add(options.detail);
        return { response: 1 };
      },
    } }, baseUrl: 'http://127.0.0.1:' + bridge.address().port,
      token: getSessionToken, getViewer: () => viewer, onPick() {} });
    await host.ready; console.log("Native bridge connected");
    const owner = { chatId: 'smoke', runId: 'turn', agentId: 'builder' };
    const { tab, lease } = await service.reserveTab(owner, { url: 'http://127.0.0.1:' + site.address().port });
    const call = { owner, lease, tabId: tab.tabId };
    assert.equal(tab.native, true);
    const screenshot = await service.screenshot({ ...call, timeoutMs: 5000 });
    assert.equal(screenshot.ok, true, screenshot.error);
    host.present(viewer, tab.tabId, { x: 0, y: 0, width: 960, height: 600 });
    assert.equal(viewer.contentView.children.length, 2, 'Watch shields the live guest');
    const guest = viewer.contentView.children[0].webContents;
    await service.setControlMode(tab.tabId, 'control');
    assert.equal(viewer.contentView.children.length, 1);
    await assert.rejects(async () => service.screenshot(call), /control mode/);
    await guest.executeJavaScript('document.querySelector("input").focus()');
    const typed = 'A@1!é'.repeat(40);
    for (const character of typed) await guest.insertText(character);
    assert.equal(await guest.executeJavaScript('document.activeElement.value'), typed);
    // Hidden windows cannot receive OS mouse input. Supply the main-process
    // gesture notification, then exercise Chromium's actual popup lifecycle.
    const opened = once(guest, 'did-create-window', { signal: AbortSignal.timeout(5000) });
    guest.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' });
    await guest.executeJavaScript('document.querySelector("#popup").click()', true);
    const [popup] = await opened;
    assert.equal(popup.webContents.session, guest.session);
    await assert.rejects(service.setControlMode(tab.tabId, 'watch'), /Finish or cancel/);
    popup.destroy();
    const loaded = once(guest, 'did-finish-load');
    await guest.executeJavaScript('document.querySelector("button").click()');
    await loaded;
    host.unmount();
    await assert.rejects(async () => service.snapshot(call), /control mode/);
    host.present(viewer, tab.tabId, { x: 0, y: 0, width: 960, height: 600 });
    await service.setControlMode(tab.tabId, 'watch');
    const snap = await service.snapshot(call);
    assert.match(JSON.stringify(snap), /Authenticated fixture/);
    await service.setControlMode(tab.tabId, 'guide');
    const p = await guest.executeJavaScript('(() => {const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+3,y:r.y+3}})()');
    const picked = await service.guideElementAtPoint(tab.tabId, p);
    assert.equal(picked.element.tagName, 'button');
    await service.deliverGuide(tab.tabId, { selectionToken: picked.selectionToken, message: 'Check sign-in' });
    assert.equal(service.takeGuideEvents(owner).length, 1);
    const signInUrl = process.env.MINNOW_SMOKE_SIGN_IN_URL;
    if (signInUrl) {
      const title = process.env.MINNOW_SMOKE_PAGE_TITLE;
      assert.ok(title && process.env.MINNOW_SMOKE_IDENTITY_ORIGIN);
      service.updateTabPolicy(tab.tabId, [new URL(signInUrl).origin]);
      await service.setControlMode(tab.tabId, 'watch');
      await assert.rejects(service.navigate({ ...call, url: signInUrl }), /approval/);
      await service.setControlMode(tab.tabId, 'control');
      await service.navigateOperator(tab.tabId, service.operatorRetryUrl(tab.tabId));
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await guest.executeJavaScript('Boolean(document.querySelector("input:not([type=hidden]),button"))') && guest.getTitle().includes(title)) break;
        await sleep(100);
      }
      assert.ok(guest.getTitle().includes(title));
      assert.ok(approved.size, 'Operator approved the expected identity origin');
      assert.ok(await guest.executeJavaScript('Boolean(document.querySelector("input:not([type=hidden]),button"))'));
      console.log('Hosted sign-in page loaded in the native guest.');
    }
    await service.close();
    assert.equal(viewer.contentView.children.length, 0);
    console.log('Native browser sign-in, same-session handback, Guide and cleanup passed.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await service.close();
    viewer?.destroy();
    bridge.close();
    site.close();
    clearTimeout(deadline);
    electron.app.exit(process.exitCode || 0);
  }
}
void run();
