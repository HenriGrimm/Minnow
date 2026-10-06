import type { BrowserWindow } from 'electron';

/** Keep the renderer alive until its ordinary, acknowledged session save finishes. */
export function wireShellReload(win: BrowserWindow): void {
  let preparing = false;
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    const key = input.key.toLowerCase();
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    if (key !== 'f5' && !(modifier && key === 'r')) return;
    event.preventDefault();
    if (preparing) return;
    preparing = true;
    void win.webContents.executeJavaScript(
      'typeof globalThis.__minnowPrepareForReload === "function" && globalThis.__minnowPrepareForReload()',
      true,
    ).then((saved: unknown) => {
      if (saved !== true || win.isDestroyed() || win.webContents.isDestroyed()) return;
      if (input.shift || (key === 'f5' && modifier)) win.webContents.reloadIgnoringCache();
      else win.webContents.reload();
    }).catch((err: unknown) => {
      console.error('[electron] Reload cancelled: could not save renderer sessions', err);
    }).finally(() => { preparing = false; });
  });
}
