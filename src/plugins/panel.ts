import { executeTool } from '../tools/client';

export interface PluginPanelContent {
  html: string;
  title: string;
  release: string;
  tools: string[];
}

/** An opaque-origin frame can request only its owning plugin's declared tools. */
export function mountPluginPanel(mount: HTMLElement, pluginId: string, panel: PluginPanelContent): () => void {
  const frame = document.createElement('iframe');
  frame.className = 'plugin-panel';
  frame.title = panel.title;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  const channel = crypto.randomUUID();
  const theme = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(['--mn-bg', '--mn-fg', '--mn-fg-muted', '--mn-accent', '--mn-border'].map(key => [key, theme.getPropertyValue(key).trim()]));
  const bootstrap = `(() => {
    const theme = ${JSON.stringify(colors).replace(/</g, '\\u003c')};
    for (const [key, value] of Object.entries(theme)) document.documentElement.style.setProperty(key, value);
    const pending = new Map(); let serial = 0;
    window.minnow = Object.freeze({callTool(tool, args = {}) {
      if (pending.size >= 8) return Promise.reject(new Error('Too many pending calls'));
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Tool request timed out')); }, 180000);
        pending.set(id, {resolve, reject, timer});
        parent.postMessage({channel:${JSON.stringify(channel)}, id, tool, args}, '*');
      });
    }});
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.channel !== ${JSON.stringify(channel)}) return;
      const call = pending.get(event.data.id); if (!call) return;
      clearTimeout(call.timer); pending.delete(event.data.id);
      if (event.data.error) call.reject(new Error(event.data.error)); else call.resolve(event.data.content);
    });
  })();`;
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{background:var(--mn-bg);color:var(--mn-fg);font:14px system-ui}input,button,select,textarea{font:inherit;background:var(--mn-bg);color:var(--mn-fg);border:1px solid var(--mn-border);padding:8px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}:focus-visible{outline:2px solid var(--mn-accent);outline-offset:2px}</style><script>${bootstrap}</script>${panel.html}`;
  let disposed = false;
  const pending = new Set<number>();
  const controller = new AbortController();
  const listener = async (event: MessageEvent) => {
    if (disposed || event.source !== frame.contentWindow || event.data?.channel !== channel) return;
    if (typeof frame.checkVisibility === 'function' && !frame.checkVisibility()) return;
    const { id, tool, args } = event.data;
    if (!Number.isSafeInteger(id) || pending.has(id) || pending.size >= 8) return;
    pending.add(id);
    try {
      if (!panel.tools.includes(tool) || !args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 65536) throw new Error('Invalid plugin tool request');
      const response = await fetch(`/api/plugins/packages/${pluginId}/panels/${encodeURIComponent(mount.dataset.panelId ?? '')}`, { signal: controller.signal });
      if (!response.ok || (await response.json()).release !== panel.release) throw new Error('Plugin changed. Reopen this panel.');
      const result = await executeTool(`plugin__${pluginId.replace(/-/g, '_')}__${tool}`, args, { modeId: 'general', signal: controller.signal, pluginRelease: panel.release });
      if (!disposed) frame.contentWindow?.postMessage({ channel, id, content: result.content }, '*');
    } catch (error) {
      if (!disposed) frame.contentWindow?.postMessage({ channel, id, error: error instanceof Error ? error.message : String(error) }, '*');
    } finally { pending.delete(id); }
  };
  window.addEventListener('message', listener);
  mount.replaceChildren(frame);
  return () => {
    disposed = true;
    controller.abort();
    window.removeEventListener('message', listener);
    frame.remove();
  };
}
