import { getSessionToken, isPairedDevice } from './session-token.ts';
import { getViewWorkspacePath } from '../state/view-workspace.ts';

const TOKEN_HEADER = 'X-Minnow-Token';
/** Names the workspace this renderer is bound to; empty → the server's global. */
const WORKSPACE_HEADER = 'X-Minnow-Workspace';

let installed = false;

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
}

function isSameOriginApiRequest(input: RequestInfo | URL): boolean {
  const raw = requestUrl(input);
  if (raw.startsWith('/api/')) return true;
  if (typeof window === 'undefined') return false;
  try {
    const parsed = new URL(raw, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** Ask the companion monitor to confirm whether a 401 means this device was revoked. */
function noticeDeviceUnauthorized(input: RequestInfo | URL, response: Response): void {
  if (
    response.status !== 401 ||
    typeof window === 'undefined' ||
    !isPairedDevice() ||
    response.headers.get('X-Minnow-Auth') !== 'required'
  ) {
    return;
  }
  // Only the companion's dedicated auth probe may confirm revocation.
  // Provider/proxy 401s and stale requests must never end a pairing.
  if (new URL(requestUrl(input), window.location.href).pathname === '/api/auth/session') return;
  window.dispatchEvent(new Event('minnow-auth-check'));
}

/** Install once at app bootstrap. */
export function installFetchAuth(): void {
  if (installed) return;
  installed = true;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!isSameOriginApiRequest(input)) return nativeFetch(input, init);
    const token = getSessionToken();
    const workspace = getViewWorkspacePath();
    // A workspace-bound view must name its folder even before it has a token,
    // or an early request would silently resolve against the server's global.
    // Paired devices authenticate with their HttpOnly cookie (same-origin).
    const request =
      !token && !workspace
        ? nativeFetch(input, init)
        : (() => {
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            if (token) headers.set(TOKEN_HEADER, token);
            if (workspace) headers.set(WORKSPACE_HEADER, workspace);
            return input instanceof Request
              ? nativeFetch(new Request(input, { ...init, headers }))
              : nativeFetch(input, { ...init, headers });
          })();
    return request.then((response) => {
      noticeDeviceUnauthorized(input, response);
      return response;
    });
  }) as typeof fetch;
}
