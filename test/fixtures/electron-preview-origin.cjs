const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, session, webContents } = require('electron');

const home = process.argv[2];
app.setPath('userData', home);
app.setPath('sessionData', home);

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://localhost:' + server.address().port;
}

async function run() {
  const { registerPreviewHostIpc } = await import('../../electron/dist/preview-host.js');
  const { setTrustedShellUrl, trustShellWebContents } = await import('../../electron/dist/trusted-ipc.js');
  const { configurePreviewSession, PREVIEW_SESSION_PARTITION } = await import('../../electron/dist/preview-session.js');
  let privilegedRequests = 0;
  const host = await serve((req, res) => {
    if (req.url === '/privileged') privilegedRequests++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Shell</title>');
  });
  let seenOrigin;
  const project = await serve((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: host + '/privileged' }).end();
    } else if (req.method === 'POST') {
      seenOrigin = req.headers.origin;
      res.writeHead(seenOrigin === project ? 204 : 403).end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer' });
      res.end('<!doctype html><title>Project</title>');
    }
  });
  const preload = path.join(home, 'shell-preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('preview', {
      create: () => ipcRenderer.invoke('minnow:preview:tab-create','test'),
      load: url => ipcRenderer.invoke('minnow:preview:load-url',url,'test')
    });`);
  const shell = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true } });
  configurePreviewSession(session.fromPartition(PREVIEW_SESSION_PARTITION), host);
  setTrustedShellUrl(host + '/');
  trustShellWebContents(shell.webContents.id);
  registerPreviewHostIpc();
  await shell.loadURL(host);
  await shell.webContents.executeJavaScript('preview.create()');
  await shell.webContents.executeJavaScript('preview.load(' + JSON.stringify(project) + ')');
  const guest = webContents.getAllWebContents().find(wc => wc.getURL() === project + '/');
  assert.ok(guest, 'real project guest loaded');
  const status = await guest.executeJavaScript("fetch('/turn', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:'{}'}).then(r=>r.status)");
  assert.equal(status, 204);
  assert.equal(seenOrigin, project);
  for (const dest of [host + '/privileged', project + '/redirect']) {
    assert.equal(await guest.executeJavaScript('fetch(' + JSON.stringify(dest) + ').then(()=>true,()=>false)'), false);
    await assert.rejects(guest.loadURL(dest));
  }
  assert.equal(privilegedRequests, 0, 'host receives neither navigation nor fetch');
}

app.whenReady().then(run).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
