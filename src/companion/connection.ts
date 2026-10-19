const RECONNECT_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 4_000;

/**
 * Keep a paired device's view of the host current: connected, unreachable, or
 * revoked. The credential is an HttpOnly cookie, so only the host can end a
 * pairing; an outage never does.
 */
export function startCompanionConnectionMonitor(callbacks: {
  onConnectionChange: (connected: boolean) => void;
  onRevoked: () => void;
  /** Each successful probe's `/api/auth/session` payload. */
  onSession?: (session: { hostName?: string; device?: { id: string; name: string } }) => void;
}): { ready: Promise<boolean>; stop: () => void } {
  let stopped = false;
  let inFlight = false;
  let controller: AbortController | undefined;
  let probeAgain = false;
  let wasConnected: boolean | undefined;
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
    inFlight = true;
    controller = new AbortController();
    const timeout = window.setTimeout(() => controller?.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch('/api/auth/session', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (stopped) return;
      if (response.status === 401 && response.headers.get('X-Minnow-Auth') === 'required') {
        stop();
        callbacks.onRevoked();
        return;
      }
      if (response.ok && callbacks.onSession) {
        try { callbacks.onSession(await response.clone().json()); } catch { /* not JSON */ }
      }
      callbacks.onConnectionChange(response.ok);
      if (response.ok && wasConnected === false) window.dispatchEvent(new Event('minnow-host-reconnected'));
      wasConnected = response.ok;
      if (response.ok) resolveReady(true);
    } catch {
      if (!stopped) {
        wasConnected = false;
        callbacks.onConnectionChange(false);
      }
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
