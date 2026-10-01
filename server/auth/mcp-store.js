/** Persistent MCP capabilities. Secrets are returned once; only digests reach disk. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { sanitizeDeviceName } from './device-store.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';

const tokenPattern = /^minnow_mcp_([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/;
const storePath = () => path.join(getMinnowHome(), 'auth', 'mcp-connections.json');
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const publicRecord = ({ tokenHash, ...record }) => record;
export const mcpWorkspaceKey = workspace => normalizeWorkspacePathKey(fs.realpathSync(workspace));

function readStore() {
  let raw;
  try { raw = fs.readFileSync(storePath(), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, connections: [] }; throw error; }
  const store = JSON.parse(raw);
  if (store?.version !== 1 || !Array.isArray(store.connections) || store.connections.some(row =>
    !row || !/^[0-9a-f]{24}$/.test(row.id) || typeof row.name !== 'string' ||
    typeof row.workspace !== 'string' || !row.workspace || !['read', 'write'].includes(row.access) ||
    !/^[0-9a-f]{64}$/.test(row.tokenHash) || typeof row.createdAt !== 'string')) {
    throw new Error('Invalid MCP connection store');
  }
  return store;
}

function writeStore(store) {
  const target = storePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(target), 0o700); } catch { /* Unix permissions are unavailable on some filesystems. */ }
  const temp = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

export function listMcpConnections(workspace) {
  const key = mcpWorkspaceKey(workspace);
  return readStore().connections.filter(row => row.workspace === key).map(publicRecord);
}

/** Replacement rotates the secret atomically and retains the original scope and name. */
export function createMcpConnection({ name, workspace, access, replaceId }) {
  const store = readStore();
  const key = mcpWorkspaceKey(workspace);
  const previous = replaceId && store.connections.find(row => row.id === replaceId && row.workspace === key);
  if (replaceId && !previous) throw new TypeError('Connection not found');
  const cleanName = previous?.name ?? sanitizeDeviceName(name);
  const level = previous?.access ?? access;
  if (!cleanName || !['read', 'write'].includes(level)) throw new TypeError('Provide a connection name and read or write access');
  const id = previous?.id ?? crypto.randomBytes(12).toString('hex');
  const token = `minnow_mcp_${id}.${crypto.randomBytes(32).toString('base64url')}`;
  const record = { id, name: cleanName, workspace: key, access: level, tokenHash: hash(token), createdAt: new Date().toISOString(), lastUsedAt: null };
  store.connections = store.connections.filter(row => row.id !== id);
  store.connections.push(record);
  writeStore(store);
  return { token, connection: publicRecord(record) };
}

export function revokeMcpConnection(id, workspace) {
  const store = readStore();
  const key = mcpWorkspaceKey(workspace);
  const remaining = store.connections.filter(row => row.id !== id || row.workspace !== key);
  if (remaining.length === store.connections.length) return false;
  writeStore({ ...store, connections: remaining });
  return true;
}

/** Read on every request so revocation and replacement are immediately effective. */
export function authenticateMcpToken(token, workspace) {
  if (typeof token !== 'string' || !workspace) return null;
  const match = tokenPattern.exec(token);
  if (!match) return null;
  const store = readStore();
  const row = store.connections.find(record => record.id === match[1]);
  if (!row || row.workspace !== mcpWorkspaceKey(workspace) ||
    !crypto.timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'))) return null;
  row.lastUsedAt = new Date().toISOString();
  writeStore(store);
  return { kind: 'mcp', connectionId: row.id, workspace: row.workspace, readOnly: row.access === 'read' };
}
