import { refreshSessionsFromServer } from './sessions';
import { refreshRemoteChatTurns } from '../chat/turn-ownership';
import { remoteChatTurnsRevision } from '../chat/remote-turn-state';

/** Poll shared saved state, and catch up immediately after a backgrounded view wakes. */
export function startSessionLiveSync(onChange: (activeChanged: boolean) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let retryOnWake = false;
  let activityRevision = -1;
  const refresh = async () => {
    if (stopped || controller || document.visibilityState === 'hidden') return;
    controller = new AbortController();
    const timeout = window.setTimeout(() => controller?.abort(), 8_000);
    try {
      await refreshRemoteChatTurns(controller.signal).catch(() => {});
      const nextActivityRevision = remoteChatTurnsRevision();
      const activityChanged = nextActivityRevision !== activityRevision;
      const result = await refreshSessionsFromServer(controller.signal);
      if (!stopped && (result.changed || activityChanged)) onChange(result.activeChanged || activityChanged);
      activityRevision = nextActivityRevision;
    } catch {
      // A disconnected host retains the last good state; the next poll retries.
    } finally {
      window.clearTimeout(timeout);
      controller = null;
      if (retryOnWake) { retryOnWake = false; void refresh(); }
    }
  };
  const wake = () => {
    if (document.visibilityState === 'hidden') return;
    if (controller) { retryOnWake = true; controller.abort(); }
    else void refresh();
  };
  const timer = window.setInterval(() => { void refresh(); }, 5_000);
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  void refresh();
  return () => {
    stopped = true;
    controller?.abort();
    window.clearInterval(timer);
    window.removeEventListener('online', wake);
    window.removeEventListener('pageshow', wake);
    window.removeEventListener('focus', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}
