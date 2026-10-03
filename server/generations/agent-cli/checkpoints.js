import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getMinnowHome } from '../../config/home.js';

export const CLI_CACHE_DAYS = 30;
export const cliHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const root = () => path.join(getMinnowHome(), 'cli-sessions');
const prunedRoots = new Map();
export function cliCacheDir(providerId, chatId) { return path.join(root(), cliHash([providerId, chatId])); }
function owned(dir) {
  if (path.dirname(path.resolve(dir)) !== path.resolve(root()) || !/^[a-f0-9]{64}$/.test(path.basename(dir))) {
    throw new Error('CLI cache escaped its private root.');
  }
  return dir;
}
export async function readCliCheckpoint(providerId, chatId) {
  const cacheRoot = root();
  if (!prunedRoots.has(cacheRoot) || Date.now() - prunedRoots.get(cacheRoot).at >= 86_400_000) {
    const prune = pruneCliCaches();
    prunedRoots.set(cacheRoot, { at: Date.now(), promise: prune });
    while (prunedRoots.size > 16) prunedRoots.delete(prunedRoots.keys().next().value);
  }
  await prunedRoots.get(cacheRoot).promise;
  const dir = cliCacheDir(providerId, chatId);
  try {
    const stat = await fs.stat(path.join(dir, 'checkpoint.json'));
    if (stat.size > 64 * 1024) return null;
    const record = JSON.parse(await fs.readFile(path.join(dir, 'checkpoint.json'), 'utf8'));
    return record.version === 1 && record.providerId === providerId && record.chatId === chatId
      && Number.isSafeInteger(record.updatedAt) && record.updatedAt <= Date.now()
      && Date.now() - record.updatedAt < CLI_CACHE_DAYS * 86_400_000 ? { ...record, dir } : null;
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
export async function writeCliCheckpoint(dir, record) {
  owned(dir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'checkpoint.json');
  const temp = path.join(dir, `checkpoint-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify({ ...record, version: 1, updatedAt: Date.now() }), { mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
export function queueCliCheckpoint(session, record) {
  const write = (session.checkpointWrite ?? Promise.resolve()).catch(() => {}).then(() => writeCliCheckpoint(session.cacheDir, record));
  session.checkpointWrite = write;
  return write;
}
export async function removeCliCache(dir) { await fs.rm(owned(dir), { recursive: true, force: true, maxRetries: 5 }); }
export async function pruneCliCaches() {
  const entries = await fs.readdir(root(), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const dir = path.join(root(), entry.name);
    const stat = await fs.stat(path.join(dir, 'checkpoint.json')).catch(() => fs.stat(dir));
    if (Date.now() - stat.mtimeMs > CLI_CACHE_DAYS * 86_400_000) await removeCliCache(dir);
  }
}
export async function forgetCliCheckpoints(filter) {
  const entries = await fs.readdir(root(), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const dir = path.join(root(), entry.name);
    const record = await fs.readFile(path.join(dir, 'checkpoint.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (record && filter(record)) await removeCliCache(dir);
  }
}
/** Only an exact, clean prefix may resume a stored native conversation. */
export function checkpointMatches(record, fingerprint, messages) {
  return record?.clean === true && record.fingerprint === fingerprint && Number.isSafeInteger(record.acceptedCount)
    && record.acceptedCount > 0 && record.acceptedCount < messages.length
    && cliHash(messages.slice(0, record.acceptedCount)) === record.acceptedHash
    && messages.slice(record.acceptedCount).every(row => row.role === 'user');
}
