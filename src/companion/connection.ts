import { clearDeviceToken, getDeviceToken } from '../api/session-token.ts';

const RECONNECT_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 4_000;

/** Keep device authorization independent of workspace, viewport, and network loss. */
export function startCompanionConnectionMonitor(callbacks: {
  onConnectionChange: (connected: boolean) => void;
  onRevoked: () => void;
}): { ready: Promise<boolean>; stop: () => void } {
  let stopped = false;
  let inFlight = false;
  let controller: AbortController | undefined;
  let probeAgain = false;
  let resolveReady: (authorized: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });

  const onVisible = () => {
    if (document.visibilityState === 'visible') resume();
  };
  // Mobile browsers can suspend a fetch and its timeout together. Discard it on
  // wake rather than waiting for a stale check before trying the restored Wi-Fi.
  const resume = () => {
    if (inFlight) {
      probeAgain = true;
      controller?.abort();
    } else {
      probe();
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller?.abort();
    window.clearInterval(timer);
    window.removeEventListener('online', resume);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('offline', probe);
    window.removeEventListener('minnow-auth-check', probe);
    document.removeEventListener('visibilitychange', onVisible);
    resolveReady(false);
  };
  const probe = () => { void check(); };
  const check = async () => {
    if (stopped || inFlight) return;
    const token = getDeviceToken();
    if (!token) return;
    inFlight = true;
    controller = new AbortController();
    const timeout = window.setTimeout(() => controller?.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch('/api/auth/session', {
        cache: 'no-store',
        headers: { 'X-Minnow-Token': token },
        signal: controller.signal,
      });
      // A late reply from an old credential cannot revoke a newer pairing.
      if (stopped || token !== getDeviceToken()) return;
      if (response.status === 401 && response.headers.get('X-Minnow-Auth') === 'required') {
        clearDeviceToken();
        stop();
        callbacks.onRevoked();
        return;
      }
      callbacks.onConnectionChange(response.ok);
      if (response.ok) resolveReady(true);
    } catch {
      if (!stopped && token === getDeviceToken()) callbacks.onConnectionChange(false);
    } finally {
      window.clearTimeout(timeout);
      inFlight = false;
      if (probeAgain && !stopped) {
        probeAgain = false;
        probe();
      }
    }
  };

  const timer = window.setInterval(probe, RECONNECT_INTERVAL_MS);
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  window.addEventListener('offline', probe);
  window.addEventListener('minnow-auth-check', probe);
  document.addEventListener('visibilitychange', onVisible);
  probe();
  return { ready, stop };
}
