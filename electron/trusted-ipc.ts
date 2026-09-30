import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { isTrustedShellIpcSource } from './navigation-policy.js';

const trustedIds = new Set<number>();
let appUrl: string | null = null;

export function setTrustedShellUrl(url: string): void {
  appUrl = url;
}

export function trustShellWebContents(id: number): void {
  trustedIds.add(id);
}

export function untrustShellWebContents(id: number): void {
  trustedIds.delete(id);
}

function allowed(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isTrustedShellIpcSource({
    senderId: event.sender.id,
    trustedIds,
    senderFrame: event.senderFrame,
    mainFrame: event.sender.mainFrame,
    senderUrl: event.sender.getURL(),
    appUrl,
  });
}

/** Register a handler that rejects preview guests, subframes, and off-app documents. */
export const trustedIpc = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!allowed(event)) throw new Error('Untrusted IPC sender');
      return listener(event, ...args);
    });
  },
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
    ipcMain.on(channel, (event, ...args) => {
      if (!allowed(event)) {
        event.returnValue = false;
        return;
      }
      listener(event, ...args);
    });
  },
};
