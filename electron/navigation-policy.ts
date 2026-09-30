/** URL policy for privileged shell navigation and OS protocol dispatch. */

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function allowedExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (!EXTERNAL_SCHEMES.has(url.protocol)) return null;
    if (url.protocol === 'mailto:') return url.pathname ? url.href : null;
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Shell windows may change hash routes, but may not leave the app document. */
export function isAllowedShellNavigation(target: string, base: string): boolean {
  try {
    const next = new URL(target);
    const app = new URL(base);
    return next.origin === app.origin && next.pathname === app.pathname && next.search === app.search;
  } catch {
    return false;
  }
}

/** Pure IPC decision used by every privileged Electron handler. */
export function isTrustedShellIpcSource(input: {
  senderId: number;
  trustedIds: ReadonlySet<number>;
  senderFrame: unknown;
  mainFrame: unknown;
  senderUrl: string;
  appUrl: string | null;
}): boolean {
  return Boolean(
    input.appUrl &&
    input.trustedIds.has(input.senderId) &&
    input.senderFrame &&
    input.senderFrame === input.mainFrame &&
    isAllowedShellNavigation(input.senderUrl, input.appUrl),
  );
}
