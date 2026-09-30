/**
 * Bind the packaged in-process HTTP server to a stable port.
 * Port 0 (ephemeral) made Chromium treat every launch as a new origin, so
 * localStorage theme prefs were discarded on reboot.
 */

import type { Server } from 'node:http';

export type ListenNetworkAccess = 'local' | 'lan';

export interface NetworkListenResult {
  port: number;
  /** True when the preferred port was taken and we fell back to an ephemeral bind. */
  ephemeral: boolean;
}

function isAddrInUse(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE');
}

/** Listen on the address selected at boot. Rejects with the listen error. */
export function listenOnHost(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error(`In-process server failed to bind to ${host}`));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Listen on 127.0.0.1 at `port`. */
export function listenLoopback(server: Server, port: number): Promise<number> {
  return listenOnHost(server, port, '127.0.0.1');
}

/**
 * Prefer `preferredPort` so the renderer origin stays stable across launches.
 * If that port is busy (dev server already running), fall back to an ephemeral port.
 */
export async function listenOnPreferredLoopback(
  server: Server,
  preferredPort: number,
): Promise<NetworkListenResult> {
  return listenOnPreferredNetwork(server, preferredPort, 'local');
}

/** Keep the desktop origin on loopback even when companion access is enabled. */
export async function listenOnPreferredNetwork(
  server: Server,
  preferredPort: number,
  networkAccess: ListenNetworkAccess,
): Promise<NetworkListenResult> {
  const host = networkAccess === 'lan' ? '0.0.0.0' : '127.0.0.1';
  try {
    const port = await listenOnHost(server, preferredPort, host);
    return { port, ephemeral: false };
  } catch (err) {
    if (!isAddrInUse(err)) throw err;
    const port = await listenOnHost(server, 0, host);
    return { port, ephemeral: true };
  }
}
