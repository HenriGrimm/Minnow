import { refreshSessionsFromServer } from './sessions';

/** Poll shared saved state, and catch up immediately after a backgrounded view wakes. */
export function startSessionLiveSync(onChange: (activeChanged: boolean) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let retryOnWake = false;
  const refresh = async () => {
    if (stopped || controller || document.visibilityState === 'hidden') return;
    controller = new AbortController();
    const timeout = window.setTimeout(() => controller?.abort(), 8_000);
    try {
      const result = await refreshSessionsFromServer(controller.signal);
      if (!stopped && result.changed) onChange(result.activeChanged);
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
