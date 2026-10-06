import { getDeviceToken, getSessionToken, hasHostSessionToken } from './session-token.ts';
import { getViewWorkspacePath } from '../state/view-workspace.ts';

const TOKEN_HEADER = 'X-Minnow-Token';
/** Names the workspace this renderer is bound to; empty → the server's global. */
const WORKSPACE_HEADER = 'X-Minnow-Workspace';

let installed = false;

function isSameOriginApiRequest(input: RequestInfo | URL): boolean {
  const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
  if (raw.startsWith('/api/')) return true;
  if (typeof window === 'undefined') return false;
  try {
    const parsed = new URL(raw, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** Install once at app bootstrap. */
export function installFetchAuth(): void {
  if (installed) return;
  installed = true;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const token = getSessionToken();
    const workspace = getViewWorkspacePath();
    // A workspace-bound view must name its folder even before it has a token,
    // or an early request would silently resolve against the server's global.
    if ((!token && !workspace) || !isSameOriginApiRequest(input)) {
      return nativeFetch(input, init);
    }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (token) headers.set(TOKEN_HEADER, token);
    if (workspace) headers.set(WORKSPACE_HEADER, workspace);

    const request =
      input instanceof Request
        ? nativeFetch(new Request(input, { ...init, headers }))
        : nativeFetch(input, { ...init, headers });
    return request.then((response) => {
      if (
        response.status === 401 &&
        typeof window !== 'undefined' &&
        Boolean(token) &&
        response.headers.get('X-Minnow-Auth') === 'required' &&
        !hasHostSessionToken() &&
        token === getDeviceToken() &&
        new URL(
          typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString(),
          window.location.href,
        ).pathname !== '/api/auth/session'
      ) {
        // Only the companion's dedicated auth probe may confirm revocation.
        // Provider/proxy 401s and stale requests must never erase pairing.
        window.dispatchEvent(new Event('minnow-auth-check'));
      }
      return response;
    });
  }) as typeof fetch;
}
