/**
 * Load plugin handlers and execute plugin__* tools server-side.
 */

import fs from 'node:fs/promises';
import { executePackageTool, packageTools } from '../plugins/manager.js';
import { readConfigJson } from '../config/store.js';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isPluginToolName,
  manifestToOpenAIDefinition,
  parsePluginNamespacedName,
} from './bridge.js';
import { createPluginContext } from './plugin-context.js';
import { listMergedPlugins } from './scan.js';
import { ensureMinnowLayout, getMinnowHome } from '../config/home.js';
import { getPluginCatalogRevision, invalidatePluginCatalog, watchPluginCatalog } from '../plugins/catalog.js';

export { getPluginCatalogRevision, subscribePluginCatalogChanges } from '../plugins/catalog.js';

/** @type {Map<string, import('./scan.js').PluginListItem>} */
let pluginByNamespaced = new Map();

/** @type {Map<string, { mtimeMs: number, run: (args: Record<string, unknown>, ctx: import('./plugin-context.js').PluginContext) => Promise<string> }>} */
const handlerCache = new Map();

let loadGeneration = 0;
let catalog;
let pendingCatalog;
let catalogHome;

/** Share discovery (including empty inventories and failures), never permissions. */
async function pluginCatalog() {
  const home = getMinnowHome();
  if (catalogHome !== home) {
    catalogHome = home;
    invalidatePluginCatalog();
  }
  if (catalog?.revision === getPluginCatalogRevision()) {
    if (catalog.error) throw catalog.error;
    return catalog;
  }
  if (pendingCatalog) return pendingCatalog;
  pendingCatalog = (async () => {
    try {
      await ensureMinnowLayout();
      await fs.mkdir(path.join(home, 'plugins'), { recursive: true });
      watchPluginCatalog(home);
    } catch (error) {
      catalog = { revision: getPluginCatalogRevision(), error };
      throw error;
    }
    while (true) {
      const revision = getPluginCatalogRevision();
      if (catalog?.revision === revision) {
        if (catalog.error) throw catalog.error;
        return catalog;
      }
      let plugins, definitions, error;
      try {
        plugins = await listMergedPlugins();
        definitions = [...plugins.map(manifestToOpenAIDefinition), ...await packageTools()];
      } catch (failure) { error = failure; }
      if (revision !== getPluginCatalogRevision()) continue;
      catalog = { revision, plugins, definitions, error };
      if (error) throw error;
      loadGeneration++;
      handlerCache.clear();
      pluginByNamespaced = new Map(plugins.map(item => [item.namespacedName, item]));
      return catalog;
    }
  })().finally(() => { pendingCatalog = undefined; });
  return pendingCatalog;
}

/**
 * @param {import('./scan.js').PluginListItem} item
 */
async function compileHandler(item) {
  const stat = await fs.stat(item.handlerPath);
  const cached = handlerCache.get(item.namespacedName);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.run;
  }

  const run = await buildHandlerRunner(item);
  handlerCache.set(item.namespacedName, { mtimeMs: stat.mtimeMs, run });
  return run;
}

/**
 * @param {import('./scan.js').PluginListItem} item
 */
async function buildHandlerRunner(item) {
  if (process.env.MINNOW_PLUGIN_UNSAFE === '1') {
    const url = `${pathToFileURL(item.handlerPath).href}?g=${loadGeneration}`;
    const mod = await import(url);
    if (typeof mod.default !== 'function') {
      throw new Error(`${item.id}/handler.mjs must export default async function`);
    }
    const handler = mod.default;
    return async (args, ctx) => {
      const result = await handler(args, ctx);
      return String(result ?? '');
    };
  }

  const source = await fs.readFile(item.handlerPath, 'utf8');
  const body = source.replace(/^\s*export\s+default\s+/m, '').trim();
  const scriptSource = `(async (args, ctx) => {
    ${body}
    if (typeof handler !== 'function') {
      throw new Error('Plugin handler must export default async function handler(args, ctx)');
    }
    const result = await handler(args, ctx);
    return String(result ?? '');
  })`;

  const script = new vm.Script(scriptSource, { filename: item.handlerPath });

  return async (args, ctx) => {
    const sandbox = {
      args,
      ctx,
      console: {
        log: (...parts) => ctx.log(parts.map(String).join(' ')),
      },
    };
    const context = vm.createContext(sandbox);
    const fn = script.runInContext(context);
    return await fn(args, ctx);
  };
}

/**
 * Refresh in-memory plugin catalog and clear handler cache.
 */
export async function reloadPlugins() {
  invalidatePluginCatalog();
  return (await pluginCatalog()).plugins;
}

/**
 * @returns {Promise<object[]>}
 */
export async function getPluginToolDefinitions() {
  while (true) {
    const { definitions, revision } = await pluginCatalog();
    if (revision === getPluginCatalogRevision()) return [...definitions];
  }
}

/** Pair the filtered inventory with the revision it actually describes. */
export async function getPluginToolCatalog() {
  while (true) {
    const revision = getPluginCatalogRevision();
    const tools = await getPluginToolDefinitions();
    if (revision === getPluginCatalogRevision()) return { tools, revision };
  }
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function callPluginTool(name, args, options = {}) {
  try {
    const result = await executePackageTool(name, args ?? {}, options);
    if (result !== undefined) return result;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isPluginToolName(name)) {
    return `Error: invalid plugin tool name ${name}`;
  }

  await pluginCatalog();

  const item = pluginByNamespaced.get(name);
  if (!item) {
    const parsed = parsePluginNamespacedName(name);
    if (!parsed) {
      return `Error: invalid plugin tool name ${name}`;
    }
    return `Error: plugin tool "${name}" is not loaded or is disabled`;
  }

  try {
    const ctx = createPluginContext();
    const run = await compileHandler(item);
    // A cached inventory/compiled handler cannot preserve a revoked grant.
    const config = await readConfigJson('tools.json');
    if (config?.plugins?.[item.id]?.enabled === false) {
      return 'Error: plugin tool is disabled in Settings';
    }
    return await run(args ?? {}, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

export { isPluginToolName } from './bridge.js';
