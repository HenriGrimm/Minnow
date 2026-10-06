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

/** @type {Map<string, import('./scan.js').PluginListItem>} */
let pluginByNamespaced = new Map();

/** @type {Map<string, { mtimeMs: number, run: (args: Record<string, unknown>, ctx: import('./plugin-context.js').PluginContext) => Promise<string> }>} */
const handlerCache = new Map();

let loadGeneration = 0;

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
  loadGeneration += 1;
  handlerCache.clear();
  const plugins = await listMergedPlugins();
  const next = new Map();
  for (const item of plugins) {
    next.set(item.namespacedName, item);
  }
  pluginByNamespaced = next;
  return plugins;
}

/**
 * @returns {Promise<object[]>}
 */
export async function getPluginToolDefinitions(options = {}) {
  if (pluginByNamespaced.size === 0) {
    await reloadPlugins();
  }
  const permissions = (await readConfigJson('tools.json'))?.permissions?.default ?? {};
  const definitions = [...[...pluginByNamespaced.values()].map(manifestToOpenAIDefinition), ...await packageTools()];
  return definitions.filter(t => options.requireFull ? permissions[t.function.name] === 'full' : permissions[t.function.name] !== 'off');
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

  if (pluginByNamespaced.size === 0) {
    await reloadPlugins();
  }

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
    return await run(args ?? {}, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

export { isPluginToolName } from './bridge.js';
