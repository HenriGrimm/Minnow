import { createPluginUiContext, type PluginUiContext } from './ui-context';

interface PackageUi {
  id: string; enabled: boolean; release: string; ui?: { entry: string };
}
interface Catalog { revision: number; packages: PackageUi[] }
export interface PluginUiModule {
  default: (context: PluginUiContext) => void | (() => void) | Promise<void | (() => void)>;
}
type ModuleLoader = (code: string) => Promise<PluginUiModule>;

async function importUi(code: string): Promise<PluginUiModule> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try { return await import(/* @vite-ignore */ url); }
  finally { URL.revokeObjectURL(url); }
}

/** One catalog watcher per renderer, shared across every workspace surface. */
export function createPluginUiRuntime(loadModule: ModuleLoader = importUi) {
  const active = new Map<string, { release: string; dispose: () => void }>();
  const failures = new Map<string, { release: string; message: string }>();
  let stopped = false;
  let refreshing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const abort = new AbortController();

  async function sync() {
    const response = await fetch('/api/plugins/packages', { signal: abort.signal });
    if (!response.ok) throw new Error(`Cannot load plugin UI (${response.status})`);
    const catalog: Catalog = await response.json();
    if (stopped) return;
    const wanted = new Map(catalog.packages.filter(p => p.enabled && p.ui).map(p => [p.id, p]));
    for (const [id, loaded] of active) {
      if (wanted.get(id)?.release === loaded.release) continue;
      loaded.dispose();
      active.delete(id);
    }
    for (const [id, failed] of failures) {
      if (wanted.get(id)?.release !== failed.release) failures.delete(id);
    }
    for (const plugin of wanted.values()) {
      if (stopped || active.has(plugin.id) || failures.get(plugin.id)?.release === plugin.release) continue;
      let owner: ReturnType<typeof createPluginUiContext> | undefined;
      try {
        const source = await fetch(`/api/plugins/packages/${plugin.id}/ui/${plugin.release}`, { signal: abort.signal });
        if (!source.ok) throw new Error(`Cannot load UI entry (${source.status})`);
        const body = await source.json() as { code: string; release: string; tools: string[] };
        if (body.release !== plugin.release) throw new Error('Plugin changed during UI loading');
        const module = await loadModule(body.code);
        if (stopped) return;
        if (typeof module.default !== 'function') throw new Error('UI entry must export a default activation function');
        owner = createPluginUiContext(plugin.id, plugin.release, body.tools);
        // Register the owner before activation so stop can abort an async initializer.
        active.set(plugin.id, { release: plugin.release, dispose: owner.dispose });
        const cleanup = await module.default(owner.context);
        if (typeof cleanup === 'function') owner.context.onCleanup(cleanup);
        if (stopped) { owner.dispose(); return; }
      } catch (error) {
        owner?.dispose();
        active.delete(plugin.id);
        if (stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        failures.set(plugin.id, { release: plugin.release, message });
        console.error(`[plugin-ui] ${plugin.id}: ${message}`);
      }
    }
  }
  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    return refreshing ??= sync().finally(() => { refreshing = undefined; });
  }
  return {
    refresh,
    status(id: string): string | null { return failures.get(id)?.message ?? null; },
    async start() {
      try { await refresh(); } catch (error) { console.error('[plugin-ui] catalog unavailable', error); }
      if (!stopped && !timer) timer = setInterval(() => { void refresh().catch(() => {}); }, 3000);
    },
    stop() {
      stopped = true;
      abort.abort();
      if (timer) clearInterval(timer);
      for (const loaded of active.values()) loaded.dispose();
      active.clear();
      failures.clear();
    },
  };
}

let runtime: ReturnType<typeof createPluginUiRuntime> | undefined;

export async function initPluginUi(): Promise<void> {
  if (runtime) return;
  runtime = createPluginUiRuntime();
  window.addEventListener('beforeunload', () => runtime?.stop(), { once: true });
  await runtime.start();
}

export async function refreshPluginUi(): Promise<void> { await runtime?.refresh(); }
export function pluginUiError(id: string): string | null { return runtime?.status(id) ?? null; }
