import electron from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startDesktopBrowserHost } from '../../server/agent-browser/desktop-host.js';
import { readSessionTokenFile } from '../../server/runtime/session-token.js';
import * as channels from '../../electron/dist/ipc-channels.js';

electron.app.setPath('userData', process.env.MINNOW_HOME);
async function waitFor(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await sleep(100); }
  throw new Error('Timed out waiting for ' + label);
}

async function run() {
  await electron.app.whenReady();
  const baseUrl = process.env.MINNOW_SMOKE_BASE;
  const win = new electron.BrowserWindow({ show: false, width: 1240, height: 860,
    webPreferences: { sandbox: false, contextIsolation: true, backgroundThrottling: false,
      preload: path.resolve('electron/dist/preload.mjs'), additionalArguments: ['--minnow-agent-browser-viewer'] } });
  const host = startDesktopBrowserHost({ electron, baseUrl, token: readSessionTokenFile, getViewer: () => win,
    onPick: (id, point) => win.webContents.send(channels.AGENT_BROWSER_PICK, id, point) });
  electron.ipcMain.on(channels.AGENT_BROWSER_PRESENT, (event, id, rect) => {
    if (event.sender === win.webContents) host.present(win, id, rect);
  });
  const deadline = setTimeout(() => {
    console.error('Timed out connecting or loading the viewer. Local credential present:', Boolean(readSessionTokenFile()));
    electron.app.exit(1);
  }, 12000);
  await host.ready;
  console.log('Desktop bridge connected');
  await win.loadURL(baseUrl + '/#/agent-browser');
  clearTimeout(deadline);
  const ui = expression => win.webContents.executeJavaScript(expression);
  await waitFor(() => ui('Boolean(document.querySelector(".agent-browser-viewer"))'), 'viewer chrome');
  win.webContents.send(channels.WINDOW_VISIBILITY_CHANGED, true);
  const mode = name => ui(`document.querySelector('[data-agent-browser-mode="${name}"]').click()`);
  console.log('VIEWER ready');
  try { await waitFor(() => win.contentView.children.length === 2, 'Watch guest and shield'); }
  catch (error) { console.error(await ui('document.body.innerText.slice(-800)')); throw error; }
  const guest = win.contentView.children[0].webContents;
  await mode('control');
  await waitFor(() => win.contentView.children.length === 1, 'exclusive control');
  await guest.executeJavaScript('document.querySelector("input").focus()');
  await guest.insertText('Upper+A@1');
  await mode('guide');
  await waitFor(() => win.contentView.children.length === 2, 'Guide picker');
  const rect = await guest.executeJavaScript('document.querySelector("button").getBoundingClientRect().toJSON()');
  const zoom = guest.getZoomFactor();
  win.contentView.children[1].webContents.emit('before-mouse-event', { preventDefault() {} }, {
    type: 'mouseDown', button: 'left', x: Math.round((rect.x + 5) * zoom), y: Math.round((rect.y + 5) * zoom),
  });
  await waitFor(() => ui('document.body.innerText.includes("Selected button")'), 'selected element');
  assert.equal(await guest.executeJavaScript('document.querySelector("input").value'), 'Upper+A@1');
  assert.notEqual(guest.getTitle(), 'clicked');
  await ui(`const note = document.querySelector('[data-agent-browser-guide-message]');
    note.value = 'Inspect the fixture button'; note.dispatchEvent(new Event('input'));
    document.querySelector('[data-agent-browser-send-guide]').click();`);
  await waitFor(() => ui('document.body.innerText.includes("Guide note queued")'), 'queued receipt');
  console.log('VIEWER sent');
  await waitFor(() => ui('document.body.innerText.includes("received by the owning turn")'), 'consumed receipt');
  console.log('VIEWER received');
  await ui('document.querySelector("[data-agent-browser-close-tab]").click()');
  await waitFor(() => !win.contentView.children.length, 'guest disposal');
  win.destroy();
}
run().then(() => electron.app.exit(0), error => { console.error(error); electron.app.exit(1); });
