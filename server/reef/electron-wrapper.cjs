const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let runtime;
const smoke = process.argv.includes('--reef-smoke-test');
app.whenReady().then(async () => {
  const { startApp } = await import(pathToFileURL(path.join(__dirname, 'runtime-host.mjs')).href);
  runtime = await startApp({ root: path.dirname(__dirname), dataDir: path.join(app.getPath('userData'), 'data') });
  const win = new BrowserWindow({ show: !smoke, width: 1000, height: 760, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(runtime.url)) event.preventDefault(); });
  await win.loadURL(runtime.url);
  if (smoke) {
    const valid = await win.webContents.executeJavaScript('document.readyState === "complete" && document.querySelector("#app")?.children.length > 0');
    runtime.server.close(); app.exit(valid ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => { runtime?.server.close(); app.quit(); });
