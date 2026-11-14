import type { MinnowPreviewLoadFailedDetail } from '../electron';
import type { PreviewSource } from '../state/file-panel';
import { createButton } from './components/button';
import { createIcon } from './icon';

const errorViews = new WeakMap<HTMLElement, {
  root: HTMLElement;
  heading: HTMLElement;
  message: HTMLElement;
  code: HTMLElement;
  external: HTMLButtonElement;
}>();

export function isAbortedPreviewLoad(failure: MinnowPreviewLoadFailedDetail): boolean {
  return failure.errorCode === -3 || /\bERR_ABORTED\b/.test(failure.errorDescription);
}

export function previewRetrySource(source: PreviewSource, failure: MinnowPreviewLoadFailedDetail): PreviewSource {
  if (source.kind !== 'url' || !failure.url) return source;
  const url = browserUrl(failure.url);
  return url ? { kind: 'url', url } : source;
}

function browserUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
      return url.href;
    }
  } catch {
  }
}

function getErrorView(body: HTMLElement, retry: () => void) {
  const existing = errorViews.get(body);
  if (existing) return existing;

  const root = document.createElement('div');
  root.className = 'preview-load-error';
  const content = document.createElement('div');
  content.className = 'preview-load-error__content';
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  const heading = document.createElement('h2');
  const message = document.createElement('p');
  const code = document.createElement('code');
  status.append(createIcon('globe', { size: 24 }), heading, message, code);

  const actions = document.createElement('div');
  actions.className = 'preview-load-error__actions';
  const external = createButton({
    label: 'Open in browser',
    iconEnd: 'externalLink',
    variant: 'ghost',
    onClick: () => {
      const url = external.dataset.url;
      if (!url) return;
      if (window.minnow?.app?.openExternal) void window.minnow.app.openExternal(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    },
  });
  actions.append(createButton({ label: 'Try again', icon: 'refresh', onClick: retry }), external);
  content.append(status, actions);
  root.append(content);
  body.append(root);

  const view = { root, heading, message, code, external };
  errorViews.set(body, view);
  return view;
}

/** Render renderer-owned recovery UI in place of the failed page. */
export function showPreviewLoadError(
  body: HTMLElement | null,
  failure: MinnowPreviewLoadFailedDetail,
  source: PreviewSource | null,
  retry: () => void,
): void {
  if (!body) return;
  const description = failure.errorDescription.trim();
  const code = description.match(/\bERR_[A-Z0-9_]+\b/)?.[0];
  const externalUrl = source?.kind === 'url' ? browserUrl(failure.url) ?? browserUrl(source.url) : undefined;
  const host = externalUrl ? new URL(externalUrl).host : '';
  const blocked = failure.errorCode === -27 || code === 'ERR_BLOCKED_BY_RESPONSE';

  let message = 'Check the address and try again.';
  if (blocked) {
    message = externalUrl ? 'This site blocks embedded previews. Open it in your browser.' : 'This page blocks embedded previews.';
  }
  else if (code === 'ERR_NAME_NOT_RESOLVED') {
    message = host ? `Couldn’t find ${host}. Check the address and try again.` : 'Check the site address and try again.';
  } else if (code === 'ERR_CONNECTION_REFUSED') {
    message = host ? `Couldn’t connect to ${host}. Check that the server is running.` : 'Check that the server is running.';
  } else if (code === 'ERR_INTERNET_DISCONNECTED') {
    message = 'Check your internet connection and try again.';
  } else if (source?.kind === 'workspace') {
    message = 'Check that the file is available in this workspace and try again.';
  }

  const view = getErrorView(body, retry);
  view.root.hidden = false;
  view.heading.textContent = 'Couldn’t load this page';
  view.message.textContent = message;
  view.code.textContent = code ?? (description || `Error ${failure.errorCode}`);
  if (externalUrl) view.external.dataset.url = externalUrl;
  else delete view.external.dataset.url;
  view.external.hidden = !externalUrl;
  body.classList.add('has-load-error');
}

export function clearPreviewLoadError(body: HTMLElement | null): void {
  if (!body) return;
  const view = errorViews.get(body);
  if (view) view.root.hidden = true;
  body.classList.remove('has-load-error');
}
