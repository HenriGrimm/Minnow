import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import type { MinnowPreviewApi } from '../../src/electron';
import { getActivePreviewTabId } from '../../src/ui/preview-tab-store';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

test('Browser shows a DNS failure in the page area and retries the failed address', async t => {
  const win = new Window({ url: 'http://localhost:9473/' });
  installHappyDomGlobals(win, { fetch: async () => new Response('{}') });
  t.after(() => teardownHappyDomAsync(win));

  document.body.innerHTML = `
    <input id="previewUrlInput">
    <div id="previewBody"></div>
  `;
  const body = document.getElementById('previewBody')!;
  const address = document.querySelector<HTMLInputElement>('#previewUrlInput')!;
  const external: string[] = [];
  let navigate: Parameters<MinnowPreviewApi['onNavigation']>[0] = () => {};
  let failLoad: Parameters<MinnowPreviewApi['onLoadFailed']>[0] = () => {};
  let finishRetry!: () => void;
  const retried = new Promise<void>(resolve => { finishRetry = resolve; });
  const attempted: string[] = [];
  const noop = () => () => {};
  window.minnow = {
    app: { openExternal: async (url: string) => { external.push(url); } },
    preview: {
      show: async () => {},
      hide: async () => {},
      onLoading: noop,
      onPageTitle: noop,
      onNavigation: (callback: typeof navigate) => {
        navigate = callback;
        return () => {};
      },
      onLoadFailed: (callback: typeof failLoad) => {
        failLoad = callback;
        return () => {};
      },
      navigateAndWait: async (url: string) => {
        attempted.push(url);
        finishRetry();
        return { ok: true, url, title: '' };
      },
    },
  } as unknown as typeof window.minnow;
  const { initPreviewPanel } = await import('../../src/ui/preview-panel');
  await initPreviewPanel();
  const tabId = getActivePreviewTabId()!;
  navigate('https://example.com/', tabId);

  const url = 'https://minnow-preview.invalid/docs';
  const error = { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', url };
  failLoad(error, tabId, 'workspace-preview-secondary');
  assert.equal(body.classList.contains('has-load-error'), false);

  failLoad(error, tabId, 'workspace-preview');
  const view = body.querySelector<HTMLElement>('.preview-load-error')!;
  assert.equal(view.hidden, false);
  assert.equal(view.querySelector('h2')?.textContent, 'Couldn’t load this page');
  assert.match(view.querySelector('p')!.textContent!, /minnow-preview\.invalid/);
  assert.equal(view.querySelector('code')?.textContent, 'ERR_NAME_NOT_RESOLVED');
  assert.equal(address.value, url);
  navigate('chrome-error://chromewebdata/', tabId, 'workspace-preview');
  assert.equal(view.hidden, false);
  assert.equal(address.value, url);

  const [retryButton, externalButton] = view.querySelectorAll('button');
  externalButton.click();
  assert.deepEqual(external, [url]);
  retryButton.click();
  await retried;
  assert.deepEqual(attempted, [url]);
  assert.equal(view.hidden, true);
  assert.equal(body.classList.contains('has-load-error'), false);
});
