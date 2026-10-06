import type { WebContents } from 'electron';
import { allowedExternalUrl, isAllowedShellNavigation } from './navigation-policy.js';

type NavigationContents = Pick<WebContents, 'id' | 'on' | 'once' | 'setWindowOpenHandler'>;

/** Bind one trusted app document and revoke its IPC access when its contents die. */
export function wireShellNavigation(
  contents: NavigationContents,
  appUrl: string,
  options: {
    trust: (id: number) => void;
    untrust: (id: number) => void;
    openExternal: (url: string) => Promise<unknown>;
    /** Auxiliary viewer stays on its own route; workspace windows allow any hash route. */
    routeHash?: string;
  },
): () => void {
  const id = contents.id;
  let revoked = false;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    options.untrust(id);
  };
  options.trust(id);
  contents.once('destroyed', revoke);

  const preventOffAppNavigation = (event: Electron.Event, targetUrl: string): void => {
    if (isAllowedShellNavigation(targetUrl, appUrl)) {
      if (!options.routeHash || new URL(targetUrl).hash === options.routeHash) return;
    }
    event.preventDefault();
  };
  contents.on('will-navigate', preventOffAppNavigation);
  contents.on('will-redirect', preventOffAppNavigation);
  contents.setWindowOpenHandler(({ url }) => {
    const external = allowedExternalUrl(url);
    if (external) {
      try {
        void options.openExternal(external).catch(() => {});
      } catch {
        // The popup remains denied even when the OS cannot open the link.
      }
    }
    return { action: 'deny' };
  });

  return revoke;
}
