import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getMinnowHome } from '../config/home.js';
import { getEffectiveWorkspaceRoot, getToolAbortSignal, resolveSafePath } from '../runtime/path-access.js';
import { readEncryptedJsonFile, writeEncryptedJsonFile } from '../security/secret-box.js';
import { toPluginNamespacedName } from '../tools/bridge.js';
import { pluginId, readPackage } from './manifest.js';
import { runPlugin, stopPlugin } from './runtime.js';

let mutations = Promise.resolve();
const root = () => path.join(getMinnowHome(), 'plugins');
const indexPath = () => path.join(root(), 'registry.json');
const secretPath = id => path.join(root(), 'connections', `${pluginId(id)}.json`);

export function serializePluginMutation(fn) {
  const next = mutations.then(fn, fn);
  mutations = next.catch(() => {});
  return next;
}

async function readIndex() {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(), 'utf8'));
    if (parsed.version !== 1 || !parsed.plugins || typeof parsed.plugins !== 'object') throw new Error('Invalid plugin registry');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, revision: 0, plugins: {} };
    throw error;
  }
}

async function writeIndex(index) {
  await fs.mkdir(root(), { recursive: true });
  index.revision += 1;
  const temp = `${indexPath()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(index, null, 2), { mode: 0o600 });
    await fs.rename(temp, indexPath());
  } finally { await fs.rm(temp, { force: true }); }
}

function releasePath(record) {
  pluginId(record.manifest.id);
  if (!/^[0-9a-f-]{36}$/.test(record.release)) throw new Error('Invalid plugin release');
  return path.join(root(), 'packages', record.manifest.id, record.release);
}

export async function listPackages() {
  const index = await readIndex();
  return { revision: index.revision, packages: Object.values(index.plugins).map(record => ({
    ...record.manifest, enabled: record.enabled, source: record.source, installedAt: record.installedAt,
    release: record.release,
  })).sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function inspectPackage(source) {
  const resolved = resolveSafePath(await fs.realpath(resolveSafePath(source)));
  const { manifest, digest } = await readPackage(resolved);
  return { manifest, digest, source: resolved, trust: 'Native handlers have full local user access. Install only code you trust.' };
}

async function install(source, enabled, replace, expectedId, expectedDigest) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('A workspace plugin folder is required');
  const resolved = resolveSafePath(await fs.realpath(resolveSafePath(source)));
  const { manifest, files, digest } = await readPackage(resolved);
  if (expectedDigest && digest !== expectedDigest) throw new Error('Plugin source changed after review. Review it again before installing.');
  if (expectedId && manifest.id !== expectedId) throw new Error('Updated plugin id must match the installed plugin');
  const index = await readIndex();
  const previous = index.plugins[manifest.id];
  try {
    await fs.access(path.join(getMinnowHome(), 'tools', manifest.id, 'tool.json'));
    throw new Error('Plugin id conflicts with an existing legacy tool plugin');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && !replace) throw new Error('Plugin already installed; use update');
  if (!previous && replace) throw new Error('Plugin is not installed');
  const record = { manifest, source: resolved, enabled: enabled ?? previous?.enabled ?? true, release: randomUUID(), installedAt: new Date().toISOString() };
  const destination = releasePath(record);
  try {
    for (const file of files) {
      const target = path.join(destination, file.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.bytes, { flag: 'wx' });
    }
    await stopPlugin(manifest.id);
    index.plugins[manifest.id] = record;
    await writeIndex(index);
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
  if (previous) await fs.rm(releasePath(previous), { recursive: true, force: true }).catch(() => {});
  return { id: manifest.id, enabled: record.enabled, version: manifest.version };
}

export async function managePackage(args) {
  return serializePluginMutation(async () => {
    if (args.action === 'install') return install(args.path, true, false, undefined, args.digest);
    const id = pluginId(args.id);
    const index = await readIndex();
    const record = index.plugins[id];
    if (!record) throw new Error('Plugin is not installed');
    if (args.action === 'update' || args.action === 'reload') return install(args.path ?? record.source, record.enabled, true, id, args.digest);
    if (!['enable', 'disable', 'remove'].includes(args.action)) throw new Error('Unknown plugin action');
    await stopPlugin(id);
    if (args.action === 'remove') delete index.plugins[id];
    else record.enabled = args.action === 'enable';
    await writeIndex(index);
    if (args.action === 'remove') {
      await fs.rm(releasePath(record), { recursive: true, force: true }).catch(() => {});
      await fs.rm(secretPath(id), { force: true });
    }
    return { id, action: args.action, ok: true };
  });
}

export async function packageTools() {
  const { packages } = await listPackages();
  return packages.filter(p => p.enabled).flatMap(p => p.tools.map(t => ({
    type: 'function', function: { name: toPluginNamespacedName(p.id, t.id), description: t.description, parameters: t.parameters },
  })));
}

export async function executePackageTool(name, args, options = {}) {
  const index = await readIndex();
  for (const record of Object.values(index.plugins)) {
    const tool = record.manifest.tools.find(t => toPluginNamespacedName(record.manifest.id, t.id) === name);
    if (!tool) continue;
    if (!record.enabled) throw new Error('Plugin is disabled');
    if (options.pluginRelease && options.pluginRelease !== record.release) throw new Error('Plugin changed. Reopen this panel.');
    const id = record.manifest.id;
    const dataDir = path.join(root(), 'data', id);
    await fs.mkdir(dataDir, { recursive: true });
    const admitted = await serializePluginMutation(async () => {
      const current = (await readIndex()).plugins[id];
      if (!current?.enabled || current.release !== record.release) throw new Error('Plugin changed; retry the call');
      const credentials = await readEncryptedJsonFile(secretPath(id), {});
      const connections = {};
      for (const connection of record.manifest.connections) {
        connections[connection.id] = {};
        for (const field of connection.fields) {
          const value = credentials[connection.id]?.[field.id] ?? '';
          if (field.required && !value) throw new Error(`Configure ${connection.label}: ${field.label} in Settings → Plugins`);
          connections[connection.id][field.id] = value;
        }
      }
      const result = runPlugin(id, path.join(releasePath(record), tool.handler), args, {
        pluginId: id, workspaceRoot: getEffectiveWorkspaceRoot(), dataDir, connections,
      }, tool.timeoutMs, getToolAbortSignal(), tool.parameters);
      result.catch(() => {});
      return { result };
    });
    return admitted.result;
  }
  return undefined;
}

export async function connectionSettings(id, values) {
  return serializePluginMutation(async () => {
    const record = (await readIndex()).plugins[pluginId(id)];
    if (!record) throw new Error('Plugin is not installed');
    const saved = await readEncryptedJsonFile(secretPath(id), {});
    if (values !== undefined) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('connections must be an object');
      for (const [connectionId, fields] of Object.entries(values)) {
        const connection = record.manifest.connections.find(c => c.id === connectionId);
        if (!connection || !fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Unknown connection');
        saved[connectionId] ??= {};
        for (const [fieldId, value] of Object.entries(fields)) {
          if (!connection.fields.some(f => f.id === fieldId) || typeof value !== 'string' || value.length > 16384) throw new Error('Invalid connection field');
          saved[connectionId][fieldId] = value;
        }
      }
      await writeEncryptedJsonFile(secretPath(id), saved);
      await stopPlugin(id);
    }
    return Object.fromEntries(record.manifest.connections.map(c => [c.id, Object.fromEntries(c.fields.map(f => [f.id, {
      configured: Boolean(saved[c.id]?.[f.id]), ...(f.secret ? {} : { value: saved[c.id]?.[f.id] ?? '' }),
    }]))]));
  });
}

export async function panelContent(id, panelId) {
  const record = (await readIndex()).plugins[pluginId(id)];
  if (!record?.enabled) throw new Error('Plugin is disabled or not installed');
  const panel = record.manifest.panels.find(p => p.id === panelId);
  if (!panel) throw new Error('Unknown plugin panel');
  const html = await fs.readFile(path.join(releasePath(record), panel.entry), 'utf8');
  return { html, release: record.release, title: panel.title, tools: record.manifest.tools.map(t => t.id) };
}

export async function packageSkillFiles() {
  const index = await readIndex();
  return Object.values(index.plugins).filter(p => p.enabled).flatMap(p => p.manifest.skills.map(s => ({
    id: `plugin-${p.manifest.id}-${s.id}`, path: path.join(releasePath(p), s.path), pluginName: p.manifest.name,
  })));
}
