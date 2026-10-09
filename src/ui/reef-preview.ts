import { bindPreviewInstanceToElement, setPreviewInstanceVisible } from './preview-instance-host';

/** A verified release is a running app, including when opened from the app store. */
export function mountReefPreview(host: HTMLElement, options: {
  instanceId: string;
  name: () => string;
  launch: () => Promise<{ url: string }>;
}) {
  const api = window.minnow?.preview;
  const tabId = 'app';
  let disposed = false, visible = false, running = false;
  let attemptedRelease = '', runningRelease = '';
  let pending: Promise<void> | undefined;
  let unbind = () => {};
  let unsubscribe = () => {};
  let cancelFrameLoad = () => {};
  let frame: HTMLIFrameElement | undefined;

  function message(title: string, detail: string, busy = false) {
    const panel = document.createElement('div'); panel.className = 'reef-preview-empty';
    panel.setAttribute('role', busy ? 'status' : 'alert');
    const heading = document.createElement('h3'); heading.textContent = title;
    const text = document.createElement('p'); text.textContent = detail;
    panel.append(heading, text); host.replaceChildren(panel);
    host.setAttribute('aria-busy', String(busy));
  }
  function fail(error: unknown) {
    if (disposed) return;
    running = false; unbind(); unbind = () => {};
    if (api) void api.hide(tabId, options.instanceId);
    message('Could not open your app', `${error instanceof Error ? error.message : String(error)} Use Run app to try again.`);
  }
  function syncVisibility() {
    if (!api || !running) return;
    if (visible) {
      unbind(); unbind = bindPreviewInstanceToElement(options.instanceId, host);
    } else setPreviewInstanceVisible(options.instanceId, false);
  }
  async function launch(releaseId: string) {
    attemptedRelease = releaseId;
    running = false; unbind(); unbind = () => {}; unsubscribe(); unsubscribe = () => {};
    message('Starting app…', `Opening ${options.name()}.`, true);
    try {
      if (api) await api.hide(tabId, options.instanceId);
      if (disposed) return;
      const { url } = await options.launch();
      if (disposed) return;
      if (api) {
        await api.instances.create(options.instanceId);
        if (disposed) { await api.instances.destroy(options.instanceId); return; }
        // An instance alone has no guest: loadURL needs an actual tab to navigate.
        const created = await api.tabs.create(tabId, options.instanceId);
        if (disposed) { await api.instances.destroy(options.instanceId); return; }
        if (!created) throw new Error('The app preview could not be created.');
        let loadError: Error | undefined;
        const loadFailed = api.onLoadFailed((detail, failedTab, instance) => {
          if (instance !== options.instanceId || failedTab !== tabId || disposed) return;
          loadError = new Error(detail.errorDescription); fail(loadError);
        });
        const crashed = api.onGuestCrashed?.((detail, failedTab, instance) => {
          if (instance !== options.instanceId || failedTab !== tabId || disposed) return;
          loadError = new Error(`The app preview stopped (${detail.reason}).`); fail(loadError);
        });
        unsubscribe = () => { loadFailed(); crashed?.(); };
        await api.loadURL(url, tabId, options.instanceId);
        if (disposed) { await api.instances.destroy(options.instanceId); return; }
        if (loadError) throw loadError;
        host.replaceChildren();
      } else {
        const iframe = document.createElement('iframe'); frame = iframe; iframe.title = options.name(); iframe.hidden = true;
        iframe.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-downloads', 'allow-forms');
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); iframe.removeEventListener('load', loaded); iframe.removeEventListener('error', failed); cancelFrameLoad = () => {}; };
          const loaded = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error('The app preview could not load.')); };
          const timer = setTimeout(() => { cleanup(); reject(new Error('The app preview did not load within 30 seconds.')); }, 30000);
          cancelFrameLoad = () => { cleanup(); resolve(); };
          iframe.addEventListener('load', loaded); iframe.addEventListener('error', failed);
          iframe.src = url; host.append(iframe);
        });
        if (disposed) return;
        // Reattaching a loaded iframe would restart it and discard its app state.
        host.querySelector('.reef-preview-empty')?.remove(); iframe.hidden = false;
      }
      running = true; runningRelease = releaseId; host.setAttribute('aria-busy', 'false'); syncVisibility();
    } catch (error) { fail(error); }
  }
  function start(releaseId: string) {
    if (disposed || !releaseId || (running && runningRelease === releaseId)) return Promise.resolve();
    if (pending) return pending;
    pending = launch(releaseId).finally(() => { pending = undefined; });
    return pending;
  }
  return {
    start,
    open(releaseId: string) { if (releaseId && attemptedRelease !== releaseId) void start(releaseId); },
    setVisible(value: boolean) { if (visible === value) return; visible = value; syncVisibility(); },
    dispose() {
      disposed = true; cancelFrameLoad(); unsubscribe(); unbind(); frame?.remove();
      if (api) void api.instances.destroy(options.instanceId);
    },
  };
}
