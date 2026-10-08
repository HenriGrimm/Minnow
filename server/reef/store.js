import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getMinnowHome } from '../config/home.js';

/** @typedef {import('../../src/reef/types.ts').ReefApp} ReefApp */

export const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'interrupted']);
export const reefRoot = () => path.join(getMinnowHome(), 'reef');
export function validId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid Reef identifier');
  return id;
}
export const appRoot = id => path.join(reefRoot(), 'apps', validId(id));

/** Check every existing ancestor, including the root: a junction must not escape Reef. */
export async function safePath(root, ...parts) {
  const target = path.resolve(root, ...parts);
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path outside Reef');
  let cursor = target;
  while (true) {
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Reef paths cannot contain symbolic links');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return target;
}

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(value, null, 2)); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}

const locks = new Map();
export function serialize(id, fn) {
  const prior = locks.get(id) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(fn);
  locks.set(id, next);
  void next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
  return next;
}

/** @returns {Promise<ReefApp>} */
export async function readApp(id) {
  return JSON.parse(await fs.readFile(await safePath(appRoot(id), 'app.json'), 'utf8'));
}
export async function updateApp(id, fn) {
  return serialize(id, async () => {
    const app = await readApp(id);
    await fn(app);
    app.updatedAt = Date.now();
    await atomicJson(await safePath(appRoot(id), 'app.json'), app);
    return app;
  });
}
export async function listApps() {
  const root = await safePath(reefRoot(), 'apps');
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const apps = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    apps.push(await readApp(entry.name));
  }
  return apps.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function boundedText(value, label, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is required (maximum ${max} characters)`);
  return value.trim();
}
export async function createApp(input) {
  const prompt = boundedText(input.prompt, 'Prompt');
  const id = randomUUID();
  const app = {
    version: 1, templateVersion: 1, id,
    name: input.name ? boundedText(input.name, 'Name', 100) : prompt.slice(0, 55),
    description: prompt, providerId: input.providerId, modelId: input.modelId,
    createdAt: Date.now(), updatedAt: Date.now(), status: 'queued',
    release: null, runs: [], exports: [], chatIds: [], messages: [],
  };
  await atomicJson(await safePath(appRoot(id), 'app.json'), app);
  return app;
}

/** Export/release copies reject links and never traverse ignored directories. */
export async function copyTree(source, destination, { exclude = new Set() } = {}) {
  await safePath(source);
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (exclude.has(entry.name) || entry.name.startsWith('.env')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${entry.name}`);
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, { exclude });
    else if (entry.isFile()) await fs.copyFile(from, to);
    else throw new Error(`Unsupported file: ${entry.name}`);
  }
}
