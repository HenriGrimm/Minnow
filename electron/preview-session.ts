import type { Session } from 'electron';
import { BlockList, isIP } from 'node:net';

export const PREVIEW_SESSION_PARTITION = 'persist:minnow-preview';

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8);
loopback.addAddress('0.0.0.0');
loopback.addAddress('::1', 'ipv6');
loopback.addAddress('::', 'ipv6');

function isLocalAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && loopback.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$|\.$/g, '');
}

/** Keep guest requests, including redirects and WebSockets, off the privileged listener. */
export function configurePreviewSession(ses: Session, shellUrl: string): void {
  const shell = new URL(shellUrl);
  const shellPort = shell.port || (shell.protocol === 'https:' ? '443' : '80');
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const http = url.protocol === 'http:' || url.protocol === 'ws:';
    const https = url.protocol === 'https:' || url.protocol === 'wss:';
    const port = url.port || (https ? '443' : '80');
    if ((!http && !https) || port !== shellPort) return callback({ cancel: false });
    const host = hostname(url);
    if (host === hostname(shell) || host === 'localhost' || host.endsWith('.localhost') || isLocalAddress(host)) {
      return callback({ cancel: true });
    }
    if (isIP(host)) return callback({ cancel: false });
    // Match Chromium's resolver, including hosts-file aliases and mixed DNS answers.
    void ses.resolveHost(host).then(
      ({ endpoints }) => callback({ cancel: !endpoints.length || endpoints.some(entry => isLocalAddress(entry.address)) }),
      () => callback({ cancel: true }),
    );
  });
}
