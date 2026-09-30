import type { Session } from 'electron';

export const PREVIEW_SESSION_PARTITION = 'persist:minnow-preview';

const STRIP_RESPONSE_HEADER_NAMES = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]);

const configuredSessions = new WeakSet<Session>();

export function isMinnowPreviewResponseUrl(url: string): boolean {
  try {
    return /^(?:\/api\/preview\/|\/p\/[a-f0-9]{64}\/api\/preview\/)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function sanitizeEmbedBlockingHeaders(
  responseHeaders: Record<string, string | string[]>,
  preserveSecurityHeaders = false,
): Record<string, string | string[]> {
  const headers = { ...responseHeaders };

  if (preserveSecurityHeaders) return headers;

  for (const key of Object.keys(headers)) {
    if (STRIP_RESPONSE_HEADER_NAMES.has(key.toLowerCase())) {
      delete headers[key];
    }
  }

  return headers;
}

export function configurePreviewSession(ses: Session): void {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);

  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    if (!details.responseHeaders) {
      callback({});
      return;
    }
    callback({
      responseHeaders: sanitizeEmbedBlockingHeaders(
        details.responseHeaders,
        isMinnowPreviewResponseUrl(details.url),
      ),
    });
  });
}
