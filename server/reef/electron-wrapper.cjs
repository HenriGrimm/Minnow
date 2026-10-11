const { app, BrowserWindow, Menu, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const identity = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'identity.json'), 'utf8')); } catch { return {}; } })();
const name = identity.name || app.getName();
const smoke = process.argv.includes('--reef-smoke-test');
let runtime, win;

app.setName(name);
// Keyed on the app id so a rename keeps its data and two same-named apps never share it.
if (identity.id) app.setPath('userData', path.join(app.getPath('appData'), 'Reef Apps', identity.id));
if (process.platform === 'win32' && identity.appId) app.setAppUserModelId(identity.appId);
if (!smoke && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
function savedBounds() {
  try {
    const bounds = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger) || bounds.width < 360 || bounds.height < 320) return {};
    // A window saved on a since-disconnected display reopens at the default position.
    const visible = screen.getAllDisplays().some(({ workArea: area }) => bounds.x < area.x + area.width - 80 && bounds.x + bounds.width > area.x + 80 && bounds.y >= area.y - 20 && bounds.y < area.y + area.height - 80);
    return visible ? bounds : { width: bounds.width, height: bounds.height, maximized: bounds.maximized };
  } catch { return {}; }
}
const external = url => /^(https?:|mailto:)/i.test(url);

app.whenReady().then(async () => {
  // Windows and Linux show Electron's developer menu by default; macOS keeps the standard app, edit and window menus.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  const { startApp } = await import(pathToFileURL(path.join(__dirname, 'runtime-host.mjs')).href);
  runtime = await startApp({ root: path.dirname(__dirname), dataDir: path.join(app.getPath('userData'), 'data') });
  const { x, y, width = 1000, height = 760, maximized } = savedBounds();
  win = new BrowserWindow({
    title: name, show: false, x, y, width, height, minWidth: 360, minHeight: 320,
    ...(process.platform === 'linux' && { icon: path.join(__dirname, 'icon.png') }),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  if (maximized) win.maximize();
  // The template ships a placeholder title; keep the app's name until the app sets its own.
  win.on('page-title-updated', (event, title) => { if (!title.trim() || title === 'Reef utility') event.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (external(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(runtime.url)) return;
    event.preventDefault();
    if (external(url)) void shell.openExternal(url);
  });
  win.on('close', () => {
    try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
  });
  win.once('ready-to-show', () => { if (!smoke) win.show(); });
  await win.loadURL(runtime.url);
  if (smoke) {
    const valid = await win.webContents.executeJavaScript('document.readyState === "complete" && document.querySelector("#app")?.children.length > 0');
    runtime.server.close(); app.exit(valid ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => { runtime?.server.close(); app.quit(); });
