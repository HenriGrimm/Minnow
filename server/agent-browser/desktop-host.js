// Loaded only by Electron main. The socket connects out to the local tool server;
// web content never receives a preload, IPC API, or debugging endpoint.
import WebSocket from 'ws';
import { isNavigationAllowed } from '../cdp/allowlist.js';

export function startDesktopBrowserHost({ electron, baseUrl, token, getViewer, onPick }) {
  const { app, BaseWindow, WebContentsView, dialog } = electron;
  const endpoint = new URL('/api/browser-agent/desktop-v1', baseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Local browser host required');
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const tabs = new Map();
  let socket, retry, stopping = false, mounted, shield;
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false };

  function unmount() {
    if (!mounted) return;
    const { win, tab } = mounted;
    if (!win.isDestroyed()) {
      if (shield && win.contentView.children.includes(shield)) win.contentView.removeChildView(shield);
      if (win.contentView.children.includes(tab.view)) win.contentView.removeChildView(tab.view);
    }
    mounted = null;
    if (tabs.has(tab.id) && !tab.view.webContents.isDestroyed()) {
      if (tab.captureWindow) tab.captureWindow.contentView.addChildView(tab.view);
      tab.view.setBounds({ x: 0, y: 0, ...tab.viewport });
      tab.view.webContents.setZoomFactor(1);
    }
  }
  function syncShield() {
    if (!mounted) return;
    const { tab, win, bounds } = mounted;
    if (shield && win.contentView.children.includes(shield)) win.contentView.removeChildView(shield);
    if (tab.mode === 'control') return;
    if (!shield) {
      shield = new WebContentsView({ webPreferences: { ...preferences, partition: 'agent-browser-shield' } });
      shield.setBackgroundColor('#00000000');
      // A local, transparent document receives all pointer and keyboard input.
      // Keep the page under inspection outside the trusted picker.
      void shield.webContents.loadURL('data:text/html,' + encodeURIComponent(
        '<html style="background:transparent"><title>Agent Browser page picker</title></html>'
      )).catch(() => {});
      shield.webContents.on('before-mouse-event', (event, mouse) => {
        event.preventDefault();
        if (mounted?.tab.mode !== 'guide') return;
        const { tab, bounds } = mounted;
        const point = { x: Math.floor(mouse.x * tab.viewport.width / bounds.width),
          y: Math.floor(mouse.y * tab.viewport.height / bounds.height) };
        if (mouse.type === 'mouseMove') highlight(tab, point);
        if (mouse.type === 'mouseDown' && mouse.button === 'left') {
          highlight(tab, point);
          onPick(tab.id, point);
        }
      });
      shield.webContents.on('before-input-event', (event, input) => {
        if (mounted?.tab.mode !== 'guide' || input.type !== 'keyDown') return;
        const { tab, win } = mounted;
        if (input.key === 'Escape' || input.key === 'Tab') { event.preventDefault(); win.webContents.focus(); return; }
        const point = tab.point ?? { x: Math.floor(tab.viewport.width / 2), y: Math.floor(tab.viewport.height / 2) };
        if (input.key === 'Enter') { event.preventDefault(); onPick(tab.id, point); return; }
        const delta = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[input.key];
        if (!delta) return;
        event.preventDefault();
        const step = input.shift ? 1 : 16;
        highlight(tab, { x: Math.max(0, Math.min(tab.viewport.width - 1, point.x + delta[0] * step)),
          y: Math.max(0, Math.min(tab.viewport.height - 1, point.y + delta[1] * step)) });
      });
    }
    win.contentView.addChildView(shield);
    shield.setBounds(bounds);
    if (tab.view.webContents.isFocused()) win.webContents.focus();
  }
  function highlight(tab, point) {
    tab.point = point;
    if (tab.highlighting) return;
    tab.highlighting = true;
    const debug = tab.view.webContents.debugger;
    void (async () => {
      while (mounted?.tab === tab && tab.mode === 'guide') {
        const current = tab.point;
        const hit = await debug.sendCommand('DOM.getNodeForLocation', current);
        if (mounted?.tab !== tab || tab.mode !== 'guide') return;
        await debug.sendCommand('Overlay.highlightNode', { backendNodeId: hit.backendNodeId,
          highlightConfig: { contentColor: { r: 70, g: 142, b: 224, a: 0.28 } } });
        if (tab.point === current) return;
      }
    })().catch(() => {}).finally(() => { tab.highlighting = false; });
  }
  function present(win, id, rect) {
    if (!win || win !== getViewer()) return;
    const tab = tabs.get(id);
    if (!tab || !rect) { unmount(); return; }
    const zoom = win.webContents.getZoomFactor();
    const bounds = Object.fromEntries(['x','y','width','height'].map(key => [key, Math.round(rect[key] * zoom)]));
    const size = win.getContentBounds();
    if (!Object.values(bounds).every(Number.isFinite) || bounds.x < 0 || bounds.y < 0 ||
        bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > size.width + 1 ||
        bounds.y + bounds.height > size.height + 1) { unmount(); return; }
    if (mounted?.tab !== tab || mounted.win !== win) {
      unmount();
      if (tab.captureWindow?.contentView.children.includes(tab.view)) tab.captureWindow.contentView.removeChildView(tab.view);
      win.contentView.addChildView(tab.view);
    }
    mounted = { tab, win, bounds };
    tab.view.setBounds(bounds);
    tab.view.webContents.setZoomFactor(bounds.width / tab.viewport.width);
    syncShield();
  }
  function dispose(tab) {
    if (!tabs.delete(tab.id)) return;
    if (mounted?.tab === tab) unmount();
    if (tab.popup && !tab.popup.isDestroyed()) tab.popup.destroy();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    tab.session.webRequest.onBeforeRequest(null);
    tab.session.removeListener('will-download', tab.denyDownload);
    tab.session.setPermissionRequestHandler(null);
    tab.session.setPermissionCheckHandler(null);
    return tab.session.clearStorageData().catch(() => {});
  }
  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  function create(id, viewport) {
    if (tabs.has(id) || tabs.size >= 8) throw new Error('Desktop guest capacity exceeded');
    const view = new WebContentsView({ webPreferences: { ...preferences, partition: 'agent-' + id, backgroundThrottling: false } });
    const wc = view.webContents;
    const restrictNavigation = contents => {
      contents.on('will-frame-navigate', event => {
        if (event.url !== 'about:blank' && !/^https?:\/\//i.test(event.url)) event.preventDefault();
      });
    };
    restrictNavigation(wc);
    const tab = { id, view, viewport, mode: 'watch', patterns: [], authOrigins: new Set(), gesture: 0 };
    tabs.set(id, tab);
    view.setBounds({ x: 0, y: 0, ...viewport });
    const session = wc.session;
    tab.session = session;
    session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    tab.denyDownload = event => event.preventDefault();
    session.on('will-download', tab.denyDownload);
    session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const isFrame = ['mainFrame','subFrame'].includes(details.resourceType);
      // Minnow serves a host credential in its shell HTML. Block the listener
      // across loopback aliases, redirects and subresources.
      if ((url.port && url.port === endpoint.port) || ['file:', 'devtools:', 'chrome:'].includes(url.protocol)) {
        callback({ cancel: true }); return;
      }
      if (!isFrame || details.url === 'about:blank') { callback({}); return; }
      if (!['https:', 'http:'].includes(url.protocol)) { callback({ cancel: true }); return; }
      // The service applies the current run's policy to the main guest via Fetch.
      if (details.webContentsId === wc.id && tab.mode !== 'control') { callback({}); return; }
      if (isNavigationAllowed(url.href, tab.patterns) || tab.authOrigins.has(url.origin)) { callback({}); return; }
      if (tab.mode !== 'control' || mounted?.tab !== tab || (tab.prompt && tab.prompt.origin !== url.origin)) {
        callback({ cancel: true }); return;
      }
      if (!tab.prompt) {
        const revision = tab.epoch;
        const answer = dialog.showMessageBox(mounted.win, {
          type: 'question', message: details.resourceType === 'subFrame' ? 'Allow this embedded sign-in page?' : 'Allow this sign-in destination?',
          detail: url.origin, buttons: ['Cancel', 'Allow for this handoff'], defaultId: 0, cancelId: 0,
        }).then(({ response }) => {
          const allow = response === 1 && tab.mode === 'control' && tab.epoch === revision && tabs.has(id) && mounted?.tab === tab;
          if (allow) tab.authOrigins.add(url.origin);
          return allow;
        }, () => false).finally(() => { tab.prompt = null; });
        tab.prompt = { origin: url.origin, answer };
      }
      void tab.prompt.answer.then(allow => callback({ cancel: !allow }));
    });
    wc.on('before-mouse-event', (_event, mouse) => { if (mouse.type === 'mouseDown') tab.gesture = Date.now(); });
    wc.on('before-input-event', (_event, input) => { if (input.type === 'keyDown') tab.gesture = Date.now(); });
    wc.setWindowOpenHandler(({ url }) => {
      if (tab.mode !== 'control' || tab.popup || mounted?.tab !== tab || Date.now() - tab.gesture > 1200 ||
          !(url === 'about:blank' || /^https?:\/\//i.test(url))) return { action: 'deny' };
      tab.gesture = 0;
      return { action: 'allow', overrideBrowserWindowOptions: { parent: mounted.win, autoHideMenuBar: true,
        webPreferences: { ...preferences, session } } };
    });
    wc.on('did-create-window', popup => {
      tab.popup = popup;
      restrictNavigation(popup.webContents);
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      popup.on('page-title-updated', event => event.preventDefault());
      popup.webContents.on('did-navigate', (_event, url) => popup.setTitle('Sign in — ' + new URL(url).origin));
      popup.once('closed', () => { tab.popup = null; });
    });
    wc.on('did-navigate', (_event, url) => {
      if (tab.mode === 'control' && URL.canParse(url)) send({ tabId: id, event: 'operator-origin', params: new URL(url).origin });
    });
    wc.debugger.attach();
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Fetch.requestPaused') {
        if (tab.mode === 'control') {
          // Native webRequest enforces operator navigation grants. Keep form
          // bodies, cookies and callback URLs out of the agent transport.
          void wc.debugger.sendCommand('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
        } else {
          send({ tabId: id, event: method, params: { requestId: params.requestId,
            resourceType: params.resourceType, request: { url: params.request.url } } });
        }
      } else if (method === 'DOM.documentUpdated' || method === 'Page.loadEventFired') {
        send({ tabId: id, event: method, params: {} });
      }
    });
    const lost = () => {
      if (!tabs.has(id)) return;
      dispose(tab);
      send({ tabId: id, event: 'closed' });
    };
    wc.debugger.on('detach', lost);
    wc.once('render-process-gone', lost);
    wc.once('destroyed', lost);
    return wc.loadURL('about:blank');
  }
  async function dispatch({ tabId, op, args }) {
    if (op === 'create') return create(tabId, args.viewport);
    const tab = tabs.get(tabId);
    if (!tab) throw new Error('Desktop guest has closed');
    if (op === 'close') return dispose(tab);
    if (op === 'confirm-transfer') {
      const viewer = getViewer();
      if (!viewer || viewer.isDestroyed() || mounted?.tab !== tab) return false;
      const url = tab.view.webContents.getURL();
      const { response } = await dialog.showMessageBox(viewer, {
        type: 'question', message: 'Transfer this browser session?',
        detail: `The selected owner (${args.owner}) will receive this tab and any signed-in account at ${URL.canParse(url) ? new URL(url).origin : 'this site'}.`,
        buttons: ['Cancel', 'Transfer session'], defaultId: 0, cancelId: 0,
      });
      return response === 1 && tabs.get(tabId) === tab && mounted?.tab === tab;
    }
    if (op === 'mode') {
      if (tab.popup || tab.prompt) return { blocked: 'Finish or cancel sign-in before returning control' };
      const url = tab.view.webContents.getURL();
      if (tab.mode === 'control' && url !== 'about:blank' && !url.startsWith('chrome-error:') &&
          !isNavigationAllowed(url, args.patterns)) {
        return { blocked: 'Return to an approved page before handing this tab back' };
      }
      tab.mode = args.mode;
      tab.epoch = (tab.epoch ?? 0) + 1;
      tab.patterns = args.patterns;
      tab.authOrigins.clear();
      if (tab.mode === 'guide') await tab.view.webContents.debugger.sendCommand('Overlay.enable');
      else await tab.view.webContents.debugger.sendCommand('Overlay.hideHighlight').catch(() => {});
      if (mounted?.tab === tab) {
        syncShield();
        if (tab.mode === 'control') tab.view.webContents.focus();
        if (tab.mode === 'guide') shield.webContents.focus();
      }
      return;
    }
    if (op === 'command') {
      if (args.method === 'Page.captureScreenshot') {
        // An unattached WebContentsView has no compositor. Give it a hidden
        // surface just for the capture, so idle tabs cannot keep the app open.
        const surface = new BaseWindow({ ...tab.viewport, useContentSize: true, show: false, skipTaskbar: true });
        tab.captureWindow = surface;
        if (mounted?.tab !== tab) surface.contentView.addChildView(tab.view);
        try {
          const contents = tab.view.webContents;
          const deadline = Date.now() + 2500;
          while (!contents.isDestroyed()) {
            try {
              const image = await contents.capturePage(undefined, { stayAwake: true });
              if (!image.isEmpty()) return { data: image.toPNG().toString('base64') };
            } catch (error) {
              if (error.message !== 'UnknownVizError') throw error;
            }
            if (Date.now() >= deadline) break;
            contents.invalidate();
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Browser viewport has not painted yet');
        } finally {
          tab.captureWindow = null;
          if (!surface.isDestroyed()) {
            if (surface.contentView.children.includes(tab.view)) surface.contentView.removeChildView(tab.view);
            surface.destroy();
          }
        }
      }
      return tab.view.webContents.debugger.sendCommand(args.method, args.params ?? {});
    }
    throw new Error('Unknown desktop browser operation');
  }
  function connect() {
    socket = new WebSocket(endpoint, { headers: { 'X-Minnow-Token': token() }, maxPayload: 32 * 1024 * 1024 });
    socket.once('open', markReady);
    socket.on('message', async raw => {
      let request;
      try {
        request = JSON.parse(raw);
        const result = await dispatch(request);
        send({ id: request.id, result });
      } catch (error) { send({ id: request?.id, error: error.message }); }
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      for (const tab of tabs.values()) dispose(tab);
      if (!stopping) retry = setTimeout(connect, 1500);
    });
  }
  connect();
  app.once('will-quit', () => {
    stopping = true;
    clearTimeout(retry);
    socket.terminate();
    for (const tab of tabs.values()) dispose(tab);
    if (shield && !shield.webContents.isDestroyed()) shield.webContents.close();
  });
  return { present, unmount, ready };
}
