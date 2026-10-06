/**
 * Native OS notifications for alerts you must not miss.
 *
 * Only fires when the Minnow window is **unfocused** — an in-app bell is enough
 * while you are looking at the app, and a duplicate desktop toast over a window
 * you are already using is noise.
 *
 * Electron uses the native main-process bridge; browser sessions use the Web
 * Notification API after permission has been granted from Settings.
 */

export interface OsNotificationInput {
  title: string;
  body: string;
  /** Dedupe + replace key; a second alert for the same issue supersedes. */
  tag?: string;
  /** Run when the user clicks the desktop notification. */
  onClick?: () => void;
}

type NotificationCtor = new (title: string, options?: NotificationOptions) => Notification;
type DeliveryResult = { ok: true } | { ok: false; error: string };

function notificationApi(): NotificationCtor | null {
  const ctor = (globalThis as { Notification?: unknown }).Notification;
  return typeof ctor === 'function' ? (ctor as NotificationCtor) : null;
}

/** True when the app window is not the user's current focus. */
export function isWindowUnfocused(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState === 'hidden') return true;
  return typeof document.hasFocus === 'function' ? !document.hasFocus() : false;
}

/**
 * Show a desktop notification, or do nothing.
 *
 * Returns whether one was shown, so callers can log or test the decision
 * without reaching into the platform API.
 */
export async function notifyOs(input: OsNotificationInput): Promise<boolean> {
  if (!isWindowUnfocused()) return false;
  const result = await deliverNotification(input);
  if (!result.ok) console.warn('[notifications] Desktop delivery skipped:', result.error);
  return result.ok;
}

async function deliverNotification(input: OsNotificationInput): Promise<DeliveryResult> {
  const shell = typeof window !== 'undefined' ? window.minnow?.shell : undefined;
  if (shell?.showNotification) {
    try {
      return await shell.showNotification({ title: input.title, body: input.body, tag: input.tag }, input.onClick);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const Ctor = notificationApi();
  if (!Ctor) return { ok: false, error: 'This browser does not support desktop notifications.' };
  const permission = (Ctor as unknown as { permission?: string }).permission;
  if (permission === 'denied' || permission === 'default') {
    return { ok: false, error: 'Allow notifications for Minnow in your browser site settings, then try again.' };
  }

  try {
    const notification = new Ctor(input.title, {
      body: input.body,
      tag: input.tag,
      silent: true,
    });
    notification.onclick = () => {
      try {
        window.focus();
        input.onClick?.();
      } finally {
        notification.close();
      }
    };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Explicit user gesture: request browser permission and bypass the background gate. */
export async function testDesktopNotification(): Promise<DeliveryResult> {
  if (typeof window !== 'undefined' && window.minnow?.app?.isElectron && !window.minnow.shell?.showNotification) {
    return { ok: false, error: 'Restart Minnow to load desktop notification support.' };
  }
  if (typeof window === 'undefined' || !window.minnow?.shell?.showNotification) {
    const api = notificationApi() as (NotificationCtor & typeof Notification) | null;
    if (api?.permission === 'default' && typeof api.requestPermission === 'function') {
      try {
        await api.requestPermission();
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  return deliverNotification({ title: 'Minnow', body: 'Desktop notifications are working.', tag: 'minnow-notification-test' });
}
