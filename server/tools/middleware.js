/**
 * Native tool plugin API: /api/plugins/*
 */

import fs from 'node:fs/promises';
import { handlePackageRequest } from '../plugins/routes.js';
import { listPackages } from '../plugins/manager.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMinnowHome } from '../config/home.js';
import { readConfigJson, writeConfigJson } from '../config/store.js';
import {
  getPluginToolDefinitions,
  reloadPlugins,
} from './loader.js';
import { listMergedPlugins, PLUGIN_ID_RE } from './scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEMPLATE_ROOT = path.join(__dirname, '_template');

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 */
async function copyDirRecursive(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(src, dest);
    } else {
      await fs.copyFile(src, dest);
    }
  }
}

/**
 * @param {string} id
 */
async function ensurePluginIndexEntry(id, enabled = true) {
  const toolsConfig = (await readConfigJson('tools.json')) ?? {};
  const base =
    toolsConfig && typeof toolsConfig === 'object'
      ? { .../** @type {Record<string, unknown>} */ (toolsConfig) }
      : {};
  const plugins =
    base.plugins && typeof base.plugins === 'object'
      ? { .../** @type {Record<string, { enabled?: boolean }>} */ (base.plugins) }
      : {};
  plugins[id] = { enabled };
  base.plugins = plugins;
  await writeConfigJson('tools.json', base);
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handlePluginsRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/plugins')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (await handlePackageRequest(req, res, pathname)) return true;
    if (pathname === '/api/plugins/ping' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        homeDir: getMinnowHome(),
        pluginCount: (await listMergedPlugins()).length,
      });
      return true;
    }

    if (pathname === '/api/plugins' && req.method === 'GET') {
      const plugins = await listMergedPlugins();
      sendJson(
        res,
        200,
        {
          plugins: [...plugins.map((p) => ({
            id: p.id,
            label: p.label,
            description: p.description,
            category: p.category,
            functionName: p.functionName,
            namespacedName: p.namespacedName,
          })), ...(await listPackages()).packages.filter(p => p.enabled).flatMap(p => p.tools.map(t => ({
            id: p.id, label: `${p.name}: ${t.id}`, description: t.description, category: 'utility',
            functionName: t.id, namespacedName: `plugin__${p.id.replace(/-/g, '_')}__${t.id}`,
          })))],
        },
      );
      return true;
    }

    if (pathname === '/api/plugins/tools' && req.method === 'GET') {
      await reloadPlugins();
      const tools = await getPluginToolDefinitions();
      sendJson(res, 200, { tools });
      return true;
    }

    if (pathname === '/api/plugins/reload' && req.method === 'POST') {
      await reloadPlugins();
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/plugins/scaffold' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) {
        sendJson(res, 400, { error: 'Plugin id is required' });
        return true;
      }
      if (!PLUGIN_ID_RE.test(id) || id.startsWith('_')) {
        sendJson(res, 400, {
          error: 'Invalid plugin id (use lowercase letters, numbers, hyphens)',
        });
        return true;
      }

      const destDir = path.join(getMinnowHome(), 'tools', id);
      const manifestPath = path.join(destDir, 'tool.json');
      try {
        await fs.access(manifestPath);
        sendJson(res, 400, { error: `Plugin "${id}" already exists` });
        return true;
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
          throw err;
        }
      }

      await copyDirRecursive(TEMPLATE_ROOT, destDir);
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.id = id;
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      await ensurePluginIndexEntry(id, true);
      await reloadPlugins();

      sendJson(res, 201, {
        ok: true,
        path: destDir,
        plugin: (await listMergedPlugins()).find((p) => p.id === id) ?? null,
      });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
    return true;
  }
}

/**
 * @returns {(req: import('connect').IncomingMessage, res: import('http').ServerResponse, next: () => void) => void}
 */
export function createPluginsMiddleware() {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/plugins')) {
      next();
      return;
    }
    void handlePluginsRequest(req, res, url).then((handled) => {
      if (!handled) next();
    });
  };
}

/**
 * Load plugins on server boot (non-fatal).
 */
export async function initPluginsApi() {
  try {
    await reloadPlugins();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[plugins] init skipped:', message);
  }
}
