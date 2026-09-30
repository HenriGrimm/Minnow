import type { PreviewSource } from '../state/file-panel';
import { getSessionToken, withSessionToken } from '../api/session-token.ts';
import { getViewWorkspacePath } from '../state/view-workspace.ts';

const PREVIEW_FILE_API = '/api/preview/file/';
const PREVIEW_DOCUMENT_HTML_API = '/api/preview/document-html/';
const accessCache = new Map<string, { origin: string; token: string; expiresAt: number }>();

async function isolatedAccess(workspaceRoot?: string): Promise<{ origin: string; token: string }> {
  const root = workspaceRoot?.trim() || getViewWorkspacePath() || '';
  const cached = accessCache.get(root);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached;
  const url = new URL('/api/preview/access', window.location.origin);
  if (root) url.searchParams.set('workspaceRoot', root);
  const headers: Record<string, string> = { 'X-Minnow-Token': getSessionToken() };
  if (root) headers['X-Minnow-Workspace'] = root;
  const response = await fetch(url, { headers, cache: 'no-store' });
  if (!response.ok) throw new Error(`Preview access failed (HTTP ${response.status})`);
  const access = await response.json() as { origin: string; token: string; expiresAt: number };
  accessCache.set(root, access);
  return access;
}

async function isolatedUrl(path: string, workspaceRoot?: string): Promise<string> {
  const access = await isolatedAccess(workspaceRoot);
  return new URL(`/p/${access.token}${path}`, access.origin).href;
}

function normalizeWorkspacePath(input: string): string {
  return input.replace(/^\/+/, '').trim();
}

function appendQueryParam(url: string, key: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

export interface WorkspacePreviewUrlOptions {
  cacheBust?: number;
  workspaceRoot?: string;
  /** Skip HTML `<base>` injection (file viewer / editor loads). */
  raw?: boolean;
}

/** Build preview URL for a workspace-relative path (path only; use resolvePreviewLoadUrl for absolute). */
export function workspacePreviewUrl(
  relativePath: string,
  cacheBust?: number,
  workspaceRoot?: string,
): string;
export function workspacePreviewUrl(
  relativePath: string,
  options?: WorkspacePreviewUrlOptions,
): string;
export function workspacePreviewUrl(
  relativePath: string,
  cacheBustOrOptions?: number | WorkspacePreviewUrlOptions,
  workspaceRoot?: string,
): string {
  const options: WorkspacePreviewUrlOptions =
    typeof cacheBustOrOptions === 'object' && cacheBustOrOptions !== null
      ? cacheBustOrOptions
      : {
          cacheBust:
            typeof cacheBustOrOptions === 'number' ? cacheBustOrOptions : undefined,
          workspaceRoot,
        };
  const normalized = normalizeWorkspacePath(relativePath);
  const encoded = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  let url = `${PREVIEW_FILE_API}${encoded}`;
  if (options.cacheBust !== undefined) {
    url = appendQueryParam(url, 'v', String(options.cacheBust));
  }
  const root = options.workspaceRoot?.trim();
  if (root) {
    url = appendQueryParam(url, 'workspaceRoot', root);
  }
  if (options.raw) {
    url = appendQueryParam(url, 'raw', '1');
  }
  return withSessionToken(url);
}

/** Build HTML preview URL for spreadsheet/Word workspace files. */
export function workspaceDocumentHtmlUrl(
  relativePath: string,
  cacheBust?: number,
  workspaceRoot?: string,
): string {
  const normalized = normalizeWorkspacePath(relativePath);
  const encoded = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  let url = `${PREVIEW_DOCUMENT_HTML_API}${encoded}`;
  if (cacheBust !== undefined) {
    url = appendQueryParam(url, 'v', String(cacheBust));
  }
  const root = workspaceRoot?.trim();
  if (root) {
    url = appendQueryParam(url, 'workspaceRoot', root);
  }
  return withSessionToken(url);
}

function resolveRootRelativeUrl(url: string): string {
  if (url.startsWith('/') && !url.startsWith('//')) {
    return `${window.location.origin}${url}`;
  }
  return url;
}

/** Absolute URL for spreadsheet/Word HTML preview in the file viewer. */
export function resolveDocumentHtmlLoadUrl(
  relativePath: string,
  cacheBust?: number,
  workspaceRoot?: string,
): string {
  const path = workspaceDocumentHtmlUrl(relativePath, cacheBust, workspaceRoot);
  return `${window.location.origin}${path}`;
}

/** Absolute URL passed to the preview guest (Electron or iframe with full origin). */
export function resolvePreviewLoadUrl(
  source: PreviewSource,
  cacheBust?: number,
  workspaceRoot?: string,
  options?: { raw?: boolean },
): string {
  if (source.kind === 'url') return resolveRootRelativeUrl(source.url);
  const path = workspacePreviewUrl(source.path, {
    cacheBust,
    workspaceRoot,
    raw: options?.raw,
  });
  return `${window.location.origin}${path}`;
}

/** Executable workspace pages load from a preview-only origin with workspace-scoped access. */
export async function resolveIsolatedPreviewLoadUrl(
  source: PreviewSource,
  cacheBust?: number,
  workspaceRoot?: string,
): Promise<string> {
  if (source.kind === 'url') return resolveRootRelativeUrl(source.url);
  const path = workspacePreviewUrl(source.path, { cacheBust, workspaceRoot });
  const parsed = new URL(path, window.location.origin);
  parsed.searchParams.delete('token');
  parsed.searchParams.delete('workspace');
  parsed.searchParams.delete('workspaceRoot');
  return isolatedUrl(parsed.pathname + parsed.search, workspaceRoot);
}
