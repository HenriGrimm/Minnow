import type { UtilityProcess } from 'electron';

export interface BackendEndpoint {
  url: string;
  token: string;
}

export interface DesktopBackend {
  ready: Promise<BackendEndpoint>;
  endpoint(): BackendEndpoint | undefined;
  close(): Promise<void>;
}

export const BACKEND_SERVICE_NAME = 'Minnow Backend';

function readEndpoint(message: unknown): BackendEndpoint | undefined {
  if (!message || typeof message !== 'object') return;
  const { type, url, token } = message as Record<string, unknown>;
  if (type !== 'ready' || typeof url !== 'string' || typeof token !== 'string'
    || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(url)
    || !/^[a-f0-9]{64}$/.test(token)) return;
  try { new URL(url); } catch { return; }
  return { url, token };
}

/** Own one backend lifetime. A new host is never started against the same profile on a crash. */
export function superviseBackend(
  child: Pick<UtilityProcess, 'on' | 'once' | 'postMessage' | 'kill'>,
  onUnexpectedExit: (code: number) => void,
  { startupMs = 60_000, shutdownMs = 35_000, reapMs = 5_000 } = {},
): DesktopBackend {
  let endpoint: BackendEndpoint | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let terminating = false;
  let resolveReady!: (value: BackendEndpoint) => void;
  let rejectReady!: (error: Error) => void;
  let resolveExit!: () => void;
  const ready = new Promise<BackendEndpoint>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const terminate = (): void => {
    if (stopped || terminating) return;
    terminating = true;
    try { child.kill(); }
    catch (error) { console.error('[backend] Could not terminate utility process:', error); }
  };
  const startupTimer = setTimeout(() => {
    rejectReady(new Error('Minnow backend did not become ready in time.'));
    terminate();
  }, startupMs);

  child.on('message', (message: unknown) => {
    if (stopped || closing || terminating || endpoint) return;
    const next = readEndpoint(message);
    if (next) {
      clearTimeout(startupTimer);
      endpoint = next;
      resolveReady(next);
    }
  });
  // Electron reports fatal errors separately from exit. Exit is authoritative
  // for both ownership of the profile and whether the listener is gone.
  child.on('error', (type) => console.error('[backend] Utility process error:', type));
  child.once('exit', (code) => {
    const wasReady = Boolean(endpoint);
    stopped = true;
    endpoint = undefined;
    clearTimeout(startupTimer);
    resolveExit();
    rejectReady(new Error(`Minnow backend exited before it was ready (code ${code}).`));
    if (wasReady && !closing) onUnexpectedExit(code);
  });

  return {
    ready,
    endpoint: () => endpoint,
    close() {
      if (closing) return closing;
      if (stopped) return exited;
      clearTimeout(startupTimer);
      rejectReady(new Error('Minnow closed before the backend was ready.'));
      closing = new Promise<void>((resolve, reject) => {
        let reapTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = setTimeout(() => {
          terminate();
          reapTimer = setTimeout(() => reject(new Error('Minnow backend did not exit.')), reapMs);
        }, shutdownMs);
        void exited.then(() => {
          clearTimeout(deadline);
          clearTimeout(reapTimer);
          resolve();
        });
      });
      try {
        if (!terminating) child.postMessage({ type: 'shutdown' });
      } catch {
        terminate();
      }
      return closing;
    },
  };
}
