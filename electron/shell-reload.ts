import type { BrowserWindow } from 'electron';

/** Keep the renderer alive until its ordinary, acknowledged session save finishes. */
export function wireShellReload(win: BrowserWindow, offerHungRendererRestart = () => false): void {
  const contents = win.webContents;
  let preparing: symbol | undefined;
  contents.on('render-process-gone', () => { preparing = undefined; });
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) preparing = undefined;
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    const key = input.key.toLowerCase();
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    if (key !== 'f5' && !(modifier && key === 'r')) return;
    event.preventDefault();
    if (offerHungRendererRestart()) return;
    if (preparing) return;
    const attempt = preparing = Symbol();
    void contents.executeJavaScript(
      'typeof globalThis.__minnowPrepareForReload === "function" && globalThis.__minnowPrepareForReload()',
      true,
    ).then((saved: unknown) => {
      if (preparing !== attempt || saved !== true || win.isDestroyed() || contents.isDestroyed()) return;
      if (input.shift || (key === 'f5' && modifier)) contents.reloadIgnoringCache();
      else contents.reload();
    }).catch((err: unknown) => {
      if (preparing === attempt) console.error('[electron] Reload cancelled: could not save renderer sessions', err);
    }).finally(() => { if (preparing === attempt) preparing = undefined; });
  });
}
