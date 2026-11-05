import type { Session } from 'electron';

export const PREVIEW_SESSION_PARTITION = 'persist:minnow-preview';

function listenerHost(url: URL): string {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'localhost' : url.hostname;
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
    callback({ cancel: (http || https) && port === shellPort && listenerHost(url) === listenerHost(shell) });
  });
}
