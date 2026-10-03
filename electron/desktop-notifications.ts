import { BrowserWindow, Notification, type WebContents } from 'electron';
import * as channels from './ipc-channels.js';
import { trustedIpc } from './trusted-ipc.js';

export type DesktopNotificationResult = { ok: true } | { ok: false; error: string };

interface DesktopNotificationInput {
  id: string;
  title: string;
  body: string;
  tag?: string;
}

function parseInput(raw: unknown): DesktopNotificationInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.id !== 'string' || !input.id || input.id.length > 200) return null;
  if (typeof input.title !== 'string' || !input.title.trim()) return null;
  if (typeof input.body !== 'string') return null;
  return {
    id: input.id,
    title: input.title.slice(0, 200),
    body: input.body.slice(0, 4000),
    tag: typeof input.tag === 'string' ? input.tag.slice(0, 500) : undefined,
  };
}

/** Native delivery avoids Chromium's origin permission and restores the owning window. */
export function registerDesktopNotificationIpc(
  focusWindow: (win: BrowserWindow) => void,
  icon: string,
): void {
  const activeBySender = new WeakMap<WebContents, Map<string, () => void>>();
  trustedIpc.handle(channels.SHELL_SHOW_NOTIFICATION, (event, raw: unknown): Promise<DesktopNotificationResult> | DesktopNotificationResult => {
    const input = parseInput(raw);
    if (!input) return { ok: false, error: 'Invalid desktop notification' };
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: 'Minnow window is closed' };
    if (!Notification.isSupported()) return { ok: false, error: 'Desktop notifications are unavailable on this system' };

    let active = activeBySender.get(event.sender);
    if (!active) {
      active = new Map();
      activeBySender.set(event.sender, active);
      const owned = active;
      event.sender.once('destroyed', () => {
        for (const close of [...owned.values()]) close();
        owned.clear();
      });
    }
    const key = input.tag || input.id;
    active.get(key)?.();
    // Bound retained objects if an OS does not report dismissed toasts.
    if (active.size >= 100) active.values().next().value?.();
    const owned = active;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: DesktopNotificationResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const sendEvent = (kind: 'click' | 'close' | 'failed'): void => {
        if (!event.sender.isDestroyed()) event.sender.send(channels.SHELL_NOTIFICATION_EVENT, input.id, kind);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, error: 'The system did not confirm the desktop notification. Check system notification settings.' });
        close();
      }, 5000);
      let notification: Notification;
      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (owned.get(key) === close) owned.delete(key);
        sendEvent('close');
        finish({ ok: false, error: 'Desktop notification closed before delivery' });
      };
      const close = (): void => {
        try { notification.close(); } finally { cleanup(); }
      };
      try {
        notification = new Notification({ title: input.title, body: input.body, silent: true, icon });
        // Keep the native object alive until it closes, including after the IPC resolves.
        owned.set(key, close);
        notification.once('show', () => finish({ ok: true }));
        notification.once('click', () => {
          try {
            if (!win.isDestroyed()) focusWindow(win);
            sendEvent('click');
          } finally { close(); }
        });
        notification.once('close', cleanup);
        notification.once('failed', (_event, error: string) => {
          console.warn('[notifications] Native delivery failed:', error);
          finish({ ok: false, error: error || 'The system rejected the desktop notification' });
          sendEvent('failed');
          cleanup();
        });
        notification.show();
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
        cleanup();
      }
    });
  });
}
